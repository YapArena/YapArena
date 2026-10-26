import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
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
  assertSandboxRail,
  assertSandboxFinancialOpen,
  assertSandboxOpened,
  type SandboxContext,
  type SandboxRail,
  type SandboxBuckets,
} from "./sandbox-repository.ts";

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
  "debater" | "committed" | "debate_unavailable" | "paused" | "closed" | "full";
// A debate in one of these states takes no new commitments, and the coin loop
// voids its open rounds instead of settling them (F15: only unopened rounds).
const unavailableStatuses = "('cancelled','void_review')";
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
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reference = (userId: string, operation: string, key: string) =>
  coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
function fail(message: string, status = 409): never {
  throw new CoinOperationError(message, status);
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
async function lockLedger(
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
async function serial(client: PoolClient) {
  // Low-volume sandbox only. Admissions and settlement serialize before account
  // locks; this prevents settlement taking a partial population while enrolling.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('coin-debate-transition',0))",
  );
}
export function createCoinDebateSandbox(
  database: Pool,
  rail: SandboxRail,
  options: { turnWindows?: boolean } = {},
) {
  const turnWindows = options.turnWindows === true;
  async function transaction<T>(mutation: (client: PoolClient) => Promise<T>) {
    return withTransaction(database, async (client) => {
      await serial(client);
      await assertSandboxRail(client, rail);
      return mutation(client);
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
      fail("account context changed; refresh balances and review again");
  }
  async function authorize(client: PoolClient, context: SandboxContext) {
    if (!(await lockAccount(client, context.userId)))
      throw new SessionUnavailableError("account unavailable");
    await assertCallerSession(client, context);
    await assertSandboxOpened(client, context.userId);
    await assertSandboxFinancialOpen(client, context.userId);
  }
  async function stored(client: PoolClient, roundId: string) {
    resource(roundId);
    const round = (
      await client.query<Round>(
        "SELECT * FROM coin_debate_rounds WHERE id=$1 AND rail=$2 FOR UPDATE",
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
    const rounds = (
      await client.query<{ id: string }>(
        `SELECT r.id FROM coin_debate_rounds r WHERE r.state='open' AND r.rail=$1
        AND r.closes_at<=clock_timestamp() AND ${revealDue("r")} AND NOT EXISTS (SELECT 1 FROM debates d
          WHERE d.id=r.debate_id AND d.status IN ${unavailableStatuses})
        ORDER BY r.closes_at,r.id LIMIT $2`,
        [rail, limit],
      )
    ).rows;
    const participants = (
      await client.query<{ user_id: string }>(
        "SELECT DISTINCT user_id FROM coin_debate_orders WHERE round_id=ANY($1::uuid[]) ORDER BY user_id",
        [rounds.map((r) => r.id)],
      )
    ).rows.map((r) => r.user_id);
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
    const buckets = [];
    for (const userId of users) {
      await lockSandboxBook(client, userId);
      buckets.push(await ensureSandboxBuckets(client, userId));
    }
    await lockLedger(client, buckets);
    return rounds;
  }
  async function settle(client: PoolClient, roundId: string) {
    // The transition lock prevents new admissions while collecting account locks.
    const orders = (
      await client.query<StoredOrder>(
        "SELECT * FROM coin_debate_orders WHERE round_id=$1 ORDER BY user_id",
        [roundId],
      )
    ).rows;
    await client.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [orders.map((o) => o.user_id)],
    );
    const round = await stored(client, roundId);
    if (round.state !== "open") return false;
    const due = (
      await client.query<{ due: boolean }>(
        `SELECT clock_timestamp()>=r.closes_at AND ${revealDue("r")} AS due
        FROM coin_debate_rounds r WHERE r.id=$1`,
        [round.id],
      )
    ).rows[0]!.due;
    if (!due) return false;
    const snapshot: Order[] = orders.map((o) => ({
      participant: o.user_id,
      kind: "human",
      side: o.side,
      limit: o.limit_value,
      quantity: o.quantity,
    }));
    if (digest(round.seed) !== round.seed_commitment)
      fail("sandbox seed commitment mismatch", 503);
    const pricing = priceRound(
      snapshot,
      round.terms,
      randomWord(round.seed, "branch"),
      randomWord(round.seed, "price"),
    );
    const outcomes = executeRound(
      snapshot,
      round.terms,
      pricing,
      COIN_DEBATE_FACE,
    );
    const snapshots = await Promise.all(
      orders.map((o) => lockSandboxBook(client, o.user_id)),
    );
    const buckets = [];
    for (const order of orders)
      buckets.push(await ensureSandboxBuckets(client, order.user_id));
    await lockLedger(client, buckets);
    const now = (
      await client.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now.toISOString();
    for (let index = 0; index < orders.length; index++) {
      const order = orders[index]!,
        outcome = outcomes[index]!,
        before = snapshots[index]!,
        bucket = buckets[index]!;
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
    return true;
  }
  // Opens the current speaking turn's trading window of one live debate, at
  // most once per turn (Decision 0012). Its cutoff is the turn deadline copied
  // from debate_media and never moves, even if the turn is paused later.
  // Plain reads only: no debate or media row lock, so opening never waits
  // behind the media clock or a lifecycle transition, and the room counter is
  // still the last lock, at COMMIT (docs/community-delivery.md). A turn the
  // clock already advanced inserts nothing.
  async function openWindow(client: PoolClient, debateId: string) {
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
  // qualification. The caller holds the transition lock (no new admissions).
  async function voidOpen(
    client: PoolClient,
    roundId: string,
    reason: VoidReason,
    actorRole: string,
  ) {
    const orders = (
      await client.query<StoredOrder>(
        "SELECT * FROM coin_debate_orders WHERE round_id=$1 ORDER BY user_id",
        [roundId],
      )
    ).rows;
    await client.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [orders.map((o) => o.user_id)],
    );
    const round = await stored(client, roundId);
    if (round.state === "void") return { created: false };
    if (round.state !== "open") fail("settled obligations cannot be voided");
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
      return transaction(async (client) => {
        const due = await dueBatch(client, 20, { context });
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
        // Posted net profit and its permanent qualification peak follow round
        // closing order, with UUID as the fixed tie-breaker. API request timing
        // cannot settle a selected later round ahead of this bounded batch.
        for (const round of due) await settle(client, round.id);
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
            );
          await assertCallerSession(client, context);
          return window;
        }
        // A five-day manual round stays open after its cutoff until the
        // debate's 120-hour close; only one still taking orders is current.
        const current = (
          await client.query<{ id: string }>(
            `SELECT id FROM coin_debate_rounds WHERE debate_id=$1 AND state='open' AND turn_number IS NULL
            AND (reveal_mode='per_round' OR closes_at>clock_timestamp())
            ORDER BY opens_at DESC,id LIMIT 1`,
            [debateId],
          )
        ).rows[0];
        if (current) {
          // If a due target was beyond this batch, leave it open for the next
          // ordered advance. Never jump older obligations to open its successor.
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
      input: { side: Order["side"]; limit: string; quantity: number },
    ) {
      resource(roundId);
      const key = reference(context.userId, "debate.submit", idempotencyKey);
      return transaction(async (client) => {
        await authorize(client, context);
        const round = await stored(client, roundId);
        const order: Order = {
          participant: context.userId,
          kind: "human",
          ...input,
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
            fail("idempotency key has different participation terms");
          return { id: existing.id, created: false };
        }
        if (round.state !== "open") fail("sandbox round is closed");
        // A five-day round stays open after its cutoff, until its reveal.
        if (
          !(
            await client.query<{ accepting: boolean }>(
              "SELECT clock_timestamp()<closes_at AS accepting FROM coin_debate_rounds WHERE id=$1",
              [round.id],
            )
          ).rows[0]!.accepting
        )
          fail("sandbox debate is past cutoff");
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
          fail("debaters cannot take a position in their own debate", 403);
        if (
          !(
            await client.query(
              "SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published' AND d.status NOT IN ('cancelled','void_review')",
              [round.debate_id],
            )
          ).rowCount
        )
          fail("debate unavailable for new commitments");
        if (
          (
            await client.query(
              "SELECT 1 FROM coin_debate_orders WHERE round_id=$1 AND user_id=$2",
              [roundId, context.userId],
            )
          ).rowCount
        )
          fail("your first commitment is final");
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
          fail("sandbox round is full");
        const before = await lockSandboxBook(client, context.userId),
          buckets = await ensureSandboxBuckets(client, context.userId);
        await lockLedger(client, [buckets]);
        const plan = planStake(
          before.book,
          String(
            reservation(order.quantity, COIN_DEBATE_FACE, round.terms.feeBps),
          ),
        );
        const total = fundingTotals(plan.funding),
          collateral = BigInt(order.quantity) * COIN_DEBATE_FACE;
        const promotional = plan.funding.sources.some((s) => s.kind === "grant")
          ? collateral
          : 0n;
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
        // DB cutoff is checked AFTER ledger-lock waits and immediately at insert.
        await client.query(
          `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,funding,center_reservation,promotional_reservation)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
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
          ],
        );
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
    async view(context: SandboxContext, debateId: string) {
      resource(debateId);
      return transaction(async (client) => {
        if (!(await lockAccount(client, context.userId)))
          throw new SessionUnavailableError("account unavailable");
        await assertActiveSession(
          client,
          context.userId,
          context.sessionTokenHash,
        );
        const rounds = (
          await client.query<
            Round & {
              participants: number;
              accepting: boolean;
              reveal_at: Date | null;
            }
          >(
            `SELECT r.*, clock_timestamp()<r.closes_at AS accepting,
              (SELECT count(*)::int FROM coin_debate_orders o WHERE o.round_id=r.id) AS participants,
              ${revealAt("r", "d")} AS reveal_at
            FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
            WHERE r.debate_id=$1 AND r.rail=$2 ORDER BY r.opens_at DESC,r.id LIMIT 20`,
            [debateId, rail],
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
            const ineligible: Ineligibility | null = standing.debater
              ? "debater"
              : own
                ? "committed"
                : !standing.available
                  ? "debate_unavailable"
                  : r.state !== "open" || !r.accepting
                    ? "closed"
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
              },
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
    async advance(limit = 20, context?: SandboxContext) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        fail("invalid transition batch", 400);
      return transaction(async (client) => {
        const due = await dueBatch(
          client,
          limit,
          context ? { context } : undefined,
        );
        let completed = 0;
        for (const r of due) if (await settle(client, r.id)) completed++;
        if (context) await assertCallerSession(client, context);
        return { completed };
      });
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
      });
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
      });
    },
    // Coin loop: refund every open round of a cancelled or under-review debate
    // (F15: only unopened rounds can be voided). The database lets the runtime
    // void only these, with reason debate_unavailable. One transaction each.
    async voidUnavailable(limit = 20, debateIds?: readonly string[]) {
      const due = (
        await database.query<{ id: string }>(
          `SELECT r.id FROM coin_debate_rounds r JOIN debates d ON d.id=r.debate_id
          WHERE r.state='open' AND r.rail=$1 AND d.status IN ${unavailableStatuses}
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
              WHERE r.id=$1 AND r.state='open' AND d.status IN ${unavailableStatuses}`,
              [id],
            )
          ).rows[0];
          return current
            ? voidOpen(client, id, "debate_unavailable", current.role)
            : { created: false };
        });
        if (result.created) voided++;
      }
      return { voided };
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
        if (await transaction((client) => openWindow(client, debateId)))
          opened++;
      return { opened };
    },
    // Public window timing for every viewer: no orders, counts, prices or
    // seeds. Null when the debate or its topic is not published.
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
              'revealMode',w.reveal_mode,'revealAt',${revealAt("w", "d")})
              ORDER BY w.turn_number)
            FROM (SELECT * FROM coin_debate_rounds r WHERE r.debate_id=d.id AND r.rail=$2
              AND r.turn_number IS NOT NULL ORDER BY r.turn_number DESC LIMIT 100) w),
              '[]'::json) AS windows
          FROM debates d JOIN topics t ON t.id=d.topic_id
          LEFT JOIN coin_debate_reveal_modes m ON m.debate_id=d.id
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
      const settled = await step(() => api.advance());
      const opened = await step(() => api.openTurnWindows());
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "coin debate tick failed");
      return {
        voided: voided?.voided ?? 0,
        completed: settled?.completed ?? 0,
        opened: opened?.opened ?? 0,
      };
    },
  });
  return api;
}
