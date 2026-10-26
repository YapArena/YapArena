import type { Pool } from "pg";
import type { Logger } from "pino";
import { runExclusiveDatabaseJob } from "../../platform/database-jobs.ts";
import { MatchConflictError } from "../matching/repository.ts";
import type { createDebateStart } from "./debate-start.ts";
import { MediaConflictError } from "./repository.ts";

const REASON = "Automatic start: both speakers are ready and connected.";
const STARTS_PER_SWEEP = 20;

// Starts a ready debate without an operator once its start time has come and both speakers are
// connected (Decision 0011). The ready route tries as soon as the second speaker is ready; the
// jobs worker retries every second until the join window closes. A per-debate lock keeps the two
// from starting the same debate twice.
export function createDebateAutoStart({
  database,
  startDebate,
  logger,
}: {
  database: Pool;
  startDebate: ReturnType<typeof createDebateStart>;
  logger: Pick<Logger, "error">;
}) {
  async function tryStart(debateId: string) {
    const result = await runExclusiveDatabaseJob(
      database,
      `auto-start:${debateId}`,
      async (client) => {
        const due = await client.query(
          `SELECT 1 FROM debates WHERE id = $1 AND status = 'ready'
             AND scheduled_at <= CURRENT_TIMESTAMP`,
          [debateId],
        );
        if (!due.rows[0]) return false;
        try {
          await startDebate({
            debateId,
            actorUserId: null,
            reason: REASON,
            logger,
          });
          return true;
        } catch (error) {
          // Not yet: a speaker is still connecting, or another path started it first.
          if (
            error instanceof MediaConflictError ||
            error instanceof MatchConflictError
          )
            return false;
          throw error;
        }
      },
    );
    return result.acquired && result.value;
  }

  return Object.freeze({
    tryStart,
    async sweep() {
      const due = await database.query<{ id: string }>(
        `SELECT id FROM debates WHERE status = 'ready' AND NOT is_demo
           AND scheduled_at <= CURRENT_TIMESTAMP
         ORDER BY scheduled_at LIMIT ${STARTS_PER_SWEEP}`,
      );
      let started = 0;
      for (const { id } of due.rows) {
        try {
          if (await tryStart(id)) started += 1;
        } catch (error) {
          logger.error(
            { error, debateId: id },
            "automatic debate start failed",
          );
        }
      }
      return started;
    },
  });
}
