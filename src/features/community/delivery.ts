import type { Pool, PoolClient } from "pg";
import {
  runTransaction,
  type TransactionOptions,
} from "../../platform/transaction.ts";

export const roomIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseRoomCursor(room: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error("invalid room cursor");
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    parts[1] !== room ||
    !/^(0|[1-9]\d{0,18})$/.test(parts[2]!) ||
    BigInt(parts[2]!) > 9223372036854775807n
  )
    throw new Error("invalid room cursor");
  return parts[2]!;
}
export const roomCursor = (room: string, cursor: string) =>
  `v1:${room}:${cursor}`;

export interface PublicChat {
  id: string;
  debateId: string;
  authorName: string;
  body: string | null;
  state: "visible" | "removed";
  createdAt: Date | string;
  revision: string;
  streamRevision: string;
  clientMessageId: null;
}
export interface PublicSummary {
  eventId: string;
  likes: string;
  chatState: "open" | "paused";
  chatWritable: boolean;
  eventStatus: string;
  revision: string;
}
export interface RoomRead {
  head: string;
  floor: string;
  eligible: boolean;
  summary: PublicSummary;
  items: PublicChat[];
  hasMore: boolean;
  events: {
    cursor: string;
    kind: string;
    refresh: RoomSignal | null;
    message: PublicChat | null;
    occurredAt: Date;
  }[];
}

// Reference-only room signals name the public projection a client should
// re-read. They are logged and sent as summary changes, so chat clients and
// servers that predate them keep applying the shared room cursor.
export const roomSignals = ["media", "round", "activity", "window"] as const;
export type RoomSignal = (typeof roomSignals)[number];

export function publicChange(
  kind: string,
  message: PublicChat | null,
  summary: PublicSummary,
  refresh: RoomSignal | null = null,
) {
  return refresh
    ? { type: "summary", message: null, summary, refresh }
    : { type: kind, message, summary };
}

export function publicFrame(
  room: string,
  after: string | null,
  value: RoomRead,
) {
  if (!value.eligible) return { version: 1, roomId: room, kind: "unavailable" };
  const reset =
    after === null ||
    BigInt(after) > BigInt(value.head) ||
    BigInt(after) < BigInt(value.floor) ||
    BigInt(value.head) - BigInt(after) > 1000n ||
    value.events.some((e) => e.kind === "reset");
  const cursor = reset ? value.head : (value.events.at(-1)?.cursor ?? after!);
  return {
    version: 1,
    roomId: room,
    cursor: roomCursor(room, cursor),
    kind: reset ? "snapshot" : "changes",
    snapshot: reset
      ? { summary: value.summary, items: value.items, hasMore: value.hasMore }
      : undefined,
    changes: reset
      ? undefined
      : value.events.map((e) =>
          publicChange(e.kind, e.message, value.summary, e.refresh),
        ),
    more: !reset && BigInt(cursor) < BigInt(value.head),
  };
}

