import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { LoginSecrets } from "./auth0.ts";

// Decision 0009, point 1: state, nonce, PKCE verifier, return path and purpose
// stay on the server for 10 minutes and are consumed once. A random cookie
// binds them to the browser that started the sign-in.
export type SignInPurpose = "sign_in" | "link" | "confirm";
export type SignInTransaction = Readonly<{
  purpose: SignInPurpose;
  returnPath: string;
  userId: string | null;
  operationId: string | null;
  pendingLinkId: string | null;
  secrets: LoginSecrets;
}>;

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function getBindingCookieSettings(environment: string) {
  const production = environment === "production";
  return {
    name: production ? "__Host-sign-in" : "sign-in",
    // Lax, unlike the session cookie: the provider's redirect back to the
    // callback is a cross-site top-level navigation.
    options: Object.freeze({
      httpOnly: true,
      secure: production,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 10 * 60 * 1_000,
    }),
  };
}

export function createBindingValue() {
  return randomBytes(32).toString("base64url");
}

export function validBindingValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// Same-origin relative paths only (point 3). API routes are never a return
// target, so a sign-in cannot bounce into another sign-in or an action.
// The checks run on the parsed result too: parsing removes "." and ".."
// segments, so "/.//host" becomes "//host", which a browser reads as another
// site; routing ignores case, so "/API/..." is an API route; and percent-
// encoding can lengthen the path past the stored limit.
export function safeReturnPath(value: unknown, origin: string): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 2048 ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return null;
  let target: URL;
  try {
    target = new URL(value, origin);
  } catch {
    return null;
  }
  const path = target.pathname + target.search + target.hash;
  const lowerPath = target.pathname.toLowerCase();
  if (
    target.origin !== new URL(origin).origin ||
    target.username ||
    target.password ||
    path.startsWith("//") ||
    path.length > 2048 ||
    lowerPath === "/api" ||
    lowerPath.startsWith("/api/")
  )
    return null;
  return path;
}

export function createSignInState(database: Pool) {
  return Object.freeze({
    async create(input: {
      binding: string;
      purpose: SignInPurpose;
      returnPath: string;
      secrets: LoginSecrets;
      userId?: string;
      operationId?: string;
      pendingLinkId?: string;
    }) {
      await database.query(
        `WITH now AS (SELECT clock_timestamp() AS at)
         INSERT INTO auth_login_transactions(state_digest,binding_digest,nonce,code_verifier,
           purpose,return_path,user_id,operation_id,pending_link_id,created_at,expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,at,at+interval '10 minutes' FROM now`,
        [
          digest(input.secrets.state),
          digest(input.binding),
          input.secrets.nonce,
          input.secrets.codeVerifier,
          input.purpose,
          input.returnPath,
          input.userId ?? null,
          input.operationId ?? null,
          input.pendingLinkId ?? null,
        ],
      );
    },

    // One use: a replayed, expired or foreign-browser callback finds nothing.
    async consume(
      state: string,
      binding: string,
    ): Promise<SignInTransaction | null> {
      const result = await database.query<{
        purpose: SignInPurpose;
        returnPath: string;
        userId: string | null;
        operationId: string | null;
        pendingLinkId: string | null;
        nonce: string;
        codeVerifier: string;
      }>(
        `UPDATE auth_login_transactions SET consumed_at=clock_timestamp()
         WHERE state_digest=$1 AND binding_digest=$2 AND consumed_at IS NULL
           AND expires_at>clock_timestamp()
         RETURNING purpose,return_path AS "returnPath",user_id::text AS "userId",
           operation_id AS "operationId",pending_link_id AS "pendingLinkId",
           nonce,code_verifier AS "codeVerifier"`,
        [digest(state), digest(binding)],
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        purpose: row.purpose,
        returnPath: row.returnPath,
        userId: row.userId,
        operationId: row.operationId,
        pendingLinkId: row.pendingLinkId,
        secrets: Object.freeze({
          state,
          nonce: row.nonce,
          codeVerifier: row.codeVerifier,
        }),
      });
    },

    async deleteExpired() {
      const transactions = await database.query(
        "DELETE FROM auth_login_transactions WHERE expires_at<clock_timestamp()-interval '1 hour'",
      );
      const links = await database.query(
        "DELETE FROM auth_pending_links WHERE expires_at<clock_timestamp()-interval '1 hour'",
      );
      return (transactions.rowCount ?? 0) + (links.rowCount ?? 0);
    },
  });
}
