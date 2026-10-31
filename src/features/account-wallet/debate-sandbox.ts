import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  databaseFailure,
  withTransaction,
  type TransactionOptions,
} from "../../platform/transaction.ts";
import {
  RULE,
  digest,
  executeRound,
  priceRound,
  randomWord,
  reservation,
  secureSeed,
  validateOrder,
  type Order,
  type Outcome,
  type Terms,
} from "../a4/engine.ts";
import {
  assertActiveSession,
  lockAccount,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
import { CoinOperationError } from "./external-operations.ts";
import {
  allocateAtomicProportionally,
  commitStakeCost,
  planStake,
  refundStake,
  settleStake,
  type StakeFunding,
} from "./grant-accounting.ts";
import {
  coinJournalReference,
  postCoinJournal,
  type CoinPosting,
  type CoinLedgerAsset,
} from "./ledger.ts";
import {
  appendSandboxBookEvent,
  ensureSandboxBuckets,
  lockSandboxBook,
  lockSandboxBooks,
  sandboxBucketsFor,
  assertSandboxRail,
  assertSandboxFinancialOpen,
  assertSandboxOpened,
  type SandboxContext,
  type SandboxRail,
  type SandboxBuckets,
} from "./sandbox-repository.ts";
import type { TreasuryBalances } from "./treasury-monitor.ts";

// Same A4 algorithm and ordinary human schedule. This asset is new: one YC
// contract has a 0.01 USDC quote, NOT the historical YAP atomic face value.
export const COIN_DEBATE_TERMS: Readonly<Terms> = Object.freeze({
  rule: RULE,
  epsilon: 50_000,
  feeBps: 0,
  maxQuantity: 100,
  capacity: 1001,
});
export const COIN_DEBATE_FACE = 10_000n;
interface Round {
  id: string;
  debate_id: string;
  // Null for a turn window, which the coin loop opens (Decision 0012).
  creator_id: string | null;
  turn_number: number | null;
  turn_side: "A" | "B" | null;
  proposition: string;
  rail: SandboxRail;
  terms: Terms;
  seed: string;
  seed_commitment: string;
  opens_at: Date;
  closes_at: Date;
  state: "open" | "settled" | "void";
  // F11: copied from the debate when the round is created.
  reveal_mode: RevealMode;
  result: {
    snapshot: Order[];
    snapshotHash: string;
    pricing: ReturnType<typeof priceRound>;
    outcomes: Outcome[];
    voidReason?: VoidReason;
  } | null;
  revealed_at: Date | null;
}
type VoidReason = "debate_unavailable" | "operator_cancelled";
/**
 * F11: a five-day round takes orders until its cutoff and prices and settles
 * at the debate's 120-hour close; a per-round round settles at its cutoff.
 * Five-day is the default and the only mode of a user-created debate.
 */
export type RevealMode = "five_day" | "per_round";
export const REVEAL_CLOSE_HOURS = 120;
const endedStatuses = "('ended','replay','finalized')";
// True when a round (table alias) may price and settle, once past its cutoff.
const revealDue = (round: string) =>
  `(${round}.reveal_mode='per_round' OR EXISTS (SELECT 1 FROM debates rd
    WHERE rd.id=${round}.debate_id AND rd.status IN ${endedStatuses}
      AND rd.live_ended_at+INTERVAL '${REVEAL_CLOSE_HOURS} hours'<=clock_timestamp()))`;
// When a round reveals: its cutoff, or its debate's 120-hour close once the
// debate has ended (unknown before).
const revealAt = (round: string, debate: string) =>
  `CASE WHEN ${round}.revealed_at IS NOT NULL THEN ${round}.revealed_at
    WHEN ${round}.reveal_mode='per_round' THEN ${round}.closes_at
    WHEN ${debate}.status IN ${endedStatuses}
      THEN ${debate}.live_ended_at+INTERVAL '${REVEAL_CLOSE_HOURS} hours' END`;
/** F14 and the round's own limits: why this viewer cannot take a position. */
export type Ineligibility =
  | "debater"
  | "committed"
  | "debate_unavailable"
  | "paused"
  | "closed"
  | "later_window"
  | "full";
// F10: a turn window's span in the recording (round and recording_clocks
// aliases), in whole milliseconds, as the order guard computes it.
const spanStartMs = (round: string, clock: string) =>
  `greatest(0,floor(extract(epoch FROM ${round}.opens_at-${clock}.started_at)*1000))`;
const spanEndMs = (round: string, clock: string) =>
  `floor(extract(epoch FROM ${round}.closes_at-${clock}.started_at)*1000)`;
const recordingSpan = (round: string, clock: string) =>
  `CASE WHEN ${round}.turn_number IS NOT NULL AND ${clock}.started_at IS NOT NULL
    THEN json_build_object('startSeconds',${spanStartMs(round, clock)}/1000.0,
      'endSeconds',${spanEndMs(round, clock)}/1000.0) END`;
// True when a round takes replay positions: a five-day turn window, from the
// debate's live end until its 120-hour close, once the recording is timed.
const replayable = (round: string, debate: string, clock: string) =>
  `(${round}.state='open' AND ${round}.turn_number IS NOT NULL AND ${round}.reveal_mode='five_day'
    AND clock_timestamp()>=${round}.closes_at AND ${debate}.status IN ${endedStatuses}
    AND ${debate}.live_ended_at+INTERVAL '${REVEAL_CLOSE_HOURS} hours'>clock_timestamp()
    AND ${clock}.started_at IS NOT NULL)`;
// True when a round takes live orders: before its cutoff and, for a turn
// window, while its debate is still live.
const liveAccepting = (round: string, debate: string) =>
  `(clock_timestamp()<${round}.closes_at AND (${round}.turn_number IS NULL OR ${debate}.status='live'))`;
// The replayable() conditions without the recording clock.
const replayableUntimed = (round: string, debate: string) =>
  `(${round}.state='open' AND ${round}.turn_number IS NOT NULL AND ${round}.reveal_mode='five_day'
    AND clock_timestamp()>=${round}.closes_at AND ${debate}.status IN ${endedStatuses}
    AND ${debate}.live_ended_at+INTERVAL '${REVEAL_CLOSE_HOURS} hours'>clock_timestamp())`;
// True when the user holds a position in a later turn's window of the debate.
const laterWindowJoined = (round: string, user: string) =>
  `EXISTS (SELECT 1 FROM coin_debate_orders lo JOIN coin_debate_rounds lr ON lr.id=lo.round_id
    WHERE lr.debate_id=${round}.debate_id AND lo.user_id=${user}
      AND lr.turn_number>${round}.turn_number)`;
/** A turn window's start and end in the debate's recording, in seconds. */
export interface RecordingSpan {
  startSeconds: number;
  endSeconds: number;
}
// A debate in one of these states takes no new commitments, and the coin loop
// voids its open rounds instead of settling them (F15: only unopened rounds).
const unavailableStatuses = "('cancelled','void_review')";
// True once some of a round's orders have settled: it then finishes settling,
// even if its debate becomes unavailable, and can no longer be voided.
const settlementStarted = (round: string) =>
  `EXISTS (SELECT 1 FROM coin_debate_orders so JOIN coin_sandbox_requests sq ON sq.id=so.request_id
    WHERE so.round_id=${round}.id AND sq.status='settled')`;
export interface TurnWindow {
  id: string;
  turnNumber: number;
  side: "A" | "B";
  opensAt: Date;
  closesAt: Date;
  state: Round["state"];
  voidReason: VoidReason | null;
  revealMode: RevealMode;
  revealAt: Date | null;
  recording: RecordingSpan | null;
  /**
   * The signed-in view's aggregate pricing once the window is settled
   * (revealed), at any number of commitments (founder, 2026-10-26); null
   * before. Never per-user data.
   */
  pricing: ReturnType<typeof priceRound> | null;
}
interface StoredOrder {
  user_id: string;
  request_id: string;
  side: Order["side"];
  limit_value: string;
  quantity: number;
  funding: StakeFunding;
  center_reservation: string;
  promotional_reservation: string;
  // F10: the replay position of a replay viewer's order; null when live.
  replay_position_ms: number | null;
}
// An order with its request's status: "reserved" until its round settles it.
interface PendingOrder extends StoredOrder {
  request_status: string;
}
const ordersWithStatus = `SELECT o.*,q.status AS request_status FROM coin_debate_orders o
  JOIN coin_sandbox_requests q ON q.id=o.request_id WHERE o.round_id=$1 ORDER BY o.user_id`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reference = (userId: string, operation: string, key: string) =>
  coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
function fail(
  message: string,
  status = 409,
  code?: string,
  details?: Readonly<Record<string, string>>,
): never {
  throw new CoinOperationError(message, status, code, details);
}
// The order guard's refusals (migration 1792984636802), raised with SQLSTATE
// 23514 when a race passes the earlier checks: a submit that waited for locks
// past the cutoff, for example. Each maps to the code the API returns.
const guardRefusals: Readonly<
  Record<string, { status: number; code: string; message: string }>
> = {
  "sandbox debate is past cutoff": {
    status: 409,
    code: "window_closed",
    message: "this turn's window closed",
  },
  "this window is not playing at that replay position": {
    status: 409,
    code: "replay_position",
    message: "this window is not playing at that replay position",
  },
  "a later turn's window was already joined": {
    status: 409,
    code: "later_window",
    message: "you already joined a later turn's window",
  },
  "debaters cannot take a position in their own debate": {
    status: 403,
    code: "debater",
    message: "debaters cannot take a position in their own debate",
  },
};
function guardRefusal(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "23514" ||
    !(error instanceof Error)
  )
    return undefined;
  return guardRefusals[error.message];
}
function resource(id: string) {
  if (!uuid.test(id)) fail("sandbox round not found", 404);
}
function fundingTotals(funding: StakeFunding | null) {
  let cash = 0n,
    promo = 0n;
  for (const source of funding?.sources ?? []) {
    if (source.kind === "grant") {
      promo += BigInt(source.principal);
      cash += BigInt(source.profit);
    } else cash += BigInt(source.amount);
  }
  return { cash, promo };
}
function transfer(
  postings: CoinPosting[],
  from: string,
  to: string,
  amount: bigint,
) {
  if (amount < 0n) fail("negative sandbox transfer", 503);
  if (amount)
    postings.push(
      { accountId: from, amount: String(-amount) },
      { accountId: to, amount: String(amount) },
    );
}
/**
 * Locks every ledger account the given buckets can touch, in the one global
 * order: cash-asset accounts by ID, then promotional ones by ID. Exported so
 * that test fixtures holding treasury rows lock in the same order.
 */
