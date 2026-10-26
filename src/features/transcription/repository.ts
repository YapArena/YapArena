import type { Pool, PoolClient } from "pg";
import {
  databaseFailure,
  withTransaction,
} from "../../platform/transaction.ts";
import { DEBATER_CONSENT_VERSION } from "./debater-settings.ts";
import type { DebaterLanguage, Side, TranscriptUpdate } from "./protocol.ts";

// Decision 0012: the server is the authority for transcripts. One update is
// one transaction: it checks the debate is live and the turn current, maps
// each segment to the turn's trading window by spoken time, and appends the
// segments with an idempotency receipt. No outbound calls happen here.

/** A flush for a turn that just ended is accepted this long after it. */
export const TURN_FLUSH_GRACE_MS = 15_000;
/** Below this, agent clock difference is network latency, not drift. */
export const CLOCK_DRIFT_TOLERANCE_MS = 1_000;

export type IngestResult =
  | {
      status: 200;
      body: {
        accepted: true;
        sequence: number;
        turnNumber: number;
        stored: number;
        inWindow: number;
      };
    }
  | { status: 403 | 404 | 409 | 422; body: Record<string, unknown> };

interface LiveState {
  status: string;
  liveEndedAt: Date | null;
  mediaState: string | null;
  turnNumber: number | null;
  activeSide: Side | null;
  lastResumedAt: Date | null;
  now: Date;
}
const other = (side: Side): Side => (side === "A" ? "B" : "A");

// Which turn may still send speech: the current one, the one that ended in
// the last few seconds (its final flush), or the last turn just after the end.
function acceptsTurn(state: LiveState, turn: number) {
  const now = state.now.getTime();
  if (state.turnNumber === null) return false;
  if (state.status === "live" && state.mediaState !== "ended")
    return (
      turn === state.turnNumber ||
      (turn === state.turnNumber - 1 &&
        state.lastResumedAt !== null &&
        now - state.lastResumedAt.getTime() <= TURN_FLUSH_GRACE_MS)
    );
  return (
    turn === state.turnNumber &&
    state.liveEndedAt !== null &&
    now - state.liveEndedAt.getTime() <= TURN_FLUSH_GRACE_MS
  );
}

