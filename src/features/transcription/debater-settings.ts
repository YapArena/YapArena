import type { Pool, PoolClient } from "pg";
import { debaterLanguages, type DebaterLanguage } from "./protocol.ts";

// Decision 0012: account-level debater settings. A debater chooses the
// language they speak (their turns' outline is written in it) and consents to
// transcription and the public AI outline. Matchmaking calls
// checkDebaterSettings at queue entry and challenge acceptance while the live
// outline is enabled; it never edits these settings itself.

// Bump when the consent wording on the account page changes: an older
// consent no longer counts, and the debater is asked again.
export const DEBATER_CONSENT_VERSION = "2026-10-25";

export interface DebaterSettings {
  language: DebaterLanguage | null;
  /** True only for consent to the current wording. */
  consented: boolean;
  consentVersion: string;
  consentedAt: Date | null;
}
export type DebaterReadiness =
  | { ready: true; language: DebaterLanguage }
  | { ready: false; missing: ("language" | "consent")[] };

export class DebaterSettingsRequiredError extends Error {
  readonly status = 409;
  readonly code = "debater_settings_required";
  constructor(readonly missing: ("language" | "consent")[]) {
    super(
      "Choose your debate language and agree to transcription and the public AI outline in your account settings.",
    );
  }
}

type Queryable = Pick<Pool | PoolClient, "query">;
interface Row {
  language: DebaterLanguage;
  consentVersion: string | null;
  consentedAt: Date | null;
}
async function read(db: Queryable, userId: string) {
  return (
    await db.query<Row>(
      `SELECT language, consent_version AS "consentVersion", consented_at AS "consentedAt"
      FROM debater_settings WHERE user_id=$1`,
      [userId],
    )
  ).rows[0];
}
function view(row: Row | undefined): DebaterSettings {
  const consented = row?.consentVersion === DEBATER_CONSENT_VERSION;
  return {
    language: row?.language ?? null,
    consented,
    consentVersion: DEBATER_CONSENT_VERSION,
    consentedAt: consented ? (row?.consentedAt ?? null) : null,
  };
}

/** Whether this account may debate with live transcription, and why not. */
export async function checkDebaterSettings(
  db: Queryable,
  userId: string,
): Promise<DebaterReadiness> {
  const settings = view(await read(db, userId));
  const missing: ("language" | "consent")[] = [];
  if (!settings.language) missing.push("language");
  if (!settings.consented) missing.push("consent");
  return settings.language && !missing.length
    ? { ready: true, language: settings.language }
    : { ready: false, missing };
}

/** As checkDebaterSettings, but throws DebaterSettingsRequiredError (409). */
export async function assertDebaterSettings(db: Queryable, userId: string) {
  const readiness = await checkDebaterSettings(db, userId);
  if (!readiness.ready)
    throw new DebaterSettingsRequiredError(readiness.missing);
  return readiness.language;
}

export function parseDebaterSettings(
  value: unknown,
): { language: DebaterLanguage; consent: boolean } | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "language" && key !== "consent")
  )
    return null;
  const { language, consent } = value as Record<string, unknown>;
  return debaterLanguages.includes(language as DebaterLanguage) &&
    typeof consent === "boolean"
    ? { language: language as DebaterLanguage, consent }
    : null;
}

export function createDebaterSettings(db: Pool) {
  return Object.freeze({
    async get(userId: string) {
      return view(await read(db, userId));
    },
    // Consenting again to the same wording keeps the original time; turning
    // consent off clears it. Recorded transcripts are kept (retention in
    // docs/data-ownership.md); future debates need consent again.
    async save(
      userId: string,
      input: { language: DebaterLanguage; consent: boolean },
    ) {
      const row = (
        await db.query<Row>(
          `INSERT INTO debater_settings(user_id, language, consent_version, consented_at)
          VALUES ($1, $2, CASE WHEN $3::boolean THEN $4 END, CASE WHEN $3::boolean THEN clock_timestamp() END)
          ON CONFLICT (user_id) DO UPDATE SET language=EXCLUDED.language,
            consent_version=EXCLUDED.consent_version,
            consented_at=CASE WHEN EXCLUDED.consent_version IS NULL THEN NULL
              WHEN debater_settings.consent_version=EXCLUDED.consent_version
                THEN debater_settings.consented_at
              ELSE EXCLUDED.consented_at END,
            updated_at=clock_timestamp()
          RETURNING language, consent_version AS "consentVersion", consented_at AS "consentedAt"`,
          [userId, input.language, input.consent, DEBATER_CONSENT_VERSION],
        )
      ).rows[0];
      return view(row);
    },
  });
}
