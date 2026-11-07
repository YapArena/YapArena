import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { withTransaction } from "../../platform/transaction.ts";
import type {
  PushOutcome,
  PushSubscriptionRecord,
  WebPush,
} from "../../platform/web-push.ts";
import { REMINDER_MINUTES } from "./timings.ts";

// Web push for "Notify me" (first-run build plan PR 10). A viewer who allows notifications when
// tapping "Notify me" saves this browser's push subscription. When the worker's reminder step
// gives each requester the in-app notice, it also queues one delivery per subscription in the
// same transaction; the delivery job below sends them, outside any queue lock.

/** An account keeps its most recently saved subscriptions, one per browser, up to this many. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;
/** A delivery is useless once its debate has started: it expires after this long. */
export const PUSH_DELIVERY_MINUTES = REMINDER_MINUTES * 2;
/** Tries per delivery when the push service has no answer or a temporary failure. */
export const PUSH_DELIVERY_ATTEMPTS = 3;
/** Deliveries sent at once by one job pass. */
const PUSH_BATCH = 20;
/** A claimed delivery is retried after this long if its pass never finished. */
const PUSH_CLAIM_SECONDS = 30;
// The longest debate title a push message carries; the notification shows a line or two.
const PUSH_TITLE_LENGTH = 120;

export function createPushSubscriptions(database: Pool) {
  return Object.freeze({
    // One row per push address. A browser that another account used before moves to this one,
    // with no deliveries left from the other account; the oldest beyond the limit are removed.
    async save(
      userId: string,
      subscription: PushSubscriptionRecord,
    ): Promise<"created" | "updated"> {
      return withTransaction(database, async (client) => {
        await client.query(
          "DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND user_id <> $2",
          [subscription.endpoint, userId],
        );
        const saved = await client.query<{ created: boolean }>(
          `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id,
             p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             updated_at = CURRENT_TIMESTAMP
           RETURNING (xmax = 0) AS created`,
          [
            userId,
            subscription.endpoint,
            subscription.p256dh,
            subscription.auth,
          ],
        );
        await client.query(
          `DELETE FROM web_push_subscriptions WHERE user_id = $1 AND id NOT IN (
             SELECT id FROM web_push_subscriptions WHERE user_id = $1
             ORDER BY updated_at DESC, id DESC LIMIT ${MAX_PUSH_SUBSCRIPTIONS})`,
          [userId],
        );
        return saved.rows[0]?.created ? "created" : "updated";
      });
    },
    async remove(userId: string, endpoint: string) {
      await database.query(
        "DELETE FROM web_push_subscriptions WHERE user_id = $1 AND endpoint = $2",
        [userId, endpoint],
      );
    },
  });
}

export type PushSubscriptions = ReturnType<typeof createPushSubscriptions>;

// Called by the reminder step, in its transaction, with the accounts it just notified.
export async function queuePushDeliveries(
  client: PoolClient,
  debateId: string,
  userIds: readonly string[],
) {
  if (!userIds.length) return;
  await client.query(
    `INSERT INTO web_push_deliveries (subscription_id, debate_id)
     SELECT s.id, $1 FROM web_push_subscriptions s WHERE s.user_id = ANY($2::bigint[])
     ON CONFLICT DO NOTHING`,
    [debateId, userIds],
  );
}

// Deliveries that can no longer be sent: past their minutes, or out of tries. The hourly
// matchmaking cleanup runs this whether or not push is configured.
export async function pruneExpiredPushDeliveries(
  database: Pick<Pool, "query">,
) {
  const result = await database.query(
    `DELETE FROM web_push_deliveries
     WHERE created_at <= CURRENT_TIMESTAMP - make_interval(mins => ${PUSH_DELIVERY_MINUTES})
       OR (attempts >= ${PUSH_DELIVERY_ATTEMPTS}
         AND (claimed_until IS NULL OR claimed_until <= CURRENT_TIMESTAMP))`,
  );
  return result.rowCount ?? 0;
}

// The message a browser receives: the debate's public title and page, nothing about the
// account. frontend/sw.ts shows it as "Starts in a few minutes".
export function pushMessage(debate: { proposition: string; slug: string }) {
  const title =
    debate.proposition.length > PUSH_TITLE_LENGTH
      ? `${debate.proposition.slice(0, PUSH_TITLE_LENGTH - 1).trimEnd()}…`
      : debate.proposition;
  return { title, url: `/debates/${encodeURIComponent(debate.slug)}` };
}