// Short repeatable-read transactions bind projection, visibility and log head.
// Events store references only; removed/purged text never enters historical replay.
export function createCommunityDelivery(database: Pool) {
  let stopped = false;
  const activeClients = new Set<PoolClient>();
  function track(client: PoolClient, onError: () => void) {
    if (stopped) {
      client.release();
      throw new Error("community delivery is stopping");
    }
    // A checked-out client emits socket errors as well as rejecting its query.
    client.on("error", onError);
    activeClients.add(client);
    return setTimeout(
      () =>
        client.connection.stream.destroy(
          new Error("community delivery deadline"),
        ),
      4000,
    );
  }
  // A tracked client is discarded after any failure.
  async function trackedTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
    options: TransactionOptions,
  ) {
    const client = await database.connect();
    let failed = false;
    const onError = () => {
      failed = true;
    };
    const deadline = track(client, onError);
    try {
      return await runTransaction(client, action, {
        ...options,
        statementTimeoutMs: 3000,
        guardConnection: true,
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      clearTimeout(deadline);
      activeClients.delete(client);
      client.off("error", onError);
      client.release(failed);
    }
  }
  function transaction<T>(action: (client: PoolClient) => Promise<T>) {
    return trackedTransaction(action, {
      isolation: "repeatable read",
      readOnly: true,
    });
  }
  return {
    stop() {
      stopped = true;
      for (const client of activeClients) client.connection.stream.destroy();
    },
    async read(room: string, after: string): Promise<RoomRead> {
      return transaction(async (client) => {
        const state = await client.query<{
          head: string;
          floor: string;
          eligible: boolean;
          status: string;
          likes: string;
          chatState: "open" | "paused";
        }>(
          `SELECT COALESCE(r.cursor,0)::text AS head,
          COALESCE(r.retained_after,0)::text AS floor,
          COALESCE(d.publication_state='published' AND NOT d.is_demo
            AND t.publication_state='published',false) AS eligible,
          COALESCE(d.status,'unavailable') AS status,
          (SELECT count(*)::text FROM event_likes WHERE debate_id=$1) AS likes,
          COALESCE((SELECT state FROM event_chat_controls WHERE debate_id=$1),'open') AS "chatState"
          FROM (SELECT $1::uuid AS id) x LEFT JOIN community_rooms r ON r.room_id=x.id
          LEFT JOIN debates d ON d.id=x.id LEFT JOIN topics t ON t.id=d.topic_id`,
          [room],
        );
        const row = state.rows[0]!;
        const summary = {
          eventId: room,
          likes: row.likes,
          chatState: row.chatState,
          chatWritable:
            row.eligible && row.status === "live" && row.chatState === "open",
          eventStatus: row.status,
          revision: row.head,
        };
        if (!row.eligible)
          return {
            head: row.head,
            floor: row.floor,
            eligible: false,
            summary,
            items: [],
            hasMore: false,
            events: [],
          };
        const fields = `m.id::text AS id, m.debate_id AS "debateId",
          COALESCE(p.display_name,'Participant') AS "authorName",
          CASE WHEN m.state='visible' THEN m.body ELSE NULL END AS body,
          m.state, m.created_at AS "createdAt", m.revision::text AS revision,
          m.stream_revision::text AS "streamRevision", NULL::text AS "clientMessageId"`;
        const join = `LEFT JOIN public_profiles p ON p.user_id=m.author_user_id
          AND p.publication_state='published'`;
        const latest = await client.query<PublicChat>(
          `SELECT ${fields}
          FROM event_chat_messages m ${join} WHERE m.debate_id=$1 AND m.state='visible'
          ORDER BY m.id DESC LIMIT 11`,
          [room],
        );
        const log = await client.query<{
          cursor: string;
          kind: string;
          refresh: RoomSignal | null;
          messageId: string | null;
          messageRevision: string | null;
          occurredAt: Date;
        }>(
          `SELECT cursor::text,kind,refresh,
          message_id::text AS "messageId", message_revision::text AS "messageRevision",
          occurred_at AS "occurredAt" FROM community_room_events e
          WHERE e.room_id=$1 AND e.cursor>$2 ORDER BY e.cursor LIMIT 10`,
          [room, after],
        );
        const ids = [
          ...new Set(
            log.rows.flatMap((e) => (e.messageId ? [e.messageId] : [])),
          ),
        ];
        const messages = ids.length
          ? await client.query<PublicChat>(
              `SELECT ${fields}
          FROM event_chat_messages m ${join} WHERE m.debate_id=$1 AND m.id=ANY($2::bigint[])`,
              [room, ids],
            )
          : { rows: [] as PublicChat[] };
        const byId = new Map(messages.rows.map((m) => [m.id, m]));
        return {
          head: row.head,
          floor: row.floor,
          eligible: true,
          summary,
          items: latest.rows.slice(0, 10).reverse(),
          hasMore: latest.rows.length > 10,
          events: log.rows.map((e) => ({
            cursor: e.cursor,
            kind: e.kind,
            refresh: e.refresh,
            occurredAt: e.occurredAt,
            message: e.messageId
              ? (byId.get(e.messageId) ?? {
                  id: e.messageId,
                  debateId: room,
                  authorName: "Participant",
                  body: null,
                  state: "removed",
                  createdAt: e.occurredAt,
                  revision: e.messageRevision ?? "0",
                  streamRevision: e.cursor,
                  clientMessageId: null,
                })
              : null,
          })),
        };
      });
    },
    async prune() {
      // Delete a prefix per room and advance the recovery floor in the same transaction.
      return trackedTransaction(async (client) => {
        const rooms = await client.query<{
          room_id: string;
        }>(`SELECT DISTINCT room_id FROM
          community_room_events WHERE occurred_at<clock_timestamp()-INTERVAL '7 days'
          ORDER BY room_id LIMIT 10`);
        let remaining = 1000;
        for (const { room_id: room } of rooms.rows) {
          if (!remaining) break;
          await client.query(
            "SELECT room_id FROM community_rooms WHERE room_id=$1 FOR UPDATE",
            [room],
          );
          const removed = await client.query<{ cursor: string }>(
            `DELETE FROM community_room_events
            WHERE room_id=$1 AND cursor IN (SELECT cursor FROM community_room_events WHERE room_id=$1
              AND occurred_at<clock_timestamp()-INTERVAL '7 days' ORDER BY cursor LIMIT $2)
            RETURNING cursor::text`,
            [room, remaining],
          );
          remaining -= removed.rows.length;
          if (removed.rows.length) {
            const floor = removed.rows.reduce(
              (a, r) => (BigInt(a) > BigInt(r.cursor) ? a : r.cursor),
              "0",
            );
            await client.query(
              "UPDATE community_rooms SET retained_after=GREATEST(retained_after,$2) WHERE room_id=$1",
              [room, floor],
            );
          }
        }
        await client.query(`DELETE FROM community_rooms WHERE room_id IN (
          SELECT r.room_id FROM community_rooms r WHERE NOT EXISTS (SELECT 1 FROM debates d WHERE d.id=r.room_id)
            AND NOT EXISTS (SELECT 1 FROM community_room_events e WHERE e.room_id=r.room_id)
          ORDER BY r.room_id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
        return 1000 - remaining;
      }, {});
    },
  };
}
