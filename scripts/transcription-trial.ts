// Decision 0012: the Deepgram vs ElevenLabs staging trial report
// (docs/transcription-provider-trial.md). Reads one debate's stored transcript
// segments, read-only, and scores each provider against a hand-corrected
// reference. Prints JSON: no transcript text, account or connection details.
//
//   TRANSCRIPTION_TRIAL_DATABASE_URL=... node scripts/transcription-trial.ts \
//     <debate id> <reference.json> [--deepgram-per-hour=0.29] [--elevenlabs-per-hour=0.39]
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  summarizeTrial,
  type TrialReference,
  type TrialSegment,
} from "../dist/features/transcription/trial.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
const [debateId, referencePath, ...options] = process.argv.slice(2);
if (
  !debateId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    debateId,
  ) ||
  !referencePath
)
  fail(
    "usage: node scripts/transcription-trial.ts <debate id> <reference.json> [--deepgram-per-hour=N] [--elevenlabs-per-hour=N]",
  );
const prices = { deepgram: 0.29, elevenlabs: 0.39 };
for (const option of options) {
  const match = /^--(deepgram|elevenlabs)-per-hour=(\d+(?:\.\d+)?)$/.exec(
    option,
  );
  if (!match) fail(`unknown option ${option}`);
  prices[match[1] as keyof typeof prices] = Number(match[2]);
}
const reference = JSON.parse(
  readFileSync(referencePath, "utf8"),
) as TrialReference;
if (
  !Array.isArray(reference.turns) ||
  !reference.turns.every(
    (turn) =>
      Number.isSafeInteger(turn.turnNumber) &&
      (turn.language === "fr" || turn.language === "en") &&
      typeof turn.text === "string",
  )
)
  fail("the reference needs turns: [{ turnNumber, language, text }]");
const connectionString = process.env.TRANSCRIPTION_TRIAL_DATABASE_URL;
if (!connectionString) fail("TRANSCRIPTION_TRIAL_DATABASE_URL is required");
const database = new pg.Pool({
  connectionString,
  options:
    "-c search_path=pg_catalog,yaparena,pg_temp -c default_transaction_read_only=on",
  max: 1,
});
try {
  const segments = (
    await database.query<TrialSegment>(
      `SELECT provider, role, language, turn_number AS "turnNumber",
        extract(epoch FROM spoken_start_at) * 1000 AS "spokenStartAt", text,
        latency_ms AS "latencyMs", audio_ms AS "audioMs"
      FROM transcript_segments WHERE debate_id=$1`,
      [debateId],
    )
  ).rows.map((row) => ({ ...row, spokenStartAt: Number(row.spokenStartAt) }));
  console.log(
    JSON.stringify(
      { debateId, prices, rows: summarizeTrial(segments, reference, prices) },
      null,
      2,
    ),
  );
} catch {
  // Database errors may contain connection details; never print them.
  fail("trial report failed; check the database URL and the debate id");
} finally {
  await database.end();
}
