import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { CoinOperationError } from "../account-wallet/external-operations.ts";
import {
  commitStakeCost,
  planStake,
  refundStake,
  type GrantAccountingBook,
  type StakeFunding,
} from "../account-wallet/grant-accounting.ts";
import {
  coinJournalReference,
  postCoinJournal,
  type CoinLedgerAsset,
  type CoinPosting,
} from "../account-wallet/ledger.ts";
import {
  appendSandboxBookEvent,
  ensureSandboxBuckets,
  lockSandboxBooks,
  type SandboxBookSnapshot,
  type SandboxBuckets,
  type SandboxRail,
} from "../account-wallet/sandbox-repository.ts";
import { lockLedger } from "../account-wallet/debate-sandbox.ts";
import { splitToDebaters, type Side } from "./rules.ts";

// Decision 0018: the mic's Yap Coins on the coin ledger, shared by question
// pledges (PR 2a) and keep-the-asker-on pledges (PR 3).
//
// Every pledge is a hold: the pledger's own available Yap Coins move to their
// own reserved accounts, grant coins first, exactly as a debate stake reserves
// them. A refund reverses the hold to the same sources. A payment spends the
// holds: cash-backed coins go to the two seated debaters, grant coins are
// burned to the grant issuer and the center treasury pays the debaters the
// same amount, so the debaters receive everything as cash-backed Yap Coins,
// in equal halves (L15, founder 2026-11-23).
//
// Callers lock the books (ascending account id), their buckets and then every
// ledger account they can touch (lockMoney) before the first journal, after
// the mic row that decides the write (a list or a fund).

/** A held pledge as the ledger needs it, from mic_pledges or mic_fund_pledges. */
export interface HeldPledge {
  id: string;
  user_id: string;
  amount: string;
  funding: StakeFunding;
}
export type Books = Map<string, SandboxBookSnapshot>;
export type Buckets = Map<string, SandboxBuckets>;

export const reference = (userId: string, operation: string, key: string) =>
  coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byAccount = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

// The grant and cash parts of a hold, as debate stakes split them (a grant's
// principal is grant coins; its profit and purchases are cash-backed).
export function fundingTotals(funding: StakeFunding) {
  let cash = 0n,
    promo = 0n;
  for (const source of funding.sources) {
    if (source.kind === "grant") {
      promo += BigInt(source.principal);
      cash += BigInt(source.profit);
    } else cash += BigInt(source.amount);
  }
  return { cash, promo };
}
function move(postings: CoinPosting[], accountId: string, amount: bigint) {
  if (amount) postings.push({ accountId, amount: String(amount) });
}
function transfer(
  postings: CoinPosting[],
  from: string,
  to: string,
  amount: bigint,
) {
  move(postings, from, -amount);
  move(postings, to, amount);
}
async function post(
  client: PoolClient,
  userId: string,
  operation: "reserve" | "release" | "payout",
  step: string,
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
      reference: reference(userId, `mic.${step}.${asset.toLowerCase()}`, key),
      postings,
    })
  ).id;
}
// The book after an appended event: the event's trigger bumps the version.
const advanced = (
  snapshot: SandboxBookSnapshot,
  book: GrantAccountingBook,
): SandboxBookSnapshot => ({
  book,
  version: String(BigInt(snapshot.version) + 1n),
});

/** Books in ascending account order, then their buckets, then the ledger. */
export async function lockMoney(
  client: PoolClient,
  accounts: readonly string[],
) {
  const ids = [...new Set(accounts)].sort(byAccount);
  const books: Books = await lockSandboxBooks(client, ids);
  const buckets: Buckets = new Map();
  for (const id of ids) buckets.set(id, await ensureSandboxBuckets(client, id));
  await lockLedger(client, [...buckets.values()]);
  return { books, buckets };
}