interface DueDelivery extends PushSubscriptionRecord {
  subscriptionId: string;
  debateId: string;
  proposition: string;
  slug: string;
  // Still public and not over: a debate called off in the meantime sends nothing.
  current: boolean;
}

export function createPushDelivery({
  database,
  push,
  logger,
}: {
  database: Pool;
  push: Pick<WebPush, "send">;
  logger: Pick<Logger, "info" | "warn">;
}) {
  // Claims due deliveries for a short lease, so a pass that never finishes is retried and two
  // workers never send the same one.
  async function claim() {
    const result = await database.query<DueDelivery>(
      `WITH due AS (
         SELECT subscription_id, debate_id FROM web_push_deliveries
         WHERE (claimed_until IS NULL OR claimed_until <= CURRENT_TIMESTAMP)
           AND attempts < ${PUSH_DELIVERY_ATTEMPTS}
           AND created_at > CURRENT_TIMESTAMP - make_interval(mins => ${PUSH_DELIVERY_MINUTES})
         ORDER BY created_at LIMIT ${PUSH_BATCH}
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE web_push_deliveries w SET attempts = w.attempts + 1,
           claimed_until = CURRENT_TIMESTAMP + make_interval(secs => ${PUSH_CLAIM_SECONDS})
         FROM due WHERE w.subscription_id = due.subscription_id AND w.debate_id = due.debate_id
         RETURNING w.subscription_id, w.debate_id
       )
       SELECT c.subscription_id::text AS "subscriptionId", c.debate_id AS "debateId",
         s.endpoint, s.p256dh, s.auth, d.proposition, d.slug,
         (d.publication_state = 'published' AND t.publication_state = 'published'
           AND d.status IN ('scheduled', 'ready', 'live')) AS current
       FROM claimed c
       JOIN web_push_subscriptions s ON s.id = c.subscription_id
       JOIN debates d ON d.id = c.debate_id
       JOIN topics t ON t.id = d.topic_id`,
    );
    return result.rows;
  }

  return Object.freeze({
    // One pass: send what is due, at once. Sent and refused deliveries are deleted, a gone
    // subscription is deleted with its deliveries, and the rest wait for their lease to end.
    async flush() {
      const due = await claim();
      const counts: Record<PushOutcome | "skipped", number> = {
        sent: 0,
        gone: 0,
        refused: 0,
        retry: 0,
        skipped: 0,
      };
      if (!due.length) return counts;
      const results = await Promise.all(
        due.map(async (delivery) => {
          if (!delivery.current)
            return { delivery, outcome: "skipped" as const };
          try {
            const { outcome, status } = await push.send(
              delivery,
              pushMessage(delivery),
              PUSH_DELIVERY_MINUTES * 60,
            );
            // The address itself stays out of the logs: it lets anyone holding it reach the
            // browser's push service.
            if (outcome === "refused" || outcome === "retry")
              logger.warn(
                {
                  outcome,
                  status,
                  pushService: new URL(delivery.endpoint).hostname,
                },
                "web push not delivered",
              );
            return { delivery, outcome };
          } catch {
            // A message that can't be built for this browser never will be.
            logger.warn(
              {
                outcome: "refused",
                pushService: new URL(delivery.endpoint).hostname,
              },
              "web push not delivered",
            );
            return { delivery, outcome: "refused" as const };
          }
        }),
      );
      const finished = results.filter(
        ({ outcome }) => outcome !== "retry" && outcome !== "gone",
      );
      if (finished.length)
        await database.query(
          `DELETE FROM web_push_deliveries w
           USING unnest($1::bigint[], $2::uuid[]) AS f(subscription_id, debate_id)
           WHERE w.subscription_id = f.subscription_id AND w.debate_id = f.debate_id`,
          [
            finished.map(({ delivery }) => delivery.subscriptionId),
            finished.map(({ delivery }) => delivery.debateId),
          ],
        );
      const gone = results.filter(({ outcome }) => outcome === "gone");
      if (gone.length)
        await database.query(
          "DELETE FROM web_push_subscriptions WHERE id = ANY($1::bigint[])",
          [gone.map(({ delivery }) => delivery.subscriptionId)],
        );
      for (const { outcome } of results) counts[outcome] += 1;
      logger.info({ ...counts }, "web push deliveries sent");
      return counts;
    },
  });
}