export function createTranscriptionRepository(database: Pool) {
  async function liveState(client: PoolClient, debateId: string) {
    return (
      await client.query<LiveState>(
        `SELECT d.status, d.live_ended_at AS "liveEndedAt", m.state AS "mediaState",
          m.turn_number AS "turnNumber", m.active_side AS "activeSide",
          m.last_resumed_at AS "lastResumedAt", clock_timestamp() AS now
        FROM debates d LEFT JOIN debate_media m ON m.debate_id=d.id WHERE d.id=$1`,
        [debateId],
      )
    ).rows[0];
  }
  async function receipt(debateId: string, jobId: string, sequence: number) {
    return (
      await database.query<{ response: IngestResult["body"] }>(
        "SELECT response FROM transcription_updates WHERE debate_id=$1 AND job_id=$2 AND sequence=$3",
        [debateId, jobId, sequence],
      )
    ).rows[0]?.response;
  }

  async function ingestOnce(
    debateId: string,
    update: TranscriptUpdate,
  ): Promise<IngestResult> {
    return withTransaction(database, async (client) => {
      const previous = (
        await client.query<{ response: IngestResult["body"] }>(
          "SELECT response FROM transcription_updates WHERE debate_id=$1 AND job_id=$2 AND sequence=$3",
          [debateId, update.jobId, update.sequence],
        )
      ).rows[0];
      if (previous)
        return { status: 200, body: previous.response } as IngestResult;
      const state = await liveState(client, debateId);
      if (!state) return { status: 404, body: { error: "debate not found" } };
      if (!acceptsTurn(state, update.turnNumber))
        return {
          status: 409,
          body: {
            error: "stale turn",
            code: "stale_turn",
            debateStatus: state.status,
            turnNumber: state.turnNumber,
          },
        };
      const window = (
        await client.query<{
          id: string;
          closesAt: Date;
          side: Side;
        }>(
          `SELECT id, closes_at AS "closesAt", turn_side AS side FROM coin_debate_rounds
          WHERE debate_id=$1 AND turn_number=$2`,
          [debateId, update.turnNumber],
        )
      ).rows[0];
      // The speaking side is the server's: the window records it; otherwise
      // the media clock's current side, alternating back for the turn before.
      const side: Side =
        window?.side ??
        (state.activeSide
          ? update.turnNumber === state.turnNumber
            ? state.activeSide
            : other(state.activeSide)
          : update.turnNumber % 2 === 1
            ? "A"
            : "B");
      if (update.segments.some((segment) => segment.side !== side))
        return {
          status: 422,
          body: {
            error: "segment side does not match the turn",
            code: "wrong_side",
            side,
          },
        };
      const speaker = (
        await client.query<{
          userId: string;
          consentVersion: string | null;
          language: DebaterLanguage | null;
        }>(
          `SELECT p.user_id AS "userId", s.consent_version AS "consentVersion",
            s.language FROM event_participants p
          LEFT JOIN debater_settings s ON s.user_id=p.user_id
          WHERE p.debate_id=$1 AND p.side=$2`,
          [debateId, side],
        )
      ).rows[0];
      if (!speaker)
        return { status: 404, body: { error: "speaker not found" } };
      if (speaker.consentVersion !== DEBATER_CONSENT_VERSION)
        return {
          status: 403,
          body: {
            error: "the speaker has not consented to transcription",
            code: "consent_required",
            side,
          },
        };
      // Spoken times are on the agent's clock. Within the tolerance the
      // difference is latency; beyond it the agent's clock has drifted and its
      // times move by the difference. Speech never ends after receipt.
      const now = state.now.getTime(),
        drift = now - update.sentAt,
        shift = Math.abs(drift) > CLOCK_DRIFT_TOLERANCE_MS ? drift : 0;
      const rows = update.segments.map((segment, index) => {
        const end = Math.min(segment.endAt + shift, now),
          start = Math.min(segment.startAt + shift, end);
        return {
          index,
          segment,
          start,
          end,
          windowId:
            window && end <= window.closesAt.getTime() ? window.id : null,
        };
      });
      const body = {
        accepted: true as const,
        sequence: update.sequence,
        turnNumber: update.turnNumber,
        stored: rows.length,
        inWindow: rows.filter((row) => row.windowId).length,
      };
      await client.query(
        `INSERT INTO transcription_updates(debate_id, job_id, sequence, turn_number, response)
        VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          debateId,
          update.jobId,
          update.sequence,
          update.turnNumber,
          JSON.stringify(body),
        ],
      );
      if (rows.length)
        await client.query(
          `INSERT INTO transcript_segments(debate_id, turn_number, window_id, side,
            speaker_user_id, language, provider, role, job_id, sequence, segment_index,
            spoken_start_at, spoken_end_at, text, words, latency_ms, audio_ms)
          SELECT $1, $2, x.window_id, $3, $4, x.language, x.provider, x.role, $5, $6,
            x.segment_index, to_timestamp(x.start_ms / 1000.0), to_timestamp(x.end_ms / 1000.0),
            x.text, x.words, x.latency_ms, x.audio_ms
          FROM jsonb_to_recordset($7::jsonb) AS x(window_id uuid, language text,
            provider text, role text, segment_index smallint, start_ms bigint, end_ms bigint,
            text text, words jsonb, latency_ms integer, audio_ms integer)`,
          [
            debateId,
            update.turnNumber,
            side,
            speaker.userId,
            update.jobId,
            update.sequence,
            JSON.stringify(
              rows.map((row) => ({
                window_id: row.windowId,
                language: row.segment.language,
                provider: row.segment.provider,
                role: row.segment.role,
                segment_index: row.index,
                start_ms: row.start,
                end_ms: row.end,
                text: row.segment.text,
                words: row.segment.words,
                latency_ms: row.segment.latencyMs,
                audio_ms: row.segment.audioMs,
              })),
            ),
          ],
        );
      return { status: 200, body };
    });
  }

  return Object.freeze({
    /** Idempotent by (debate, job, sequence); a retry returns its receipt. */
    async ingest(debateId: string, update: TranscriptUpdate) {
      try {
        return await ingestOnce(debateId, update);
      } catch (error) {
        if (databaseFailure(error) !== "unique_violation") throw error;
        const response = await receipt(debateId, update.jobId, update.sequence);
        if (!response) throw error;
        return { status: 200, body: response } as IngestResult;
      }
    },
    /** What a (re)starting agent job needs to resume. */
    async session(debateId: string, jobId: string) {
      const row = (
        await database.query<{
          debateStatus: string;
          media: {
            state: string;
            turnNumber: number;
            activeSide: Side | null;
            turnDeadlineAt: string | null;
          } | null;
          serverNow: Date;
          nextSequence: number;
        }>(
          `SELECT d.status AS "debateStatus", clock_timestamp() AS "serverNow",
            CASE WHEN m.debate_id IS NULL THEN NULL ELSE json_build_object('state',m.state,
              'turnNumber',m.turn_number,'activeSide',m.active_side,
              'turnDeadlineAt',m.turn_deadline_at) END AS media,
            COALESCE((SELECT max(sequence)+1 FROM transcription_updates u
              WHERE u.debate_id=d.id AND u.job_id=$2), 0)::integer AS "nextSequence"
          FROM debates d LEFT JOIN debate_media m ON m.debate_id=d.id WHERE d.id=$1`,
          [debateId, jobId],
        )
      ).rows[0];
      if (!row) return null;
      const speakers = (
        await database.query<{
          side: Side;
          language: DebaterLanguage | null;
          consented: boolean;
        }>(
          `SELECT p.side, s.language, COALESCE(s.consent_version=$2, false) AS consented
          FROM event_participants p LEFT JOIN debater_settings s ON s.user_id=p.user_id
          WHERE p.debate_id=$1 ORDER BY p.side`,
          [debateId, DEBATER_CONSENT_VERSION],
        )
      ).rows;
      return { debateId, ...row, speakers };
    },
    /**
     * Claims one dispatch attempt. A new debate, a failed attempt after its
     * backoff (five at most) or an attempt stuck for a minute can be claimed;
     * a dispatched debate never again. Returns the attempt number, or null.
     */
    async claimDispatch(debateId: string) {
      return (
        (
          await database.query<{ attempts: number }>(
            `INSERT INTO transcription_dispatches(debate_id, state, attempts) VALUES ($1, 'pending', 1)
            ON CONFLICT (debate_id) DO UPDATE SET state='pending',
              attempts=transcription_dispatches.attempts+1, updated_at=clock_timestamp()
            WHERE transcription_dispatches.attempts < 5 AND (
              (transcription_dispatches.state='failed' AND transcription_dispatches.updated_at <
                clock_timestamp()-make_interval(secs => 5 * 2 ^ transcription_dispatches.attempts))
              OR (transcription_dispatches.state='pending' AND transcription_dispatches.updated_at <
                clock_timestamp()-INTERVAL '60 seconds'))
            RETURNING attempts`,
            [debateId],
          )
        ).rows[0]?.attempts ?? null
      );
    },
    async dispatchSettled(debateId: string, dispatchId: string | null) {
      await database.query(
        `UPDATE transcription_dispatches SET state=CASE WHEN $2::text IS NULL THEN 'failed' ELSE 'dispatched' END,
          dispatch_id=$2, updated_at=clock_timestamp() WHERE debate_id=$1 AND state='pending'`,
        [debateId, dispatchId],
      );
    },
    /**
     * Debates to warm a transcriber for: ready or live, not a demo, with a
     * consenting speaker and no successful dispatch yet.
     */
    async dispatchCandidates(limit = 10) {
      return (
        await database.query<{ id: string }>(
          `SELECT d.id FROM debates d
          WHERE d.status IN ('ready','live') AND NOT d.is_demo
            AND NOT EXISTS (SELECT 1 FROM transcription_dispatches x WHERE x.debate_id=d.id
              AND (x.state='dispatched' OR x.attempts>=5))
            AND EXISTS (SELECT 1 FROM event_participants p JOIN debater_settings s
              ON s.user_id=p.user_id WHERE p.debate_id=d.id AND s.consent_version=$2)
          ORDER BY d.id LIMIT $1`,
          [limit, DEBATER_CONSENT_VERSION],
        )
      ).rows.map((row) => row.id);
    },
    /** Hourly retention: receipts after 7 days, shadow segments after 90. */
    async pruneExpired() {
      const receipts = await database.query(
        `DELETE FROM transcription_updates WHERE ctid IN (SELECT ctid FROM transcription_updates
          WHERE accepted_at < clock_timestamp()-INTERVAL '7 days' LIMIT 1000)`,
      );
      const shadow = await database.query(
        `DELETE FROM transcript_segments WHERE id IN (SELECT id FROM transcript_segments
          WHERE role='shadow' AND created_at < clock_timestamp()-INTERVAL '90 days' LIMIT 1000)`,
      );
      return { receipts: receipts.rowCount ?? 0, shadow: shadow.rowCount ?? 0 };
    },
  });
}
