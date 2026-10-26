import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { containsBlockedTerm } from "./moderation.ts";
import { resolveCleanup } from "./cleanup.ts";
import { CLEANUP_ACCEPT_MS } from "../transcription/protocol.ts";
import {
  emptyTurn,
  isTurnOutline,
  outlineBytes,
  resolveEdits,
  type OutlineEdit,
  type OutlineLanguage,
  type OutlineSide,
  type TurnOutline,
} from "./reducer.ts";
import type {
  OutlineAnswer,
  OutlineCleanup,
  OutlineProposal,
} from "../transcription/protocol.ts";
import type {
  OutlineCatchUp,
  OutlineCorrelation,
  OutlineSnapshot,
  OutlineTimeline,
  TurnSummary,
} from "./public-types.ts";
export type {
  ArgumentSummary,
  OutlineCatchUp,
  OutlineCorrelation,
  OutlineSnapshot,
  OutlineTimeline,
  TurnSummary,
} from "./public-types.ts";

// Decision 0012: the server is the outline's authority. A proposal is
// resolved against the stored outline inside the transcript ingest
// transaction, under the debate's head row lock; the resolved edits become
// the next live version. Windows freeze at their cutoff on the jobs loop.

export const SNAPSHOT_MAX_BYTES = 8192;
/** Catch-up answers carry at most this many versions; beyond it, a snapshot. */
export const CATCH_UP_MAX = 50;
/** The replay timeline carries at most this many versions. */
export const TIMELINE_MAX_VERSIONS = 5000;
/** Correlation reports nothing for a window with fewer commitments. */
export const CORRELATION_MINIMUM = 5;

type Queryable = Pick<Pool | PoolClient, "query">;
const summary = (outline: TurnOutline, final: boolean): TurnSummary => ({
  turnNumber: outline.turnNumber,
  side: outline.side,
  language: outline.language,
  arguments: outline.arguments.map(({ id, label, rebuts, continues }) => ({
    id,
    label,
    rebuts,
    continues: continues ?? null,
  })),
  final,
});

/** The latest stored outline of every turn of a debate, final ones first. */
async function turns(db: Queryable, debateId: string) {
  const rows = (
    await db.query<{
      turnNumber: number;
      live: unknown;
      settled: unknown;
      final: boolean;
    }>(
      `SELECT v.turn_number AS "turnNumber", v.outline AS live,
        COALESCE(w.final_outline, w.frozen_outline) AS settled,
        w.final_outline IS NOT NULL AS final
      FROM (SELECT DISTINCT ON (turn_number) turn_number, outline FROM outline_versions
        WHERE debate_id=$1 ORDER BY turn_number, version DESC) v
      LEFT JOIN outline_windows w ON w.debate_id=$1 AND w.turn_number=v.turn_number
      ORDER BY v.turn_number DESC LIMIT 100`,
      [debateId],
    )
  ).rows;
  return rows
    .map((row) => ({
      turnNumber: row.turnNumber,
      live: isTurnOutline(row.live) ? row.live : null,
      settled: isTurnOutline(row.settled) ? row.settled : null,
      final: row.final,
    }))
    .reverse();
}

/**
 * Inside the ingest transaction: resolves the proposal against the turn's
 * stored outline and, if anything applies, stores the next live version.
 * A stale base version or a proposal with no applicable edit stores nothing.
 */