export async function lockLedger(
  client: PoolClient,
  buckets: readonly SandboxBuckets[],
) {
  const cash = [
    ...new Set(
      buckets.flatMap((b) => [
        b.cashAvailable,
        b.cashReserved,
        b.cashPending,
        ...Object.entries(b.system)
          .filter(([purpose]) => purpose !== "grant_issuer")
          .map(([, id]) => id),
      ]),
    ),
  ].sort();
  const promo = [
    ...new Set(
      buckets.flatMap((b) => [
        b.promoAvailable,
        b.promoReserved,
        b.system.grant_issuer,
      ]),
    ),
  ].sort();
  // Prelock ALL affected assets/accounts once, before the first of the two
  // journals. Reversed per-asset UUID ordering cannot deadlock concurrent pays.
  for (const ids of [cash, promo])
    await client.query(
      "SELECT id FROM coin_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [ids],
    );
}
async function post(
  client: PoolClient,
  userId: string,
  operation: "reserve" | "payout",
  key: string,
  asset: CoinLedgerAsset,
  postings: CoinPosting[],
) {
  if (!postings.length) return undefined;
  return (
    await postCoinJournal(client, {
      id: randomUUID(),
      environment: "sandbox",
      asset,
      operation,
      reference: reference(
        userId,
        `debate.${operation}.${asset.toLowerCase()}`,
        key,
      ),
      postings,
    })
  ).id;
}
/**
 * Interface 10 (results notice): a round its participants joined was revealed
 * (settled) or voided. The payload is the bare user id; Postgres delivers it
 * only if the transaction commits, and once per user per transaction.
 */
export const RESULTS_CHANNEL = "yaparena_results_v1";
async function notifyResults(client: PoolClient, userIds: readonly string[]) {
  if (!userIds.length) return;
  await client.query(
    "SELECT pg_notify($1, user_id) FROM unnest($2::text[]) AS user_id",
    [RESULTS_CHANNEL, [...new Set(userIds)]],
  );
}
/** The newest results one read returns. */
export const RESULTS_LIMIT = 50;
/**
 * Per-round locks. The invariant they protect: settlement and voiding read a
 * round's complete population of orders. A submit holds its round's lock
 * shared for its whole transaction, so submits run side by side; settling or
 * voiding takes it exclusively before reading the orders, so it waits for
 * every in-flight submit to commit and no new one can join until it commits
 * (the order guard then refuses the closed round). Reads take no lock.
 *
 * Every transaction takes round locks first, in one global order (by lock
 * key), before any account, book or ledger row, so they cannot deadlock.
 */
async function lockRounds(
  client: PoolClient,
  roundIds: readonly string[],
  mode: "shared" | "exclusive",
) {
  if (!roundIds.length) return;
  const keys = (
    await client.query<{ key: string }>(
      `SELECT DISTINCT hashtextextended('coin-debate-round:'||id::text,0)::text AS key
      FROM unnest($1::uuid[]) id ORDER BY 1`,
      [roundIds],
    )
  ).rows;
  for (const { key } of keys)
    await client.query(
      mode === "shared"
        ? "SELECT pg_advisory_xact_lock_shared($1::bigint)"
        : "SELECT pg_advisory_xact_lock($1::bigint)",
      [key],
    );
}
// Opening a debate's rounds, and recording its reveal mode, one at a time.
async function lockDebateOpening(client: PoolClient, debateId: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('coin-debate-open:'||$1::text,0))",
    [debateId],
  );
}
/**
 * Request paths fail fast; the worker may wait longer behind a large reveal.
 * Each is SET LOCAL, so it wins over a pool-wide default.
 */
export const COIN_REQUEST_LIMITS = Object.freeze({
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
});
export const COIN_WORKER_LIMITS = Object.freeze({
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
});
/**
 * One settlement batch: at most this many rounds and this many orders. A
 * larger round settles over several batches: each prices the whole round the
 * same way and settles the next orders, and the last one reveals it.
 * Settlement locks every participant and the shared treasury rows, which each
 * submit also needs, so a batch must finish well inside a submit's lock
 * timeout. Rounds still settle in closing order: a later round waits until
 * the earlier one is revealed.
 */
export const SETTLEMENT_BATCH = Object.freeze({
  rounds: 20,
  orders: 200,
  // A batch also stops settling once it has run this long, whatever the
  // database's speed, leaving the rest for the next tick.
  budgetMs: 250,
  // While any live turn window is in its final seconds, when most answers
  // arrive, batches are smaller still.
  quietOrders: 50,
  quietBudgetMs: 100,
  quietSeconds: 15,
});
// A round whose settlement throws waits this long before its next attempt,
// doubling up to an hour; the rest keep settling meanwhile.
const setAsideBaseMs = 60_000,
  setAsideMaxMs = 3_600_000;
// A lock or statement timeout, a deadlock, or no free connection in the
// pool: nothing was written.
const busyError = () =>
  new CoinOperationError(
    "Yap Coins are busy; try again. Nothing was reserved.",
    503,
    "busy",
  );
function busy(error: unknown) {
  return databaseFailure(error) === "busy" ? busyError() : error;
}
const poolExhausted = (error: unknown) =>
  error instanceof Error &&
  error.message === "timeout exceeded when trying to connect";