export function createMicMoney(rail: SandboxRail) {
  /**
   * A pledge's hold: available to reserved, on the pledger's own accounts.
   * record inserts the pledge's own row with the funding the hold used.
   * scope names what the pledge backs ({questionId} or {fundId}).
   */
  async function hold(
    client: PoolClient,
    books: Books,
    buckets: Buckets,
    input: {
      userId: string;
      pledgeId: string;
      amount: bigint;
      scope: Readonly<Record<string, string>>;
      metadata: Readonly<Record<string, unknown>>;
      record: (funding: StakeFunding) => Promise<unknown>;
    },
  ): Promise<HeldPledge> {
    const before = books.get(input.userId)!,
      bucket = buckets.get(input.userId)!;
    let plan: ReturnType<typeof planStake>;
    try {
      plan = planStake(before.book, String(input.amount));
    } catch (error) {
      if (!(error instanceof CoinOperationError)) throw error;
      throw new CoinOperationError(
        "insufficient Yap Coins for this pledge",
        409,
        "insufficient_balance",
      );
    }
    const parts = fundingTotals(plan.funding);
    const cash: CoinPosting[] = [],
      promo: CoinPosting[] = [];
    transfer(cash, bucket.cashAvailable, bucket.cashReserved, parts.cash);
    transfer(promo, bucket.promoAvailable, bucket.promoReserved, parts.promo);
    const cashJournalId = await post(
      client,
      input.userId,
      "reserve",
      "hold",
      input.pledgeId,
      "USDC",
      cash,
    );
    const promoJournalId = await post(
      client,
      input.userId,
      "reserve",
      "hold",
      input.pledgeId,
      "YC_PROMO",
      promo,
    );
    await input.record(plan.funding);
    await appendSandboxBookEvent(client, {
      userId: input.userId,
      snapshot: before,
      book: plan.book,
      kind: "mic.held",
      reference: reference(input.userId, "mic.hold", input.pledgeId),
      termsDigest: digest([
        input.pledgeId,
        ...Object.values(input.scope),
        String(input.amount),
        plan.funding,
      ]),
      cashJournalId,
      promoJournalId,
      metadata: {
        ...input.metadata,
        ...input.scope,
        pledgeId: input.pledgeId,
        funding: plan.funding,
        rail,
      },
    });
    books.set(input.userId, advanced(before, plan.book));
    return {
      id: input.pledgeId,
      user_id: input.userId,
      amount: String(input.amount),
      funding: plan.funding,
    };
  }

  /** The exact reverse of a hold, to the same sources (as a voided stake). */
  async function release(
    client: PoolClient,
    books: Books,
    buckets: Buckets,
    pledge: HeldPledge,
    input: {
      reason: string;
      scope: Readonly<Record<string, string>>;
      record: () => Promise<unknown>;
    },
  ) {
    const before = books.get(pledge.user_id)!,
      bucket = buckets.get(pledge.user_id)!;
    const parts = fundingTotals(pledge.funding);
    const cash: CoinPosting[] = [],
      promo: CoinPosting[] = [];
    transfer(cash, bucket.cashReserved, bucket.cashAvailable, parts.cash);
    transfer(promo, bucket.promoReserved, bucket.promoAvailable, parts.promo);
    const cashJournalId = await post(
      client,
      pledge.user_id,
      "release",
      "release",
      pledge.id,
      "USDC",
      cash,
    );
    const promoJournalId = await post(
      client,
      pledge.user_id,
      "release",
      "release",
      pledge.id,
      "YC_PROMO",
      promo,
    );
    const book = refundStake(before.book, pledge.funding);
    await appendSandboxBookEvent(client, {
      userId: pledge.user_id,
      snapshot: before,
      book,
      kind: "mic.released",
      reference: reference(pledge.user_id, "mic.release", pledge.id),
      termsDigest: digest([pledge.id, input.reason, pledge.funding]),
      cashJournalId,
      promoJournalId,
      metadata: {
        ...input.scope,
        pledgeId: pledge.id,
        reason: input.reason,
        funding: pledge.funding,
        rail,
      },
    });
    await input.record();
    books.set(pledge.user_id, advanced(before, book));
  }

  /**
   * The center pays the debaters the grant part it burns. Say so plainly when
   * its float runs low, instead of the ledger's refusal; nothing is spent.
   */
  async function assertCenterCovers(
    client: PoolClient,
    buckets: Buckets,
    debaters: Readonly<Record<Side, string>>,
    pledges: readonly HeldPledge[],
  ) {
    const center = buckets.get(debaters.A)!.system;
    const grantPart = pledges.reduce(
      (sum, p) => sum + fundingTotals(p.funding).promo,
      0n,
    );
    const centerBalance = BigInt(
      (
        await client.query<{ balance: string }>(
          "SELECT balance::text FROM coin_accounts WHERE id=$1",
          [center.center_available],
        )
      ).rows[0]!.balance,
    );
    if (centerBalance < grantPart)
      throw new CoinOperationError(
        "the mic is paused while Yap Coins are topped up; nothing was spent",
        503,
        "mic_paused",
      );
  }

  /**
   * Spends every hold in pledges and pays the seated debaters in equal
   * halves, as cash-backed Yap Coins (L15, X11). key names the payment:
   * the mic id for a fired question, "fund:<id>" for a funded extension.
   */
  async function payDebaters(
    client: PoolClient,
    books: Books,
    buckets: Buckets,
    input: {
      debateId: string;
      micId: string;
      key: string;
      source: string; // the debaters' book source id for this payment
      debaters: Readonly<Record<Side, string>>;
      pledges: readonly HeldPledge[];
      scope: Readonly<Record<string, string>>;
      record: (pledge: HeldPledge) => Promise<unknown>;
    },
  ) {
    const { debaters, micId } = input;
    const now = (
      await client.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now.toISOString();
    const earned: Record<Side, bigint> = { A: 0n, B: 0n };
    const journals: string[] = [];
    for (const pledge of input.pledges) {
      const before = books.get(pledge.user_id)!,
        bucket = buckets.get(pledge.user_id)!;
      // The whole hold is spent: nothing is released back.
      const committed = commitStakeCost(
        before.book,
        pledge.funding,
        pledge.funding.amount,
      );
      const parts = fundingTotals(pledge.funding);
      const cash: CoinPosting[] = [],
        promo: CoinPosting[] = [];
      move(cash, bucket.cashReserved, -parts.cash);
      move(cash, bucket.system.center_available, -parts.promo);
      for (const share of splitToDebaters(BigInt(pledge.amount), debaters)) {
        move(cash, buckets.get(share.account!)!.cashAvailable, share.amount);
        earned[share.side] += share.amount;
      }
      transfer(
        promo,
        bucket.promoReserved,
        bucket.system.grant_issuer,
        parts.promo,
      );
      const cashJournalId = await post(
        client,
        pledge.user_id,
        "payout",
        "spend",
        pledge.id,
        "USDC",
        cash,
      );
      const promoJournalId = await post(
        client,
        pledge.user_id,
        "payout",
        "spend",
        pledge.id,
        "YC_PROMO",
        promo,
      );
      if (cashJournalId) journals.push(cashJournalId);
      await appendSandboxBookEvent(client, {
        userId: pledge.user_id,
        snapshot: before,
        book: committed.book,
        kind: "mic.spent",
        reference: reference(pledge.user_id, "mic.spend", pledge.id),
        termsDigest: digest([pledge.id, micId, committed.funding]),
        cashJournalId,
        promoJournalId,
        metadata: {
          debateId: input.debateId,
          micId,
          ...input.scope,
          pledgeId: pledge.id,
          funding: committed.funding,
          rail,
        },
      });
      books.set(pledge.user_id, advanced(before, committed.book));
      await input.record(pledge);
    }
    // Each debater's half arrives as cash-backed Yap Coins: a
    // purchased_profit source on their book, matching the ledger credit.
    for (const side of ["A", "B"] as const) {
      const account = debaters[side],
        amount = earned[side];
      if (!amount) continue;
      const before = books.get(account)!;
      const book: GrantAccountingBook = {
        ...before.book,
        purchased: [
          ...before.book.purchased,
          {
            id: input.source,
            kind: "purchased_profit",
            purchaseId: input.source,
            createdAt: now,
            balance: String(amount),
          },
        ],
      };
      await appendSandboxBookEvent(client, {
        userId: account,
        snapshot: before,
        book,
        kind: "mic.earned",
        reference: reference(account, "mic.earned", input.key),
        termsDigest: digest([input.key, side, String(amount)]),
        metadata: {
          debateId: input.debateId,
          micId,
          ...input.scope,
          side,
          amount: String(amount),
          cashJournalIds: journals,
          rail,
        },
      });
      books.set(account, advanced(before, book));
    }
  }

  return Object.freeze({ hold, release, assertCenterCovers, payDebaters });
}
export type MicMoney = ReturnType<typeof createMicMoney>;