export async function applyProposal(
  client: PoolClient,
  input: {
    debateId: string;
    turnNumber: number;
    side: OutlineSide;
    language: OutlineLanguage;
    window: { id: string; closesAt: Date } | undefined;
    proposal: OutlineProposal;
  },
): Promise<OutlineAnswer> {
  await client.query(
    "INSERT INTO outline_heads(debate_id) VALUES ($1) ON CONFLICT (debate_id) DO NOTHING",
    [input.debateId],
  );
  const head = (
    await client.query<{ version: number; now: Date }>(
      "SELECT version, clock_timestamp() AS now FROM outline_heads WHERE debate_id=$1 FOR UPDATE",
      [input.debateId],
    )
  ).rows[0]!;
  const all = await turns(client, input.debateId);
  const stored = all.find((turn) => turn.turnNumber === input.turnNumber)?.live;
  const current =
    stored ?? emptyTurn(input.turnNumber, input.side, input.language);
  if (input.proposal.baseVersion !== head.version)
    return {
      accepted: false,
      reason: "stale",
      version: head.version,
      turn: stored ?? null,
    };
  const known = new Set(
    all
      .filter((turn) => turn.turnNumber < input.turnNumber)
      .flatMap(
        (turn) =>
          (turn.settled ?? turn.live)?.arguments.map((item) => item.id) ?? [],
      ),
  );
  const resolved = resolveEdits(current, input.proposal.edits, {
    span: input.proposal.span,
    known,
    accept: (text) => !containsBlockedTerm(text),
  });
  if (
    !resolved.edits.length ||
    outlineBytes(resolved.outline) > SNAPSHOT_MAX_BYTES
  )
    return {
      accepted: false,
      reason: "unchanged",
      version: head.version,
      turn: stored ?? null,
    };
  const version = head.version + 1;
  await client.query(
    `INSERT INTO outline_versions(debate_id, version, turn_number, window_id, in_window,
      outline, edits, model, span_start_ms, span_end_ms)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.debateId,
      version,
      input.turnNumber,
      input.window?.id ?? null,
      Boolean(
        input.window && head.now.getTime() <= input.window.closesAt.getTime(),
      ),
      JSON.stringify(resolved.outline),
      JSON.stringify(resolved.edits),
      input.proposal.model,
      input.proposal.span.startMs,
      input.proposal.span.endMs,
    ],
  );
  await client.query(
    "UPDATE outline_heads SET version=$2, updated_at=clock_timestamp() WHERE debate_id=$1",
    [input.debateId, version],
  );
  return {
    accepted: true,
    version,
    turnNumber: input.turnNumber,
    side: current.side,
    language: current.language,
    edits: resolved.edits,
    rejected: resolved.rejected,
  };
}

export function createOutlineRepository(database: Pool) {
  return Object.freeze({
    /** Whether the debate and its topic are published. */
    async isPublic(debateId: string) {
      return Boolean(
        (
          await database.query(
            `SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id
            WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
            [debateId],
          )
        ).rowCount,
      );
    },
    /** The agent's resume state: head version, the turn, the debate map. */
    async agentState(debateId: string, turnNumber: number | null) {
      const head =
        (
          await database.query<{ version: number }>(
            "SELECT version FROM outline_heads WHERE debate_id=$1",
            [debateId],
          )
        ).rows[0]?.version ?? 0;
      const all = await turns(database, debateId);
      return {
        version: head,
        turn:
          turnNumber === null
            ? null
            : (all.find((turn) => turn.turnNumber === turnNumber)?.live ??
              null),
        map: all.flatMap((turn) =>
          (turn.settled ?? turn.live)!.arguments.map((item) => ({
            id: item.id,
            turnNumber: turn.turnNumber,
            side: (turn.settled ?? turn.live)!.side,
            label: item.label,
          })),
        ),
      };
    },
    /** The page's initial state and the catch-up fallback. */
    async snapshot(debateId: string): Promise<OutlineSnapshot> {
      const version =
        (
          await database.query<{ version: number }>(
            "SELECT version FROM outline_heads WHERE debate_id=$1",
            [debateId],
          )
        ).rows[0]?.version ?? 0;
      const all = await turns(database, debateId);
      const latest = all.at(-1);
      const flags = (
        await database.query<{
          turnNumber: number;
          itemId: string;
          side: OutlineSide;
        }>(
          `SELECT DISTINCT turn_number AS "turnNumber", item_id AS "itemId", side
          FROM outline_flags WHERE debate_id=$1 ORDER BY 1, 2 LIMIT 200`,
          [debateId],
        )
      ).rows;
      const finals =
        (
          await database.query<{ finals: number }>(
            "SELECT count(*)::int AS finals FROM outline_windows WHERE debate_id=$1 AND finalized_at IS NOT NULL",
            [debateId],
          )
        ).rows[0]?.finals ?? 0;
      return {
        kind: "snapshot",
        debateId,
        version,
        finals,
        current: latest?.live ?? null,
        turns: all
          .slice(0, -1)
          .flatMap((turn) =>
            turn.settled || turn.live
              ? [summary((turn.settled ?? turn.live)!, turn.final)]
              : [],
          ),
        flags,
      };
    },
    /** Versions after `after`, or a snapshot when too far behind. */
    async since(
      debateId: string,
      after: number,
    ): Promise<OutlineCatchUp | OutlineSnapshot> {
      const head = (
        await database.query<{ version: number }>(
          "SELECT version FROM outline_heads WHERE debate_id=$1",
          [debateId],
        )
      ).rows[0]?.version;
      if (head === undefined || after > head || head - after > CATCH_UP_MAX)
        return this.snapshot(debateId);
      const rows = (
        await database.query<{
          version: number;
          turnNumber: number;
          outline: TurnOutline;
          edits: OutlineEdit[];
        }>(
          `SELECT version, turn_number AS "turnNumber", outline, edits FROM outline_versions
          WHERE debate_id=$1 AND version>$2 AND version<=$3 ORDER BY version`,
          [debateId, after, head],
        )
      ).rows;
      return {
        kind: "edits",
        debateId,
        from: after,
        version: head,
        versions: rows.map((row) => ({
          version: row.version,
          turnNumber: row.turnNumber,
          side: row.outline.side,
          language: row.outline.language,
          edits: row.edits,
        })),
      };
    },
    /**
     * Jobs loop: records, for each window past its cutoff, the outline
     * version traders saw then (the latest version created before the cutoff,
     * or an empty outline). Each window is frozen once.
     */
    async freezeDue(limit = 20) {
      const due = (
        await database.query<{
          windowId: string;
          debateId: string;
          turnNumber: number;
          closesAt: Date;
        }>(
          `SELECT r.id AS "windowId", r.debate_id AS "debateId", r.turn_number AS "turnNumber",
            r.closes_at AS "closesAt" FROM coin_debate_rounds r
          WHERE r.turn_number IS NOT NULL AND r.closes_at <= clock_timestamp()
            AND r.closes_at > clock_timestamp() - INTERVAL '1 day'
            AND NOT EXISTS (SELECT 1 FROM outline_windows w WHERE w.window_id=r.id)
            AND EXISTS (SELECT 1 FROM outline_versions v
              WHERE v.debate_id=r.debate_id AND v.turn_number=r.turn_number)
          ORDER BY r.closes_at, r.id LIMIT $1`,
          [limit],
        )
      ).rows;
      let frozen = 0;
      for (const window of due) {
        const inserted = await withTransaction(database, async (client) => {
          const versions = (
            await client.query<{
              version: number;
              outline: TurnOutline;
              before: boolean;
            }>(
              `SELECT version, outline, created_at <= $3 AS before FROM outline_versions
              WHERE debate_id=$1 AND turn_number=$2 ORDER BY version DESC`,
              [window.debateId, window.turnNumber, window.closesAt],
            )
          ).rows;
          const seen = versions.find((row) => row.before);
          const shape = versions[0]!.outline;
          const outline =
            seen?.outline ??
            emptyTurn(window.turnNumber, shape.side, shape.language);
          return (
            await client.query(
              `INSERT INTO outline_windows(debate_id, turn_number, window_id, frozen_version, frozen_outline)
              VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
              [
                window.debateId,
                window.turnNumber,
                window.windowId,
                seen?.version ?? null,
                JSON.stringify(outline),
              ],
            )
          ).rowCount;
        });
        if (inserted) frozen++;
      }
      return { frozen };
    },
    /**
     * The window cleanup (Claude Sonnet 5.5): at most one per window, until
     * CLEANUP_ACCEPT_MS after it froze. Its rewrite becomes the window's
     * final outline; otherwise finalizeDue makes the frozen one final.
     */
    async applyCleanup(debateId: string, cleanup: OutlineCleanup) {
      return withTransaction(database, async (client) => {
        const window = (
          await client.query<{ final: boolean; open: boolean }>(
            `SELECT finalized_at IS NOT NULL AS final,
              clock_timestamp() <= frozen_at + $3 * INTERVAL '1 millisecond' AS open
            FROM outline_windows WHERE debate_id=$1 AND turn_number=$2 FOR UPDATE`,
            [debateId, cleanup.turnNumber, CLEANUP_ACCEPT_MS],
          )
        ).rows[0];
        const refuse = (status: number, reason: string) => ({
          status,
          body: { accepted: false as const, reason },
        });
        // Not frozen yet: the jobs loop freezes within a second; retry.
        if (!window) return refuse(409, "not_frozen");
        if (window.final) return refuse(409, "final");
        if (!window.open) return refuse(409, "late");
        const all = await turns(client, debateId);
        const live = all.find(
          (turn) => turn.turnNumber === cleanup.turnNumber,
        )?.live;
        if (!live) return refuse(409, "not_frozen");
        const earlier = all
          .filter((turn) => turn.turnNumber < cleanup.turnNumber)
          .flatMap((turn) => {
            const outline = turn.settled ?? turn.live;
            return (outline?.arguments ?? []).map((item) => ({
              id: item.id,
              turnNumber: turn.turnNumber,
              side: outline!.side,
            }));
          });
        const resolved = resolveCleanup(
          live,
          cleanup.arguments,
          earlier,
          (text) => !containsBlockedTerm(text),
        );
        if (!resolved) return refuse(422, "empty");
        if (outlineBytes(resolved.outline) > SNAPSHOT_MAX_BYTES)
          return refuse(422, "too_large");
        await client.query(
          `UPDATE outline_windows SET final_outline=$3::jsonb, final_source='cleanup',
            final_model=$4, finalized_at=clock_timestamp()
          WHERE debate_id=$1 AND turn_number=$2`,
          [
            debateId,
            cleanup.turnNumber,
            JSON.stringify(resolved.outline),
            cleanup.model,
          ],
        );
        return {
          status: 201,
          body: {
            accepted: true as const,
            dropped: resolved.dropped,
            turn: summary(resolved.outline, true),
          },
        };
      });
    },
    /**
     * Jobs loop: a window with no cleanup CLEANUP_ACCEPT_MS after it froze
     * keeps the outline traders saw as its final one.
     */
    async finalizeDue(limit = 20) {
      const result = await database.query(
        `WITH due AS (SELECT debate_id, turn_number FROM outline_windows
          WHERE finalized_at IS NULL
            AND frozen_at < clock_timestamp() - $2 * INTERVAL '1 millisecond'
          ORDER BY frozen_at, debate_id, turn_number LIMIT $1
          FOR UPDATE SKIP LOCKED)
        UPDATE outline_windows w SET final_outline=w.frozen_outline,
          final_source='frozen', finalized_at=clock_timestamp()
        FROM due WHERE w.debate_id=due.debate_id AND w.turn_number=due.turn_number`,
        [limit, CLEANUP_ACCEPT_MS],
      );
      return { finalized: result.rowCount ?? 0 };
    },
    /**
     * Replay sync: every live version with its place in the recording, and
     * each turn's final (or frozen, or latest) outline.
     */
    async timeline(debateId: string): Promise<OutlineTimeline> {
      const state = (
        await database.query<{ complete: boolean; timed: boolean }>(
          `SELECT d.status IN ('ended','replay','finalized')
              AND c.started_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM outline_windows w
                WHERE w.debate_id=d.id AND w.finalized_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM coin_debate_rounds r
                WHERE r.debate_id=d.id AND r.turn_number IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM outline_windows w WHERE w.window_id=r.id)
                  AND EXISTS (SELECT 1 FROM outline_versions v
                    WHERE v.debate_id=d.id AND v.turn_number=r.turn_number)) AS complete,
            c.started_at IS NOT NULL AS timed
          FROM debates d LEFT JOIN recording_clocks c ON c.debate_id=d.id WHERE d.id=$1`,
          [debateId],
        )
      ).rows[0] ?? { complete: false, timed: false };
      const versions = (
        await database.query<{
          version: number;
          at: number | null;
          turnNumber: number;
          outline: TurnOutline;
          edits: OutlineEdit[];
        }>(
          `SELECT v.version,
            floor(extract(epoch FROM v.created_at - c.started_at) * 1000)::bigint::float8 AS at,
            v.turn_number AS "turnNumber", v.outline, v.edits
          FROM outline_versions v LEFT JOIN recording_clocks c ON c.debate_id=v.debate_id
          WHERE v.debate_id=$1 ORDER BY v.version LIMIT $2`,
          [debateId, TIMELINE_MAX_VERSIONS],
        )
      ).rows;
      const all = await turns(database, debateId);
      return {
        debateId,
        complete: state.complete,
        timed: state.timed,
        versions: versions.map((row) => ({
          version: row.version,
          at: row.at,
          turnNumber: row.turnNumber,
          side: row.outline.side,
          language: row.outline.language,
          edits: row.edits,
        })),
        turns: all.flatMap((turn) =>
          turn.settled || turn.live
            ? [summary((turn.settled ?? turn.live)!, turn.final)]
            : [],
        ),
      };
    },
    /**
     * How endorsement moved with each argument. Revealed (settled) windows
     * with a final outline only; nothing is reported for a window with fewer
     * than CORRELATION_MINIMUM commitments, and never a side total.
     */
    async correlation(debateId: string): Promise<OutlineCorrelation> {
      const windows = (
        await database.query<{
          turnNumber: number;
          side: OutlineSide;
          commitments: number;
          yes: string;
          total: string;
        }>(
          `SELECT w.turn_number AS "turnNumber", r.turn_side AS side,
            count(o.request_id)::int AS commitments,
            COALESCE(sum(o.quantity) FILTER (WHERE o.side='YES'), 0)::text AS yes,
            COALESCE(sum(o.quantity), 0)::text AS total
          FROM outline_windows w JOIN coin_debate_rounds r ON r.id=w.window_id
          LEFT JOIN coin_debate_orders o ON o.round_id=r.id
          WHERE w.debate_id=$1 AND r.state='settled' AND w.finalized_at IS NOT NULL
          GROUP BY w.turn_number, r.turn_side ORDER BY w.turn_number`,
          [debateId],
        )
      ).rows;
      const items = (
        await database.query<{
          turnNumber: number;
          side: OutlineSide;
          id: string;
          label: string;
          continues: string | null;
          commitments: number;
          seen: number;
          appeared: boolean;
        }>(
          `WITH revealed AS (SELECT w.turn_number, w.final_outline, r.id AS round_id, r.turn_side AS side
            FROM outline_windows w JOIN coin_debate_rounds r ON r.id=w.window_id
            WHERE w.debate_id=$1 AND r.state='settled' AND w.finalized_at IS NOT NULL),
          items AS (SELECT x.turn_number, x.round_id, x.side, a->>'id' AS id, a->>'label' AS label,
              a->>'continues' AS continues,
              (SELECT min(v.created_at) FROM outline_versions v
                WHERE v.debate_id=$1 AND v.turn_number=x.turn_number
                  AND v.outline->'arguments' @> jsonb_build_array(jsonb_build_object('id', a->>'id')))
                AS appeared
            FROM revealed x, jsonb_array_elements(x.final_outline->'arguments') a)
          SELECT i.turn_number AS "turnNumber", i.side, i.id, i.label, i.continues,
            i.appeared IS NOT NULL AS appeared,
            (SELECT count(*)::int FROM coin_debate_orders o WHERE o.round_id=i.round_id) AS commitments,
            (SELECT count(*)::int FROM coin_debate_orders o
              LEFT JOIN recording_clocks c ON c.debate_id=$1
              WHERE o.round_id=i.round_id AND i.appeared IS NOT NULL AND (
                (o.replay_position_ms IS NULL AND o.created_at >= i.appeared)
                OR (o.replay_position_ms IS NOT NULL AND c.started_at IS NOT NULL
                  AND o.replay_position_ms >= extract(epoch FROM i.appeared - c.started_at) * 1000)))
              AS seen
          FROM items i ORDER BY i.turn_number, i.id`,
          [debateId],
        )
      ).rows;
      const continued = new Map(items.map((item) => [item.id, item.continues]));
      const thread = (id: string) => {
        const seen = new Set<string>();
        let root = id;
        while (continued.get(root) && !seen.has(root)) {
          seen.add(root);
          root = continued.get(root)!;
        }
        return root;
      };
      let previous: number | null = null;
      return {
        debateId,
        minimumCount: CORRELATION_MINIMUM,
        windows: windows.map((row) => {
          const total = Number(row.total);
          const yesShare =
            row.commitments >= CORRELATION_MINIMUM && total > 0
              ? Number(row.yes) / total
              : null;
          const change =
            yesShare !== null && previous !== null ? yesShare - previous : null;
          if (yesShare !== null) previous = yesShare;
          return {
            turnNumber: row.turnNumber,
            side: row.side,
            yesShare,
            change,
          };
        }),
        arguments: items.map((item) => ({
          id: item.id,
          turnNumber: item.turnNumber,
          side: item.side,
          label: item.label,
          thread: thread(item.id),
          onScreenShare:
            item.appeared && item.commitments >= CORRELATION_MINIMUM
              ? item.seen / item.commitments
              : null,
        })),
      };
    },
    /**
     * A debater flags an item of one of their own turns as a mistake. Only
     * the debater who spoke that turn may flag it; repeats change nothing.
     */
    async flag(input: {
      debateId: string;
      userId: string;
      turnNumber: number;
      itemId: string;
      note: string | null;
    }) {
      return withTransaction(database, async (client) => {
        const owner = (
          await client.query<{ side: OutlineSide }>(
            `SELECT p.side FROM event_participants p
            JOIN outline_versions v ON v.debate_id=p.debate_id AND v.turn_number=$3
            WHERE p.debate_id=$1 AND p.user_id=$2 AND v.outline->>'side'=p.side
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.outline->'arguments') a
                WHERE a->>'id'=$4 OR EXISTS (SELECT 1 FROM jsonb_array_elements(a->'points') q
                  WHERE q->>'id'=$4))
            LIMIT 1`,
            [input.debateId, input.userId, input.turnNumber, input.itemId],
          )
        ).rows[0];
        if (!owner) return null;
        await client.query(
          `INSERT INTO outline_flags(debate_id, turn_number, item_id, user_id, side, note)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (debate_id, item_id, user_id) DO NOTHING`,
          [
            input.debateId,
            input.turnNumber,
            input.itemId,
            input.userId,
            owner.side,
            input.note,
          ],
        );
        return { side: owner.side };
      });
    },
  });
}