export function createCoinDebateSandbox(
  database: Pool,
  rail: SandboxRail,
  options: {
    turnWindows?: boolean;
    logger?: { error(details: object, message: string): void };
    // Tests that hold locks on purpose may relax these, and tests may use
    // smaller settlement batches.
    limits?: { request?: TransactionOptions; worker?: TransactionOptions };
    settlement?: Partial<typeof SETTLEMENT_BATCH>;
  } = {},
) {
  const batch = { ...SETTLEMENT_BATCH, ...options.settlement };
  const turnWindows = options.turnWindows === true;
  const requestLimits = options.limits?.request ?? COIN_REQUEST_LIMITS,
    workerLimits = options.limits?.worker ?? COIN_WORKER_LIMITS;
  // Rounds whose settlement threw, kept by this process (founder audit item
  // 7): skipped until their retry time and logged each time they fail.
  const setAside = new Map<string, { failures: number; retryAt: number }>();
  // A round settling over several batches is priced once: its population is
  // fixed after the cutoff, and the key checks that it hasn't changed.
  const priced = new Map<
    string,
    {
      key: string;
      pricing: ReturnType<typeof priceRound>;
      outcomes: Outcome[];
    }
  >();
  // Measured cost of settling one order, so each batch takes about as many
  // orders as fit its time budget on this database.
  let perOrderMs = 2;
  const capFor = (budgetMs: number, maximum: number) =>
    Math.max(1, Math.min(maximum, Math.floor(budgetMs / perOrderMs)));
  async function transaction<T>(
    mutation: (client: PoolClient) => Promise<T>,
    limits: TransactionOptions = requestLimits,
  ) {
    return withTransaction(
      database,
      async (client) => {
        await assertSandboxRail(client, rail);
        return mutation(client);
      },
      { ...limits, mapError: busy },
    ).catch((error: unknown) => {
      throw poolExhausted(error) ? busyError() : error;
    });
  }
  async function assertCallerSession(
    client: PoolClient,
    context: SandboxContext,
  ) {
    const currentSession = await assertActiveSession(
      client,
      context.userId,
      context.sessionTokenHash,
    );
    if (
      context.expectedSessionId !== undefined &&
      currentSession.id !== context.expectedSessionId
    )
      fail(
        "account context changed; refresh balances and review again",
        409,
        "session_changed",
      );
  }
  async function authorize(client: PoolClient, context: SandboxContext) {
    if (!(await lockAccount(client, context.userId)))
      throw new SessionUnavailableError("account unavailable");
    await assertCallerSession(client, context);
    await assertSandboxOpened(client, context.userId);
    await assertSandboxFinancialOpen(client, context.userId);
  }
  // Settling and voiding update the round, so they lock its row; a submit
  // only reads it under its shared round lock.
  async function stored(client: PoolClient, roundId: string, forUpdate = true) {
    resource(roundId);
    const round = (
      await client.query<Round>(
        `SELECT * FROM coin_debate_rounds WHERE id=$1 AND rail=$2${forUpdate ? " FOR UPDATE" : ""}`,
        [roundId, rail],
      )
    ).rows[0];
    if (!round) fail("sandbox round not found", 404);
    if (digest(round.terms) !== digest(COIN_DEBATE_TERMS))
      fail("sandbox debate uses unsupported terms", 503);
    return round;
  }
  async function dueBatch(
    client: PoolClient,
    limit: number,
    authorizeCaller?: { context: SandboxContext },
  ) {
    // Freeze the complete bounded batch before any account/book/ledger write.
    // Its union is essential: locking a later round's account after an earlier
    // round's shared ledger rows can deadlock funding or payout reconciliation.
    // A cancelled or under-review debate's rounds are voided, never settled.
    // The batch stops at SETTLEMENT_BATCH.orders orders (a larger round goes
    // alone), or at quietOrders while a live window is closing, and skips
    // rounds set aside until their retry time.
    const now = Date.now();
    const skipped = [...setAside]
      .filter(([, entry]) => entry.retryAt > now)
      .map(([id]) => id);
    const rounds = (
      await client.query<{ id: string; take: number; quiet: boolean }>(
        `WITH due AS (SELECT r.id,r.closes_at,
            (SELECT count(*) FROM coin_debate_orders o JOIN coin_sandbox_requests q ON q.id=o.request_id
              WHERE o.round_id=r.id AND q.status='reserved') AS pending
          FROM coin_debate_rounds r WHERE r.state='open' AND r.rail=$1
          AND r.closes_at<=clock_timestamp() AND ${revealDue("r")}
          AND (NOT EXISTS (SELECT 1 FROM debates d
            WHERE d.id=r.debate_id AND d.status IN ${unavailableStatuses}) OR ${settlementStarted("r")})
          AND NOT r.id=ANY($4::uuid[])
          ORDER BY r.closes_at,r.id LIMIT $2),
        running AS (SELECT id,closes_at,pending,
          sum(pending) OVER (ORDER BY closes_at,id)-pending AS before FROM due),
        quiet AS (SELECT EXISTS (SELECT 1 FROM coin_debate_rounds w
            JOIN debates d ON d.id=w.debate_id
            WHERE w.state='open' AND w.turn_number IS NOT NULL AND d.status='live'
              AND w.closes_at>clock_timestamp()
              AND w.closes_at<=clock_timestamp()+make_interval(secs=>$6)) AS active),
        cap AS (SELECT active,CASE WHEN active THEN $5::bigint ELSE $3::bigint END AS orders FROM quiet)
        SELECT id,LEAST(pending,cap.orders-before)::int AS take,cap.active AS quiet
        FROM running,cap WHERE before<cap.orders ORDER BY closes_at,id`,
        [
          rail,
          limit,
          capFor(batch.budgetMs, batch.orders),
          skipped,
          capFor(batch.quietBudgetMs, batch.quietOrders),
          batch.quietSeconds,
        ],
      )
    ).rows;
    // Wait for in-flight submits to these rounds, and keep new ones out.
    await lockRounds(
      client,
      rounds.map((r) => r.id),
      "exclusive",
    );
    // Each round's next orders to settle, by user.
    const chunks: {
      id: string;
      users: ReadonlySet<string>;
      quiet: boolean;
    }[] = [];
    for (const round of rounds)
      chunks.push({
        id: round.id,
        quiet: round.quiet,
        users: new Set(
          (
            await client.query<{ user_id: string }>(
              `SELECT o.user_id FROM coin_debate_orders o JOIN coin_sandbox_requests q ON q.id=o.request_id
              WHERE o.round_id=$1 AND q.status='reserved' ORDER BY o.user_id LIMIT $2`,
              [round.id, round.take],
            )
          ).rows.map((row) => row.user_id),
        ),
      });
    const participants = chunks.flatMap((chunk) => [...chunk.users]);
    const users = [
      ...new Set([
        ...participants,
        ...(authorizeCaller ? [authorizeCaller.context.userId] : []),
      ]),
    ].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    );
    await client.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [users],
    );
    // An API caller must be authorized before its request may settle anybody's
    // obligations or initialize financial books. Worker advancement has no user.
    if (authorizeCaller) await authorize(client, authorizeCaller.context);
    // Books, then buckets, in account order, before the shared ledger rows.
    await lockSandboxBooks(client, users);
    const buckets = await sandboxBucketsFor(client, users);
    await lockLedger(client, [...buckets.values()]);
    return chunks.map((chunk) => ({ ...chunk, buckets }));
  }
  // Settles the given users' orders of a due round (all of them when no
  // chunk is given) and reveals the round once none is left. Pricing always
  // uses the round's complete, fixed population, so every chunk computes the
  // same outcomes. Returns true when the round is revealed.
  async function settle(
    client: PoolClient,
    roundId: string,
    chunk?: ReadonlySet<string>,
    deadline = Number.POSITIVE_INFINITY,
    known: ReadonlyMap<string, SandboxBuckets> = new Map(),
  ): Promise<{ revealed: boolean; settled: number }> {
    // The batch holds this round's lock exclusively: no new admissions.
    const orders = (
      await client.query<PendingOrder>(ordersWithStatus, [roundId])
    ).rows;
    const pending = orders
      .map((order, index) => ({ order, index }))
      .filter(({ order }) => order.request_status === "reserved");
    const settling = chunk
      ? pending.filter(({ order }) => chunk.has(order.user_id))
      : pending;
    await client.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [settling.map(({ order }) => order.user_id)],
    );
    const round = await stored(client, roundId);
    if (round.state !== "open") return { revealed: false, settled: 0 };
    const due = (
      await client.query<{ due: boolean }>(
        `SELECT clock_timestamp()>=r.closes_at AND ${revealDue("r")} AS due
        FROM coin_debate_rounds r WHERE r.id=$1`,
        [round.id],
      )
    ).rows[0]!.due;
    if (!due) return { revealed: false, settled: 0 };
    const snapshot: Order[] = orders.map((o) => ({
      participant: o.user_id,
      kind: "human",
      side: o.side,
      limit: o.limit_value,
      quantity: o.quantity,
    }));
    if (digest(round.seed) !== round.seed_commitment)
      fail("sandbox seed commitment mismatch", 503);
    const key = digest([round.seed, snapshot]);
    let price = priced.get(roundId);
    if (price?.key !== key) {
      const pricing = priceRound(
        snapshot,
        round.terms,
        randomWord(round.seed, "branch"),
        randomWord(round.seed, "price"),
      );
      price = {
        key,
        pricing,
        outcomes: executeRound(
          snapshot,
          round.terms,
          pricing,
          COIN_DEBATE_FACE,
        ),
      };
      priced.set(roundId, price);
      if (priced.size > 50) priced.delete(priced.keys().next().value!);
    }
    const { pricing, outcomes } = price;
    const books = await lockSandboxBooks(
      client,
      settling.map(({ order }) => order.user_id),
    );
    const snapshots = settling.map(({ order }) => books.get(order.user_id)!);
    const buckets = [];
    for (const { order } of settling)
      buckets.push(
        known.get(order.user_id) ??
          (await ensureSandboxBuckets(client, order.user_id)),
      );
    await lockLedger(client, buckets);
    const now = (
      await client.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now.toISOString();
    let settled = 0;
    for (const [position, { order, index }] of settling.entries()) {
      // Past the batch's time budget, the rest wait for the next batch.
      if (position > 0 && performance.now() > deadline) break;
      settled++;
      const outcome = outcomes[index]!,
        before = snapshots[position]!,
        bucket = buckets[position]!;
      const committed = commitStakeCost(
        before.book,
        order.funding,
        String(BigInt(outcome.premium) + BigInt(outcome.fee)),
      );
      const settlement = committed.funding
        ? settleStake(committed.book, committed.funding, outcome.net, now)
        : null;
      const book = settlement?.book ?? committed.book;
      const reserved = fundingTotals(order.funding),
        actual = fundingTotals(committed.funding);
      const cash: CoinPosting[] = [],
        promo: CoinPosting[] = [];
      transfer(
        cash,
        bucket.cashReserved,
        bucket.cashAvailable,
        reserved.cash - actual.cash,
      );
      transfer(
        promo,
        bucket.promoReserved,
        bucket.promoAvailable,
        reserved.promo - actual.promo,
      );
      const cost = actual.cash + actual.promo;
      const cashFee = cost
        ? allocateAtomicProportionally(BigInt(outcome.fee), [
            actual.cash,
            actual.promo,
          ])[0]!
        : 0n;
      transfer(cash, bucket.cashReserved, bucket.system.fees, cashFee);
      transfer(
        cash,
        bucket.cashReserved,
        bucket.system.center_available,
        actual.cash - cashFee,
      );
      transfer(
        promo,
        bucket.promoReserved,
        bucket.system.grant_issuer,
        actual.promo,
      );
      let returnedFromCenter = 0n,
        newPromotionalProfit = 0n;
      for (const receipt of settlement?.receipts ?? []) {
        if (receipt.kind === "grant") {
          const returnedProfit = BigInt(receipt.profitReturned);
          const previousProfit = BigInt(receipt.profit);
          const restoredCash =
            returnedProfit < previousProfit ? returnedProfit : previousProfit;
          const newProfit = returnedProfit - restoredCash;
          returnedFromCenter += restoredCash;
          newPromotionalProfit += newProfit;
          transfer(
            cash,
            bucket.system.center_reserved,
            bucket.cashAvailable,
            restoredCash,
          );
          transfer(
            cash,
            bucket.system.promotional_reserved,
            bucket.cashAvailable,
            newProfit,
          );
          transfer(
            promo,
            bucket.system.grant_issuer,
            bucket.promoAvailable,
            BigInt(receipt.principalReturned),
          );
        } else {
          const returned = BigInt(receipt.returned);
          returnedFromCenter += returned;
          transfer(
            cash,
            bucket.system.center_reserved,
            bucket.cashAvailable,
            returned,
          );
        }
      }
      transfer(
        cash,
        bucket.system.center_reserved,
        bucket.system.center_available,
        BigInt(order.center_reservation) - returnedFromCenter,
      );
      transfer(
        cash,
        bucket.system.promotional_reserved,
        bucket.system.promotional_available,
        BigInt(order.promotional_reservation) - newPromotionalProfit,
      );
      const cashJournalId = await post(
        client,
        order.user_id,
        "payout",
        order.request_id,
        "USDC",
        cash,
      );
      const promoJournalId = await post(
        client,
        order.user_id,
        "payout",
        order.request_id,
        "YC_PROMO",
        promo,
      );
      for (const receipt of settlement?.receipts ?? []) {
        if (receipt.kind === "grant" && receipt.netResult !== "0") {
          if (!cashJournalId) fail("grant result journal missing", 503);
          await client.query(
            "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'sandbox','USDC',$3)",
            [receipt.id, cashJournalId, receipt.netResult],
          );
        }
      }
      await appendSandboxBookEvent(client, {
        userId: order.user_id,
        snapshot: before,
        book,
        kind: "debate.settled",
        reference: reference(
          order.user_id,
          "debate.settlement",
          order.request_id,
        ),
        termsDigest: digest([round.id, outcome, committed.funding]),
        requestId: order.request_id,
        cashJournalId,
        promoJournalId,
        metadata: {
          roundId: round.id,
          outcome,
          reservedFunding: order.funding,
          committedFunding: committed.funding,
          sources: settlement?.receipts ?? [],
          releasedSources: committed.released,
          newPromotionalProfit: String(newPromotionalProfit),
          rail,
        },
      });
      await client.query(
        "UPDATE coin_sandbox_requests SET status='settled' WHERE id=$1",
        [order.request_id],
      );
    }
    // More orders wait for the next batch; the round stays open until then.
    if (settled < pending.length) return { revealed: false, settled };
    priced.delete(roundId);
    const result = {
      snapshot,
      snapshotHash: digest({
        roundId,
        terms: round.terms,
        seedCommitment: round.seed_commitment,
        orders: snapshot,
      }),
      pricing,
      outcomes,
    };
    await client.query(
      "UPDATE coin_debate_rounds SET state='settled',result=$2::jsonb,revealed_at=clock_timestamp() WHERE id=$1",
      [roundId, JSON.stringify(result)],
    );
    await notifyResults(
      client,
      orders.map((order) => order.user_id),
    );
    return { revealed: true, settled };
  }
  // Opens the current speaking turn's trading window of one live debate, at
  // most once per turn (Decision 0012). Its cutoff is the turn deadline copied
  // from debate_media and never moves, even if the turn is paused later.
  // Plain reads only: no debate or media row lock, so opening never waits
  // behind the media clock or a lifecycle transition, and the room counter is
  // still the last lock, at COMMIT (docs/community-delivery.md). A turn the
  // clock already advanced inserts nothing.
  async function openWindow(client: PoolClient, debateId: string) {
    await lockDebateOpening(client, debateId);
    const live = `FROM debates d JOIN topics t ON t.id=d.topic_id
      JOIN debate_media m ON m.debate_id=d.id
      WHERE d.id=$1 AND d.status='live' AND d.publication_state='published'
        AND t.publication_state='published' AND m.state='running'
        AND m.active_side IS NOT NULL
        AND m.turn_deadline_at>clock_timestamp()+INTERVAL '1 second'`;
    const turn = (
      await client.query<{ turnNumber: number }>(
        `SELECT m.turn_number AS "turnNumber" ${live}`,
        [debateId],
      )
    ).rows[0];
    if (!turn) return null;
    const seed = secureSeed(),
      id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO coin_debate_rounds(id,debate_id,creator_id,turn_number,turn_side,
        proposition,rail,reference,terms,seed,seed_commitment,closes_at)
      SELECT $2::uuid,d.id,NULL,m.turn_number,m.active_side,d.proposition,$3::text,$4::text,
        $5::jsonb,$6::text,$7::text,m.turn_deadline_at ${live} AND m.turn_number=$8::integer
      ON CONFLICT (debate_id,turn_number) WHERE turn_number IS NOT NULL DO NOTHING`,
      [
        debateId,
        id,
        rail,
        digest(["turn-window", rail, debateId, turn.turnNumber]),
        JSON.stringify(COIN_DEBATE_TERMS),
        seed,
        digest(seed),
        turn.turnNumber,
      ],
    );
    return inserted.rowCount ? { id, created: true } : null;
  }
  // Exact-source refund of an open round's reservations, without profit or
  // qualification. It takes the round's lock exclusively (no new admissions).
  async function voidOpen(
    client: PoolClient,
    roundId: string,
    reason: VoidReason,
    actorRole: string,
  ) {
    await lockRounds(client, [roundId], "exclusive");
    const orders = (
      await client.query<PendingOrder>(ordersWithStatus, [roundId])
    ).rows;
    await client.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [orders.map((o) => o.user_id)],
    );
    const round = await stored(client, roundId);
    if (round.state === "void") return { created: false };
    if (round.state !== "open") fail("settled obligations cannot be voided");
    // A round part-way through settlement finishes settling instead.
    if (orders.some((order) => order.request_status === "settled"))
      fail("this round's settlement has started; it can't be voided");
    const snapshots = [],
      buckets = [];
    for (const order of orders) {
      snapshots.push(await lockSandboxBook(client, order.user_id));
      buckets.push(await ensureSandboxBuckets(client, order.user_id));
    }
    await lockLedger(client, buckets);
    for (let index = 0; index < orders.length; index++) {
      const order = orders[index]!,
        before = snapshots[index]!,
        bucket = buckets[index]!,
        totals = fundingTotals(order.funding);
      const cash: CoinPosting[] = [],
        promo: CoinPosting[] = [];
      transfer(cash, bucket.cashReserved, bucket.cashAvailable, totals.cash);
      transfer(
        cash,
        bucket.system.center_reserved,
        bucket.system.center_available,
        BigInt(order.center_reservation),
      );
      transfer(
        cash,
        bucket.system.promotional_reserved,
        bucket.system.promotional_available,
        BigInt(order.promotional_reservation),
      );
      transfer(
        promo,
        bucket.promoReserved,
        bucket.promoAvailable,
        totals.promo,
      );
      const cashJournalId = await post(
        client,
        order.user_id,
        "payout",
        `void:${order.request_id}`,
        "USDC",
        cash,
      );
      const promoJournalId = await post(
        client,
        order.user_id,
        "payout",
        `void:${order.request_id}`,
        "YC_PROMO",
        promo,
      );
      await appendSandboxBookEvent(client, {
        userId: order.user_id,
        snapshot: before,
        book: refundStake(before.book, order.funding),
        kind: "debate.voided",
        reference: reference(order.user_id, "debate.void", order.request_id),
        termsDigest: digest([roundId, reason, order.funding]),
        requestId: order.request_id,
        cashJournalId,
        promoJournalId,
        metadata: {
          roundId,
          reason,
          funding: order.funding,
          rail,
          actorRole,
        },
      });
      await client.query(
        "UPDATE coin_sandbox_requests SET status='void' WHERE id=$1",
        [order.request_id],
      );
    }
    await client.query(
      "UPDATE coin_debate_rounds SET state='void',result=$2::jsonb,revealed_at=clock_timestamp() WHERE id=$1",
      [
        roundId,
        JSON.stringify({
          voidReason: reason,
          snapshot: [],
          snapshotHash: digest([roundId, reason]),
          pricing: priceRound([], round.terms, 0n, 0n),
          outcomes: [],
        }),
      ],
    );
    await notifyResults(
      client,
      orders.map((order) => order.user_id),
    );
    return { created: true };
  }
  const api = Object.freeze({
    async create(
      context: SandboxContext,
      debateId: string,
      idempotencyKey: string,
    ) {
      resource(debateId);
      const key = reference(context.userId, "debate.open", idempotencyKey);
      // Only the worker settles (advance); a viewer's request never runs
      // anybody's settlement.
      return transaction(async (client) => {
        await authorize(client, context);
        const previous = (
          await client.query<Round>(
            "SELECT * FROM coin_debate_rounds WHERE reference=$1",
            [key],
          )
        ).rows[0];
        if (previous) {
          if (previous.debate_id !== debateId)
            fail("idempotency key has different debate");
          await assertCallerSession(client, context);
          return { id: previous.id, created: false };
        }
        const debate = (
          await client.query<{ proposition: string; status: string }>(
            "SELECT d.proposition,d.status FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published' AND d.status NOT IN ('cancelled','void_review')",
            [debateId],
          )
        ).rows[0];
        if (!debate) fail("debate not found", 404);
        if (turnWindows && debate.status === "live") {
          // Decision 0012: during a live debate the current speaking turn's
          // window is the only round to join; no five-minute round opens.
          const window =
            (
              await client.query<{ id: string }>(
                `SELECT id FROM coin_debate_rounds WHERE debate_id=$1 AND rail=$2
                AND turn_number IS NOT NULL AND state='open' AND closes_at>clock_timestamp()
                ORDER BY turn_number DESC LIMIT 1`,
                [debateId, rail],
              )
            ).rows.map((row) => ({ id: row.id, created: false }))[0] ??
            (await openWindow(client, debateId));
          if (!window)
            fail(
              "no trading window is open; the next one opens with the next speaking turn",
              409,
              "window_closed",
            );
          await assertCallerSession(client, context);
          return window;
        }
        // Decision 0013 (founder D5): with turn windows, positions are taken
        // only in a live turn's window, or from the replay. No manual round
        // opens, so nobody stakes before a scheduled debate starts.
        if (turnWindows)
          fail(
            "answers open with each speaking turn once the debate is live",
            409,
            "window_closed",
          );
        // A five-day manual round stays open after its cutoff until the
        // debate's 120-hour close; only one still taking orders is current.
        // A per-round one stays current until the worker settles it, which
        // keeps one open per-round round per debate (index coin_debate_open).
        await lockDebateOpening(client, debateId);
        const current = (
          await client.query<{ id: string }>(
            `SELECT id FROM coin_debate_rounds WHERE debate_id=$1 AND state='open' AND turn_number IS NULL
            AND (reveal_mode='per_round' OR closes_at>clock_timestamp())
            ORDER BY opens_at DESC,id LIMIT 1`,
            [debateId],
          )
        ).rows[0];
        if (current) {
          await assertCallerSession(client, context);
          return { id: current.id, created: false };
        }
        const seed = secureSeed(),
          id = randomUUID();
        await client.query(
          `INSERT INTO coin_debate_rounds(id,debate_id,creator_id,proposition,rail,reference,terms,seed,seed_commitment,closes_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,clock_timestamp()+INTERVAL '300 seconds')`,
          [
            id,
            debateId,
            context.userId,
            debate.proposition,
            rail,
            key,
            JSON.stringify(COIN_DEBATE_TERMS),
            seed,
            digest(seed),
          ],
        );
        await assertCallerSession(client, context);
        return { id, created: true };
      });
    },
    async submit(
      context: SandboxContext,
      roundId: string,
      idempotencyKey: string,
      input: {
        side: Order["side"];
        limit: string;
        quantity: number;
        // F10: the replay position the viewer is watching, after a cutoff.
        replayPositionMs?: number;
      },
    ) {
      resource(roundId);
      if (
        input.replayPositionMs !== undefined &&
        (!Number.isSafeInteger(input.replayPositionMs) ||
          input.replayPositionMs < 0)
      )
        fail("invalid replay position", 400);
      const key = reference(context.userId, "debate.submit", idempotencyKey);
      return transaction(async (client) => {
        await lockRounds(client, [roundId], "shared");
        await authorize(client, context);
        const round = await stored(client, roundId, false);
        const order: Order = {
          participant: context.userId,
          kind: "human",
          side: input.side,
          limit: input.limit,
          quantity: input.quantity,
        };
        validateOrder(order, round.terms);
        const terms = {
          rail,
          roundId,
          rule: RULE,
          side: input.side,
          limit: input.limit,
          quantity: String(input.quantity),
          asset: "USDC",
          precision: "6",
          face: String(COIN_DEBATE_FACE),
          ...(input.replayPositionMs !== undefined
            ? { replayPositionMs: String(input.replayPositionMs) }
            : {}),
        };
        const termsDigest = digest(terms);
        const existing = (
          await client.query<{ id: string; terms_digest: string }>(
            "SELECT id,terms_digest FROM coin_sandbox_requests WHERE user_id=$1 AND kind='stake' AND reference=$2",
            [context.userId, key],
          )
        ).rows[0];
        if (existing) {
          if (existing.terms_digest !== termsDigest)
            fail(
              "idempotency key has different participation terms",
              409,
              "idempotency_conflict",
            );
          return { id: existing.id, created: false };
        }
        if (round.state !== "open")
          fail("sandbox round is closed", 409, "window_closed");
        // A five-day round stays open after its cutoff, until its reveal.
        // Replay viewers then join the window playing at their position (F10).
        // A turn window takes live orders only while its debate is live: an
        // operator who ends a debate early closes its open window too.
        const timing = (
          await client.query<{
            accepting: boolean;
            replayable: boolean;
            untimed: boolean;
            inSpan: boolean | null;
            later: boolean;
          }>(
            `SELECT ${liveAccepting("r", "d")} AS accepting,
              ${replayable("r", "d", "c")} AS replayable,
              (${replayableUntimed("r", "d")} AND c.started_at IS NULL) AS untimed,
              $2::integer BETWEEN ${spanStartMs("r", "c")} AND ${spanEndMs("r", "c")} AS "inSpan",
              ${laterWindowJoined("r", "$3::bigint")} AS later
            FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
            LEFT JOIN recording_clocks c ON c.debate_id=r.debate_id WHERE r.id=$1`,
            [round.id, input.replayPositionMs ?? null, context.userId],
          )
        ).rows[0]!;
        let replayPositionMs: number | null = null;
        if (!timing.accepting) {
          if (input.replayPositionMs === undefined)
            fail("sandbox debate is past cutoff", 409, "window_closed");
          // F10 needs the recording's start, which LiveKit reports when the
          // recording completes; until then the replay takes no answers.
          if (timing.untimed)
            fail(
              "this replay can't take answers until its recording is ready",
              409,
              "replay_untimed",
            );
          if (!timing.replayable)
            fail(
              "replay positions are taken only by a five-day debate's turn windows, from its end until its 120-hour close",
              409,
              "window_closed",
            );
          if (!timing.inSpan)
            fail(
              "this window is not playing at that replay position",
              409,
              "replay_position",
            );
          if (timing.later)
            fail(
              "you already joined a later turn's window",
              409,
              "later_window",
            );
          replayPositionMs = input.replayPositionMs;
        }
        // F14: debaters may not take a position in their own debate.
        if (
          (
            await client.query(
              `SELECT 1 FROM debates d JOIN public_profiles p
                ON p.id IN (d.speaker_a_profile_id,d.speaker_b_profile_id)
              WHERE d.id=$1 AND p.user_id=$2`,
              [round.debate_id, context.userId],
            )
          ).rowCount
        )
          fail(
            "debaters cannot take a position in their own debate",
            403,
            "debater",
          );
        if (
          !(
            await client.query(
              "SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published' AND d.status NOT IN ('cancelled','void_review')",
              [round.debate_id],
            )
          ).rowCount
        )
          fail(
            "debate unavailable for new commitments",
            409,
            "debate_unavailable",
          );
        if (
          (
            await client.query(
              "SELECT 1 FROM coin_debate_orders WHERE round_id=$1 AND user_id=$2",
              [roundId, context.userId],
            )
          ).rowCount
        )
          fail("your first commitment is final", 409, "already_answered");
        if (
          Number(
            (
              await client.query<{ count: string }>(
                "SELECT count(*)::text FROM coin_debate_orders WHERE round_id=$1",
                [roundId],
              )
            ).rows[0]!.count,
          ) >= round.terms.capacity
        )
          fail("sandbox round is full", 409, "window_full");
        const before = await lockSandboxBook(client, context.userId),
          buckets = await ensureSandboxBuckets(client, context.userId);
        await lockLedger(client, [buckets]);
        // This transaction now holds every ledger row it can touch, so these
        // balances stay put until it commits.
        const balance = async (...ids: string[]) =>
          (
            await client.query<{ total: string }>(
              "SELECT COALESCE(sum(balance),0)::text AS total FROM coin_accounts WHERE id=ANY($1::uuid[])",
              [ids],
            )
          ).rows[0]!.total;
        const collateral = BigInt(order.quantity) * COIN_DEBATE_FACE;
        // The center (and, for grant coins, the promotional treasury) backs
        // every contract. When the operator's seed runs low, say so plainly
        // instead of the ledger's generic refusal (docs/coin-sandbox-operations.md).
        const paused = () =>
          fail(
            "answers are paused while Yap Coins are topped up; nothing was reserved",
            503,
            "answers_paused",
          );
        if (BigInt(await balance(buckets.system.center_available)) < collateral)
          paused();
        let plan: ReturnType<typeof planStake>;
        try {
          plan = planStake(
            before.book,
            String(
              reservation(order.quantity, COIN_DEBATE_FACE, round.terms.feeBps),
            ),
          );
        } catch (error) {
          if (!(error instanceof CoinOperationError)) throw error;
          // The caller's own shortfall, with their own available balance.
          fail(
            "insufficient Yap Coins for this stake",
            409,
            "insufficient_balance",
            {
              available: await balance(
                buckets.cashAvailable,
                buckets.promoAvailable,
              ),
            },
          );
        }
        const total = fundingTotals(plan.funding);
        const promotional = plan.funding.sources.some((s) => s.kind === "grant")
          ? collateral
          : 0n;
        if (
          promotional &&
          BigInt(await balance(buckets.system.promotional_available)) <
            promotional
        )
          paused();
        const cash: CoinPosting[] = [],
          promo: CoinPosting[] = [];
        transfer(cash, buckets.cashAvailable, buckets.cashReserved, total.cash);
        transfer(
          cash,
          buckets.system.center_available,
          buckets.system.center_reserved,
          collateral,
        );
        transfer(
          cash,
          buckets.system.promotional_available,
          buckets.system.promotional_reserved,
          promotional,
        );
        transfer(
          promo,
          buckets.promoAvailable,
          buckets.promoReserved,
          total.promo,
        );
        const requestId = randomUUID();
        const cashJournalId = await post(
          client,
          context.userId,
          "reserve",
          requestId,
          "USDC",
          cash,
        );
        const promoJournalId = await post(
          client,
          context.userId,
          "reserve",
          requestId,
          "YC_PROMO",
          promo,
        );
        await client.query(
          `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status) VALUES($1,$2,'stake',$3,$4,$5::jsonb,'reserved')`,
          [requestId, context.userId, key, termsDigest, JSON.stringify(terms)],
        );
        // A live order's turn window must still belong to a live debate after
        // every lock wait; the order guard checks only the cutoff.
        if (
          replayPositionMs === null &&
          !(
            await client.query<{ accepting: boolean }>(
              `SELECT ${liveAccepting("r", "d")} AS accepting
              FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id WHERE r.id=$1`,
              [round.id],
            )
          ).rows[0]!.accepting
        )
          fail("this turn's window closed", 409, "window_closed");
        // DB cutoff is checked AFTER ledger-lock waits and immediately at
        // insert. A submit that loses that race reserves nothing: the guard's
        // refusal rolls the whole transaction back.
        await client
          .query(
            `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,funding,center_reservation,promotional_reservation,replay_position_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
            [
              roundId,
              context.userId,
              requestId,
              order.side,
              order.limit,
              order.quantity,
              JSON.stringify(plan.funding),
              String(collateral),
              String(promotional),
              replayPositionMs,
            ],
          )
          .catch((error: unknown) => {
            const refusal = guardRefusal(error);
            if (refusal) fail(refusal.message, refusal.status, refusal.code);
            throw error;
          });
        await appendSandboxBookEvent(client, {
          userId: context.userId,
          snapshot: before,
          book: plan.book,
          kind: "debate.reserved",
          reference: key,
          termsDigest,
          requestId,
          cashJournalId,
          promoJournalId,
          metadata: {
            roundId,
            funding: plan.funding,
            centerReservation: String(collateral),
            promotionalReservation: String(promotional),
            rail,
            ...(replayPositionMs === null ? {} : { replayPositionMs }),
          },
        });
        await assertActiveSession(
          client,
          context.userId,
          context.sessionTokenHash,
        );
        return { id: requestId, created: true };
      });
    },
    // A read: no round, account or ledger lock, so viewers refreshing at a
    // window boundary never wait behind admissions or settlement.
    async view(context: SandboxContext, debateId: string) {
      resource(debateId);
      return transaction(async (client) => {
        await assertCallerSession(client, context);
        const rounds = (
          await client.query<
            Round & {
              participants: number;
              accepting: boolean;
              reveal_at: Date | null;
              recording: RecordingSpan | null;
              replayable: boolean;
              later: boolean;
            }
          >(
            `SELECT r.*, ${liveAccepting("r", "d")} AS accepting,
              (SELECT count(*)::int FROM coin_debate_orders o WHERE o.round_id=r.id) AS participants,
              ${revealAt("r", "d")} AS reveal_at, ${recordingSpan("r", "c")} AS recording,
              ${replayable("r", "d", "c")} AS replayable,
              ${laterWindowJoined("r", "$3::bigint")} AS later
            FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
            LEFT JOIN recording_clocks c ON c.debate_id=r.debate_id
            WHERE r.debate_id=$1 AND r.rail=$2 ORDER BY r.opens_at DESC,r.id LIMIT 20`,
            [debateId, rail, context.userId],
          )
        ).rows;
        // The viewer's standing in this debate, for each round's eligibility.
        const standing = (
          await client.query<{
            available: boolean;
            debater: boolean;
            paused: boolean;
          }>(
            `SELECT d.publication_state='published' AND t.publication_state='published'
                AND d.status NOT IN ${unavailableStatuses} AS available,
              EXISTS (SELECT 1 FROM public_profiles p
                WHERE p.id IN (d.speaker_a_profile_id,d.speaker_b_profile_id) AND p.user_id=$2) AS debater,
              EXISTS (SELECT 1 FROM coin_sandbox_requests q WHERE q.user_id=$2
                AND q.kind='correction' AND q.status='uncertain') AS paused
            FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1`,
            [debateId, context.userId],
          )
        ).rows[0] ?? { available: false, debater: false, paused: false };
        return Promise.all(
          rounds.map(async (r) => {
            const own = (
              await client.query<StoredOrder>(
                "SELECT * FROM coin_debate_orders WHERE round_id=$1 AND user_id=$2",
                [r.id, context.userId],
              )
            ).rows[0];
            const outcome = r.result?.outcomes.find(
              (o) => o.participant === context.userId,
            );
            // Live until the cutoff; then, for a five-day turn window,
            // replay viewers at its position until the 120-hour close (F10).
            const via =
              r.state === "open" && r.accepting
                ? "live"
                : r.replayable
                  ? "replay"
                  : null;
            const ineligible: Ineligibility | null = standing.debater
              ? "debater"
              : own
                ? "committed"
                : !standing.available
                  ? "debate_unavailable"
                  : !via
                    ? "closed"
                    : via === "replay" && r.later
                      ? "later_window"
                      : standing.paused
                        ? "paused"
                        : r.participants >= r.terms.capacity
                          ? "full"
                          : null;
            return {
              id: r.id,
              debateId: r.debate_id,
              proposition: r.proposition,
              // A turn window belongs to one speaking turn (Decision 0012);
              // a manual round has no turn.
              kind: r.turn_number === null ? "manual" : "turn",
              turnNumber: r.turn_number,
              side: r.turn_side,
              state: r.state,
              voidReason:
                r.state === "void" ? (r.result?.voidReason ?? null) : null,
              opensAt: r.opens_at,
              closesAt: r.closes_at,
              // F11: when this round prices and settles; null for a five-day
              // round until its debate ends.
              revealMode: r.reveal_mode,
              revealAt: r.reveal_at,
              // F12: everyone who committed, never a side total.
              participants: r.participants,
              // F14 and the round's limits: can this viewer take a position?
              eligibility: {
                canTakePosition: ineligible === null,
                reason: ineligible,
                via: ineligible === null ? via : null,
              },
              // F10: where this turn's window plays in the recording.
              recording: r.recording,
              terms: r.terms,
              asset: "USDC",
              precision: 6,
              face: String(COIN_DEBATE_FACE),
              seedCommitment: r.seed_commitment,
              own: own
                ? {
                    side: own.side,
                    limit: own.limit_value,
                    quantity: own.quantity,
                    requestId: own.request_id,
                    replayPositionMs: own.replay_position_ms,
                  }
                : null,
              ...(r.state === "settled"
                ? {
                    seed: r.seed,
                    snapshotHash: r.result?.snapshotHash,
                    pricing: r.result?.pricing,
                    outcome,
                  }
                : {}),
            };
          }),
        );
      });
    },
    // The worker's settlement step (and the sandbox's explicit
    // POST /settlements). Each round settles in its own savepoint: one that
    // throws is rolled back, set aside with a growing retry delay and logged,
    // and the rest of the batch still settles. A timeout fails the batch,
    // which the next tick retries.
    async advance(limit = batch.rounds, context?: SandboxContext) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        fail("invalid transition batch", 400);
      const failed: { roundId: string; error: unknown }[] = [];
      const started = performance.now();
      let settledOrders = 0;
      const result = await transaction(
        async (client) => {
          const due = await dueBatch(
            client,
            limit,
            context ? { context } : undefined,
          );
          let completed = 0;
          const deadline =
            started + (due[0]?.quiet ? batch.quietBudgetMs : batch.budgetMs);
          for (const [position, r] of due.entries()) {
            if (position > 0 && performance.now() > deadline) break;
            await client.query("SAVEPOINT coin_round");
            try {
              const done = await settle(
                client,
                r.id,
                r.users,
                deadline,
                r.buckets,
              );
              if (done.revealed) completed++;
              settledOrders += done.settled;
              await client.query("RELEASE SAVEPOINT coin_round");
            } catch (error) {
              if (databaseFailure(error) === "busy") throw error;
              await client.query("ROLLBACK TO SAVEPOINT coin_round");
              await client.query("RELEASE SAVEPOINT coin_round");
              failed.push({ roundId: r.id, error });
            }
          }
          if (context) await assertCallerSession(client, context);
          return { completed };
        },
        context ? requestLimits : workerLimits,
      );
      // Keep the next batch's size to what fits its time budget here.
      if (settledOrders)
        perOrderMs =
          (perOrderMs + (performance.now() - started) / settledOrders) / 2;
      const now = Date.now();
      for (const { roundId, error } of failed) {
        const failures = (setAside.get(roundId)?.failures ?? 0) + 1;
        const delay = Math.min(
          setAsideMaxMs,
          setAsideBaseMs * 2 ** (failures - 1),
        );
        setAside.set(roundId, { failures, retryAt: now + delay });
        options.logger?.error(
          { roundId, failures, retryInSeconds: delay / 1000, error },
          "coin round settlement failed; round set aside",
        );
      }
      return { ...result, setAside: failed.map(({ roundId }) => roundId) };
    },
    // Debates still live well past their maximum duration (rules snapshot,
    // default 2 hours) plus 30 minutes of pauses: their windows never reveal
    // and keep every reservation until someone ends them.
    async overdueLive() {
      return (
        await database.query<{
          debateId: string;
          liveStartedAt: Date;
          maximumSeconds: number;
        }>(
          `SELECT id AS "debateId", live_started_at AS "liveStartedAt", maximum AS "maximumSeconds"
          FROM (SELECT d.id,d.live_started_at,
              CASE WHEN d.rules_snapshot->>'maximum_duration_seconds' ~ '^[0-9]{1,6}$'
                THEN (d.rules_snapshot->>'maximum_duration_seconds')::int ELSE 7200 END AS maximum
            FROM debates d WHERE d.status='live' AND d.live_started_at IS NOT NULL) live
          WHERE live_started_at+make_interval(secs=>maximum)+INTERVAL '30 minutes'<clock_timestamp()
          ORDER BY live_started_at,id LIMIT 20`,
        )
      ).rows;
    },
    // Explicit operator command only, never startup/reset behavior or a public
    // cancellation API. Exact sources return without profit or qualification.
    async voidRound(
      roundId: string,
      reason: "debate_unavailable" | "operator_cancelled",
    ) {
      resource(roundId);
      if (!["debate_unavailable", "operator_cancelled"].includes(reason))
        fail("invalid void reason", 400);
      return transaction(async (client) => {
        if (
          (await client.query<{ role: string }>("SELECT current_user AS role"))
            .rows[0]?.role !== "yaparena_owner"
        )
          fail("sandbox operator ownership is required", 403);
        return voidOpen(client, roundId, reason, "yaparena_owner");
      }, workerLimits);
    },
    // F11: the owner records per-round reveal for a founder-created debate,
    // before its first round. User-created debates keep the five-day default.
    async setRevealMode(debateId: string, mode: RevealMode, reason: string) {
      resource(debateId);
      if (mode !== "five_day" && mode !== "per_round")
        fail("invalid reveal mode", 400);
      const why = reason.trim();
      if (why.length < 5 || why.length > 500)
        fail("reason must be 5-500 characters", 400);
      return transaction(async (client) => {
        if (
          (await client.query<{ role: string }>("SELECT current_user AS role"))
            .rows[0]?.role !== "yaparena_owner"
        )
          fail("sandbox operator ownership is required", 403);
        await lockDebateOpening(client, debateId);
        const recorded = (
          await client.query<{ mode: RevealMode }>(
            "SELECT mode FROM coin_debate_reveal_modes WHERE debate_id=$1",
            [debateId],
          )
        ).rows[0];
        if (recorded) {
          if (recorded.mode !== mode)
            fail("this debate's reveal mode is already recorded");
          return { created: false };
        }
        if (
          !(await client.query("SELECT 1 FROM debates WHERE id=$1", [debateId]))
            .rowCount
        )
          fail("debate not found", 404);
        if (
          (
            await client.query(
              "SELECT 1 FROM coin_debate_rounds WHERE debate_id=$1 LIMIT 1",
              [debateId],
            )
          ).rowCount
        )
          fail("the reveal mode is locked once a round opens");
        await client.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,$2,$3)",
          [debateId, mode, why],
        );
        return { created: true };
      }, workerLimits);
    },
    // Coin loop: refund every open round of a cancelled or under-review debate
    // (F15: only unopened rounds can be voided). The database lets the runtime
    // void only these, with reason debate_unavailable. One transaction each.
    async voidUnavailable(limit = 20, debateIds?: readonly string[]) {
      const due = (
        await database.query<{ id: string }>(
          `SELECT r.id FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
          WHERE r.state='open' AND r.rail=$1 AND d.status IN ${unavailableStatuses}
            AND NOT ${settlementStarted("r")}
            AND ($3::uuid[] IS NULL OR r.debate_id=ANY($3::uuid[]))
          ORDER BY r.closes_at,r.id LIMIT $2`,
          [rail, limit, debateIds ?? null],
        )
      ).rows;
      let voided = 0;
      for (const { id } of due) {
        const result = await transaction(async (client) => {
          const current = (
            await client.query<{ role: string }>(
              `SELECT current_user AS role FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
              WHERE r.id=$1 AND r.state='open' AND d.status IN ${unavailableStatuses}
                AND NOT ${settlementStarted("r")}`,
              [id],
            )
          ).rows[0];
          return current
            ? voidOpen(client, id, "debate_unavailable", current.role)
            : { created: false };
        }, workerLimits);
        if (result.created) voided++;
      }
      return { voided };
    },
    // The treasuries that back every stake (founder D1), for the worker's
    // low-balance warning and /metrics. A plain read without locks; zero
    // before the sandbox's system accounts exist.
    async treasury(): Promise<TreasuryBalances> {
      const rows = (
        await database.query<{ purpose: string; balance: string }>(
          `SELECT s.purpose,a.balance::text AS balance FROM coin_sandbox_system_accounts s
          JOIN coin_accounts a ON a.id=s.account_id
          WHERE s.purpose IN ('center_available','promotional_available')`,
        )
      ).rows;
      const available = (purpose: string) =>
        rows.find((row) => row.purpose === purpose)?.balance ?? "0";
      return {
        centerAvailable: available("center_available"),
        promotionalAvailable: available("promotional_available"),
      };
    },
    // Coin loop: open the current turn's window of each live debate that has
    // none yet, at most one second after the turn starts (Decision 0012).
    async openTurnWindows(limit = 20, debateIds?: readonly string[]) {
      if (!turnWindows) return { opened: 0 };
      const due = (
        await database.query<{ debateId: string }>(
          `SELECT m.debate_id AS "debateId" FROM debate_media m JOIN debates d ON d.id=m.debate_id
          WHERE m.state='running' AND d.status='live'
            AND m.turn_deadline_at>clock_timestamp()+INTERVAL '1 second'
            AND ($2::uuid[] IS NULL OR m.debate_id=ANY($2::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM coin_debate_rounds r
              WHERE r.debate_id=m.debate_id AND r.turn_number=m.turn_number)
          ORDER BY m.turn_deadline_at,m.debate_id LIMIT $1`,
          [limit, debateIds ?? null],
        )
      ).rows;
      let opened = 0;
      for (const { debateId } of due)
        if (
          await transaction(
            (client) => openWindow(client, debateId),
            workerLimits,
          )
        )
          opened++;
      return { opened };
    },
    // Public window timing for every viewer: no orders, counts, prices or
    // seeds. Null when the debate or its topic is not published.
    /**
     * Interface 10: the viewer's own rounds revealed (settled) or voided
     * after `since`, newest first, across debates. Private to the viewer.
     */
    async results(context: SandboxContext, since: Date) {
      return transaction(async (client) => {
        await assertCallerSession(client, context);
        const rows = (
          await client.query<{
            roundId: string;
            debateId: string;
            slug: string;
            proposition: string;
            turnNumber: number | null;
            turnSide: "A" | "B" | null;
            state: "settled" | "void";
            voidReason: VoidReason | null;
            side: Order["side"];
            quantity: number;
            outcome: Record<string, unknown> | null;
            revealedAt: Date;
          }>(
            `SELECT r.id AS "roundId", r.debate_id AS "debateId", d.slug, r.proposition,
              r.turn_number AS "turnNumber", r.turn_side AS "turnSide", r.state,
              CASE WHEN r.state='void' THEN r.result->>'voidReason' END AS "voidReason",
              o.side, o.quantity,
              (SELECT x FROM jsonb_array_elements(r.result->'outcomes') x
                WHERE x->>'participant'=o.user_id::text LIMIT 1) AS outcome,
              r.revealed_at AS "revealedAt"
            FROM coin_sandbox_requests q
            JOIN coin_debate_orders o ON o.request_id=q.id AND o.user_id=q.user_id
            JOIN coin_debate_rounds r ON r.id=o.round_id
            JOIN debates d ON d.id=r.debate_id
            WHERE q.user_id=$1 AND q.kind='stake' AND r.rail=$2
              AND r.state IN ('settled','void') AND r.revealed_at>$3
            ORDER BY r.revealed_at DESC, r.id LIMIT $4`,
            [context.userId, rail, since, RESULTS_LIMIT],
          )
        ).rows;
        return {
          serverNow: new Date(),
          results: rows.map(({ outcome, ...row }) => ({
            ...row,
            outcome: outcome
              ? {
                  status: String(outcome.status),
                  premium: String(outcome.premium),
                  fee: String(outcome.fee),
                  payout: String(outcome.payout),
                  net: String(outcome.net),
                }
              : null,
          })),
        };
      });
    },
    async publicWindows(debateId: string) {
      resource(debateId);
      const row = (
        await database.query<{
          eventStatus: string;
          serverNow: Date;
          revealMode: RevealMode;
          revealAt: Date | null;
          windows: TurnWindow[];
        }>(
          `SELECT d.status AS "eventStatus", clock_timestamp() AS "serverNow",
            COALESCE(m.mode,'five_day') AS "revealMode",
            CASE WHEN COALESCE(m.mode,'five_day')='five_day' AND d.status IN ${endedStatuses}
              THEN d.live_ended_at+INTERVAL '${REVEAL_CLOSE_HOURS} hours' END AS "revealAt",
            COALESCE((SELECT json_agg(json_build_object('id',w.id,'turnNumber',w.turn_number,
              'side',w.turn_side,'opensAt',w.opens_at,'closesAt',w.closes_at,'state',w.state,
              'voidReason',CASE WHEN w.state='void' THEN w.result->>'voidReason' END,
              'revealMode',w.reveal_mode,'revealAt',${revealAt("w", "d")},
              'recording',${recordingSpan("w", "c")},
              'pricing',CASE WHEN w.state='settled' AND w.revealed_at<=clock_timestamp()
                THEN w.result->'pricing' END)
              ORDER BY w.turn_number)
            FROM (SELECT * FROM coin_debate_rounds r WHERE r.debate_id=d.id AND r.rail=$2
              AND r.turn_number IS NOT NULL ORDER BY r.turn_number DESC LIMIT 100) w),
              '[]'::json) AS windows
          FROM debates d JOIN topics t ON t.id=d.topic_id
          LEFT JOIN coin_debate_reveal_modes m ON m.debate_id=d.id
          LEFT JOIN recording_clocks c ON c.debate_id=d.id
          WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
          [debateId, rail],
        )
      ).rows[0];
      return row ? { debateId, ...row } : null;
    },
    // The coin loop's one-second step: void unavailable debates' rounds, settle
    // due rounds, then open turn windows. Each step runs in its own
    // transactions, so one failure does not hold back the others.
    async tick() {
      const failures: unknown[] = [];
      async function step<T>(work: () => Promise<T>) {
        try {
          return await work();
        } catch (error) {
          failures.push(error);
          return undefined;
        }
      }
      const voided = await step(() => api.voidUnavailable());
      // Open the new turn's window before settling, so a large reveal never
      // delays it; then settle one batch. One batch a second leaves the rest
      // of each second to the submits that share the treasury rows.
      const opened = await step(() => api.openTurnWindows());
      const settled = await step(() => api.advance());
      const completed = settled?.completed ?? 0;
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "coin debate tick failed");
      return {
        voided: voided?.voided ?? 0,
        completed,
        opened: opened?.opened ?? 0,
      };
    },
  });
  return api;
}
