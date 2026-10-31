import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { getAddress, isAddress } from "viem";
import {
  validatePreparedTestTransfer,
  type PreparedTestTransfer,
} from "./base-sepolia.ts";
import {
  accountOperationTermsDigest,
  type createAccountOperationRepository,
} from "../../platform/auth/account-operations.ts";
import {
  assertActiveSession,
  lockAccount,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
import {
  atomicAmount,
  CoinOperationError,
  observeExternalOperation,
  type ExternalObservation,
  type ExternalOperationStatus,
} from "./external-operations.ts";
import {
  allocateAtomicProportionally,
  grantClaimKey,
  newAccountingGrant,
  orderedPurchasedSourceIds,
  planPurchaseRefund,
  planWithdrawal,
  projectGrantAccounting,
  restoreWithdrawalSources,
  torontoGrantDay,
  type GrantAccountingBook,
  type WithdrawalSourceReservation,
} from "./grant-accounting.ts";
import {
  coinJournalReference,
  postCoinJournal,
  reverseCoinJournal,
  type CoinLedgerAsset,
} from "./ledger.ts";

export type SandboxRail = "simulation" | "base-sepolia";
export interface SandboxContext {
  userId: string;
  sessionTokenHash: string;
  // Comparison only: identity and authority still come from the verified cookie.
  expectedSessionId?: string;
}
export interface SandboxConfiguration {
  rail: SandboxRail;
  depositDestination?: string;
  // Server configuration, never a browser-chosen fee. Deducted FROM gross.
  withdrawalFee?: string;
}
export type PreparedCoinApproval = Awaited<
  ReturnType<ReturnType<typeof createAccountOperationRepository>["prepare"]>
>;
// Trusted owner-process review, never constructed from browser identifiers.
// Configured correction CLI requires this; legacy owner-only internal fixtures
// may omit it. Validation and its audit event share the correction transaction.
export interface PreparedFundingCorrectionReview {
  id: string;
  validate(client: PoolClient, originalFundingRequestId: string): Promise<void>;
}
export interface SandboxRequest {
  id: string;
  userId: string;
  kind: "funding" | "withdrawal" | "stake" | "correction" | "treasury";
  reference: string;
  termsDigest: string;
  terms: Record<string, string>;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}
export interface SandboxTransferReceipt {
  network: string;
  transactionId: string;
  locator: string;
  amount: string;
  evidenceDigest: string;
}
export interface SandboxBookSnapshot {
  book: GrantAccountingBook;
  version: string;
}
export type SandboxSystemPurpose =
  | "purchased_external"
  | "promotional_external"
  | "promotional_available"
  | "promotional_reserved"
  | "center_external"
  | "center_available"
  | "center_reserved"
  | "fees"
  | "correction_available"
  | "grant_issuer";
export interface SandboxBuckets {
  cashAvailable: string;
  cashReserved: string;
  cashPending: string;
  promoAvailable: string;
  promoReserved: string;
  system: Record<SandboxSystemPurpose, string>;
}
const columns = `id,user_id AS "userId",kind,reference,terms_digest AS "termsDigest",terms,status,
  expires_at AS "expiresAt",created_at AS "createdAt"`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function error(message: string, status = 409, code?: string): never {
  throw new CoinOperationError(message, status, code);
}
/**
 * The most one simulated purchase may buy: 1,000 USDC (100,000 YC). It keeps
 * any valueless simulated balance far below numeric(36,0), so a settlement
 * batch can never overflow.
 */
export const SIMULATED_FUNDING_LIMIT = 1_000_000_000n;
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function ref(userId: string, operation: string, key: string) {
  return coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
}
function scope(userId: string) {
  return {
    accountId: userId,
    environment: "sandbox" as const,
    asset: "USDC" as const,
    precision: 6 as const,
  };
}
function emptyBook(userId: string): GrantAccountingBook {
  return { scope: scope(userId), grants: [], purchased: [] };
}
function backing(book: GrantAccountingBook) {
  // Valid only because every grant-profit credit must be an actual USDC debit
  // from the independently funded promotional treasury, in that same transaction.
  return Object.fromEntries(
    book.grants.map((grant) => [grant.id, grant.profitRemaining]),
  );
}
function checkBook(userId: string, book: GrantAccountingBook) {
  if (book.scope.accountId !== userId || book.scope.environment !== "sandbox")
    error("sandbox book ownership mismatch");
  projectGrantAccounting(book, backing(book));
}
function configure(input: SandboxConfiguration) {
  if (input.rail !== "simulation" && input.rail !== "base-sepolia")
    error("explicit sandbox rail is required", 400);
  if (
    input.rail === "base-sepolia" &&
    (!input.depositDestination || !isAddress(input.depositDestination))
  )
    error("testnet custody destination is required", 400);
  const fee = input.withdrawalFee ?? "100000";
  atomicAmount(fee, true);
  return {
    rail: input.rail,
    network:
      input.rail === "simulation" ? "simulation:usdc" : "base-sepolia:84532",
    depositDestination:
      input.rail === "simulation"
        ? "deterministic-simulation-custody"
        : input.depositDestination!,
    fee,
  };
}
export async function assertSandboxRail(client: PoolClient, rail: SandboxRail) {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('coin-sandbox-rail',0))",
  );
  const row = (
    await client.query<{ rail: string }>(
      "SELECT rail FROM coin_sandbox_controls WHERE singleton=true",
    )
  ).rows[0];
  if (row?.rail !== rail)
    error("sandbox rail does not match this isolated database", 503);
}
// Decision 0013 (amends Decision 0009, point 8, for opening only): Yap Coins
// are always on. Callers act for the signed-in account itself, so its first
// own sandbox request records an automatic opening instead of asking for a
// fresh sign-in. Withdrawals and recovery consents still confirm each request.
export async function assertSandboxOpened(client: PoolClient, userId: string) {
  await client.query(
    "INSERT INTO coin_sandbox_openings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",
    [userId],
  );
}
// Owner authority never opens a sandbox on an account's behalf: it requires
// the opening that the account's own first request recorded.
export async function requireSandboxOpening(
  client: PoolClient,
  userId: string,
) {
  const opened = (
    await client.query("SELECT 1 FROM coin_sandbox_openings WHERE user_id=$1", [
      userId,
    ])
  ).rowCount;
  if (!opened) error("this account has not used its coin sandbox", 403);
}
// The one place that answers "may a testnet deposit follow an automatic
// opening (operation_id NULL)?" Yes: the founder accepted it on 2026-10-26
// (Decision 0013). Reversing that means requiring operation_id IS NOT NULL
// here and a one-time confirmed opening before a first testnet deposit.
async function requireTestnetFundingOpening(
  client: PoolClient,
  userId: string,
) {
  await requireSandboxOpening(client, userId);
}
export async function assertSandboxFinancialOpen(
  client: PoolClient,
  userId: string,
) {
  if (
    (
      await client.query(
        "SELECT 1 FROM coin_sandbox_requests WHERE user_id=$1 AND kind='correction' AND status='uncertain' LIMIT 1",
        [userId],
      )
    ).rowCount
  )
    error(
      "financial activity is paused for correction review",
      403,
      "financial_review",
    );
}
// New review/signing authority must follow the current account state, even
// when the user reserved funds earlier. Authoritative reconciliation and safe
// rejection intentionally remain available after suspension or a correction.
export async function assertSandboxNewPayoutAuthorization(
  client: PoolClient,
  userId: string,
) {
  if (!(await lockAccount(client, userId)))
    error("account unavailable for new payout authorization", 403);
  await requireSandboxOpening(client, userId);
  await assertSandboxFinancialOpen(client, userId);
}
export async function lockSandboxBook(
  client: PoolClient,
  userId: string,
): Promise<SandboxBookSnapshot> {
  await client.query(
    "INSERT INTO coin_sandbox_books(user_id,book) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO NOTHING",
    [userId, JSON.stringify(emptyBook(userId))],
  );
  const row = (
    await client.query<SandboxBookSnapshot>(
      "SELECT book,version::text FROM coin_sandbox_books WHERE user_id=$1 FOR UPDATE",
      [userId],
    )
  ).rows[0]!;
  checkBook(userId, row.book);
  return row;
}
export async function appendSandboxBookEvent(
  client: PoolClient,
  input: {
    userId: string;
    snapshot: SandboxBookSnapshot;
    book: GrantAccountingBook;
    kind: string;
    reference: string;
    termsDigest: string;
    requestId?: string;
    cashJournalId?: string;
    promoJournalId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  checkBook(input.userId, input.book);
  return (
    await client.query<{ id: string; sequence: string }>(
      `INSERT INTO coin_sandbox_events
    (id,user_id,kind,reference,terms_digest,before_version,book_after,metadata,request_id,cash_journal_id,promo_journal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) RETURNING id,sequence::text`,
      [
        randomUUID(),
        input.userId,
        input.kind,
        input.reference,
        input.termsDigest,
        input.snapshot.version,
        JSON.stringify(input.book),
        JSON.stringify(input.metadata ?? {}),
        input.requestId ?? null,
        input.cashJournalId ?? null,
        input.promoJournalId ?? null,
      ],
    )
  ).rows[0]!;
}
async function priorEvent(
  client: PoolClient,
  userId: string,
  reference: string,
) {
  return (
    await client.query<{
      id: string;
      kind: string;
      termsDigest: string;
      requestId: string | null;
      metadata: Record<string, unknown>;
      cashJournalId: string | null;
    }>(
      `SELECT id,kind,terms_digest AS "termsDigest",request_id AS "requestId",metadata,cash_journal_id AS "cashJournalId"
     FROM coin_sandbox_events WHERE user_id=$1 AND reference=$2`,
      [userId, reference],
    )
  ).rows[0];
}
export async function ensureSandboxBuckets(
  client: PoolClient,
  userId: string,
): Promise<SandboxBuckets> {
  // Caller holds account/session/request/book locks. Setup uses one shared lock
  // before ledger rows; subsequent journals lock cash before promotional rows.
  const ready = (
    await client.query<{ ready: boolean }>(
      `SELECT
    (SELECT count(*)=10 FROM coin_sandbox_system_accounts) AND
    (SELECT count(*)=5 FROM coin_accounts WHERE user_id=$1 AND environment='sandbox'
      AND ((asset='USDC' AND kind IN ('available','reserved','pending'))
       OR (asset='YC_PROMO' AND kind IN ('promotional','reserved')))) AS ready`,
      [userId],
    )
  ).rows[0]?.ready;
  if (!ready)
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('coin-sandbox-buckets',0))",
    );
  const userBucket = async (asset: CoinLedgerAsset, kind: string) => {
    let row = (
      await client.query<{ id: string }>(
        "SELECT id FROM coin_accounts WHERE user_id=$1 AND environment='sandbox' AND asset=$2 AND kind=$3",
        [userId, asset, kind],
      )
    ).rows[0];
    if (!row)
      row = (
        await client.query<{ id: string }>(
          "INSERT INTO coin_accounts(id,user_id,environment,asset,precision,kind) VALUES($1,$2,'sandbox',$3,$4,$5) RETURNING id",
          [randomUUID(), userId, asset, asset === "USDC" ? 6 : 4, kind],
        )
      ).rows[0]!;
    return row.id;
  };
  const system: Partial<Record<SandboxSystemPurpose, string>> = {};
  const purposes: SandboxSystemPurpose[] = [
    "purchased_external",
    "promotional_external",
    "promotional_available",
    "promotional_reserved",
    "center_external",
    "center_available",
    "center_reserved",
    "fees",
    "correction_available",
    "grant_issuer",
  ];
  for (const purpose of purposes) {
    let row = (
      await client.query<{ id: string }>(
        "SELECT account_id AS id FROM coin_sandbox_system_accounts WHERE purpose=$1",
        [purpose],
      )
    ).rows[0];
    if (!row) {
      const asset = purpose === "grant_issuer" ? "YC_PROMO" : "USDC";
      const kind =
        purpose.endsWith("_external") || purpose === "grant_issuer"
          ? "backing"
          : purpose === "fees"
            ? "fees"
            : "operating";
      const id = randomUUID();
      await client.query(
        "INSERT INTO coin_accounts(id,environment,asset,precision,kind) VALUES($1,'sandbox',$2,$3,$4)",
        [id, asset, asset === "USDC" ? 6 : 4, kind],
      );
      await client.query(
        "INSERT INTO coin_sandbox_system_accounts(purpose,asset,account_id) VALUES($1,$2,$3)",
        [purpose, asset, id],
      );
      row = { id };
    }
    system[purpose] = row.id;
  }
  function systemId(purpose: SandboxSystemPurpose) {
    const id = system[purpose];
    if (!id) error("sandbox system account is missing", 503);
    return id;
  }
  return {
    cashAvailable: await userBucket("USDC", "available"),
    cashReserved: await userBucket("USDC", "reserved"),
    cashPending: await userBucket("USDC", "pending"),
    promoAvailable: await userBucket("YC_PROMO", "promotional"),
    promoReserved: await userBucket("YC_PROMO", "reserved"),
    system: {
      purchased_external: systemId("purchased_external"),
      promotional_external: systemId("promotional_external"),
      promotional_available: systemId("promotional_available"),
      promotional_reserved: systemId("promotional_reserved"),
      center_external: systemId("center_external"),
      center_available: systemId("center_available"),
      center_reserved: systemId("center_reserved"),
      fees: systemId("fees"),
      correction_available: systemId("correction_available"),
      grant_issuer: systemId("grant_issuer"),
    },
  };
}
async function journal(
  client: PoolClient,
  input: {
    userId: string;
    reference: string;
    operation: "funding" | "reserve" | "payout" | "release";
    asset?: CoinLedgerAsset;
    postings: { accountId: string; amount: string }[];
  },
) {
  return (
    await postCoinJournal(client, {
      id: randomUUID(),
      environment: "sandbox",
      asset: input.asset ?? "USDC",
      reference: input.reference,
      operation: input.operation,
      postings: input.postings,
    })
  ).id;
}
async function requestForUpdate(
  client: PoolClient,
  userId: string,
  id: string,
) {
  if (!uuid.test(id)) error("invalid sandbox request", 400);
  const request = (
    await client.query<SandboxRequest>(
      `SELECT ${columns} FROM coin_sandbox_requests WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [id, userId],
    )
  ).rows[0];
  if (!request) error("sandbox request unavailable", 404);
  return request;
}
async function activeQuote(client: PoolClient, request: SandboxRequest) {
  if (
    !(
      await client.query<{ active: boolean }>(
        "SELECT expires_at>clock_timestamp() AS active FROM coin_sandbox_requests WHERE id=$1",
        [request.id],
      )
    ).rows[0]?.active
  )
    error("quote expired; request a new quote", 410);
}
async function insertRequest(
  client: PoolClient,
  input: {
    userId: string;
    kind: SandboxRequest["kind"];
    reference: string;
    terms: Record<string, string>;
    expiresAt?: Date;
    status: string;
    id: string;
  },
) {
  return (
    await client.query<SandboxRequest>(
      `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status,expires_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING ${columns}`,
      [
        input.id,
        input.userId,
        input.kind,
        input.reference,
        accountOperationTermsDigest(input.terms),
        JSON.stringify(input.terms),
        input.status,
        input.expiresAt ?? null,
      ],
    )
  ).rows[0]!;
}
async function savedReservation(
  client: PoolClient,
  request: SandboxRequest,
): Promise<WithdrawalSourceReservation> {
  const event = (
    await client.query<{ reservation: WithdrawalSourceReservation }>(
      `SELECT metadata->'reservation' AS reservation FROM coin_sandbox_events
    WHERE request_id=$1 AND kind='withdrawal.reserved' ORDER BY sequence LIMIT 1`,
      [request.id],
    )
  ).rows[0];
  if (!event?.reservation) error("withdrawal source receipt is missing", 503);
  if (
    event.reservation.scope.accountId !== request.userId ||
    event.reservation.scope.environment !== "sandbox" ||
    event.reservation.amount !== request.terms.gross
  )
    error("withdrawal source receipt conflicts", 503);
  return event.reservation;
}
async function receipt(
  client: PoolClient,
  request: SandboxRequest,
  evidence: SandboxTransferReceipt,
  amount: string,
  network: string,
) {
  if (
    evidence.network !== network ||
    evidence.amount !== amount ||
    !evidence.transactionId ||
    evidence.transactionId.length > 200 ||
    !evidence.locator ||
    evidence.locator.length > 200 ||
    !/^[a-f0-9]{64}$/.test(evidence.evidenceDigest)
  )
    error("reconciled transfer does not match its request");
  const assigned = (
    await client.query<{
      network: string;
      transactionId: string;
      locator: string;
      amount: string;
      digest: string;
    }>(
      `SELECT network,transaction_id AS "transactionId",locator,amount::text,evidence_digest AS digest FROM coin_external_receipts WHERE request_id=$1`,
      [request.id],
    )
  ).rows[0];
  if (
    assigned &&
    (assigned.network !== network ||
      assigned.transactionId !== evidence.transactionId ||
      assigned.locator !== evidence.locator ||
      assigned.amount !== amount ||
      assigned.digest !== evidence.evidenceDigest)
  )
    error("external transfer was already assigned or conflicts");
  const prior = (
    await client.query<{ requestId: string; amount: string; digest: string }>(
      `SELECT request_id AS "requestId",amount::text,evidence_digest AS digest FROM coin_external_receipts
    WHERE environment='sandbox' AND network=$1 AND asset='USDC' AND transaction_id=$2 AND locator=$3`,
      [network, evidence.transactionId, evidence.locator],
    )
  ).rows[0];
  if (prior) {
    if (
      prior.requestId !== request.id ||
      prior.amount !== amount ||
      prior.digest !== evidence.evidenceDigest
    )
      error("external transfer was already assigned or conflicts");
    return;
  }
  await client.query(
    `INSERT INTO coin_external_receipts(id,request_id,network,asset,transaction_id,locator,amount,evidence_digest)
    VALUES($1,$2,$3,'USDC',$4,$5,$6,$7)`,
    [
      randomUUID(),
      request.id,
      network,
      evidence.transactionId,
      evidence.locator,
      amount,
      evidence.evidenceDigest,
    ],
  );
}
export function withdrawalApprovalTerms(
  request: Pick<SandboxRequest, "kind" | "terms">,
) {
  if (request.kind !== "withdrawal") error("withdrawal terms required", 400);
  return request.terms;
}

export function createCoinSandboxRepository(
  database: Pool,
  configuration: SandboxConfiguration,
) {
  const config = configure(configuration);
  async function tx<T>(
    context: SandboxContext,
    mutation: (client: PoolClient) => Promise<T>,
    strong = true,
  ) {
    return withTransaction(database, async (client) => {
      if (!(await lockAccount(client, context.userId)))
        throw new SessionUnavailableError("account unavailable");
      const session = await assertActiveSession(
        client,
        context.userId,
        context.sessionTokenHash,
      );
      if (
        context.expectedSessionId !== undefined &&
        context.expectedSessionId !== session.id
      )
        error("account session changed; refresh this page", 409);
      await assertSandboxRail(client, config.rail);
      if (strong) {
        await assertSandboxOpened(client, context.userId);
        await assertSandboxFinancialOpen(client, context.userId);
      }
      const result = await mutation(client);
      await assertActiveSession(
        client,
        context.userId,
        context.sessionTokenHash,
      );
      return result;
    });
  }
  async function claim(
    client: PoolClient,
    context: SandboxContext,
    kind: "welcome" | "daily",
  ) {
    const clock = (
      await client.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now;
    const key = grantClaimKey(scope(context.userId), kind, clock);
    const previous = await priorEvent(client, context.userId, key);
    if (previous)
      return {
        created: false,
        grantId: String(previous.metadata.grantId),
        day: kind === "daily" ? torontoGrantDay(clock) : null,
      };
    const snapshot = await lockSandboxBook(client, context.userId);
    const lot = newAccountingGrant({
      id: randomUUID(),
      kind,
      createdAt: clock.toISOString(),
    });
    const buckets = await ensureSandboxBuckets(client, context.userId);
    const promoJournalId = await journal(client, {
      userId: context.userId,
      reference: ref(context.userId, "grant.issue.promo", key),
      operation: "funding",
      asset: "YC_PROMO",
      postings: [
        {
          accountId: buckets.system.grant_issuer,
          amount: String(-BigInt(lot.principal)),
        },
        { accountId: buckets.promoAvailable, amount: lot.principal },
      ],
    });
    await client.query(
      "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target,created_at) VALUES($1,$2,'sandbox','USDC',$3,$4,$5,$6)",
      [lot.id, context.userId, kind, key, lot.principal, clock],
    );
    await appendSandboxBookEvent(client, {
      userId: context.userId,
      snapshot,
      book: { ...snapshot.book, grants: [...snapshot.book.grants, lot] },
      kind: "grant.issued",
      reference: key,
      termsDigest: hash([config.rail, kind, key, lot.principal]),
      promoJournalId,
      metadata: {
        grantId: lot.id,
        kind,
        rail: config.rail,
        day: kind === "daily" ? torontoGrantDay(clock) : null,
        principalAsset: "YC_PROMO",
        simulation: config.rail === "simulation",
      },
    });
    return {
      created: true,
      grantId: lot.id,
      day: kind === "daily" ? torontoGrantDay(clock) : null,
    };
  }
  async function quote(
    context: SandboxContext,
    kind: "funding" | "withdrawal",
    input: { idempotencyKey: string; amount: string; destination?: string },
  ) {
    const amount = atomicAmount(input.amount);
    if (
      kind === "funding" &&
      config.rail === "simulation" &&
      amount > SIMULATED_FUNDING_LIMIT
    )
      error("a simulated purchase is limited to 1,000 USDC", 400);
    if (
      kind === "withdrawal" &&
      (amount < 5_000_000n || amount <= BigInt(config.fee))
    )
      error(
        "withdrawal gross must be at least 5 USDC and exceed the displayed fee",
        400,
      );
    const destination =
      kind === "funding" ? config.depositDestination : input.destination;
    if (
      !destination ||
      destination.length > 200 ||
      [...destination].some(
        (character) =>
          character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      ) ||
      (config.rail === "base-sepolia" && !isAddress(destination))
    )
      error("invalid sandbox destination", 400);
    return tx(context, async (client) => {
      const reference = ref(
        context.userId,
        `${kind}.quote`,
        input.idempotencyKey,
      );
      const existing = (
        await client.query<SandboxRequest>(
          `SELECT ${columns} FROM coin_sandbox_requests WHERE user_id=$1 AND kind=$2 AND reference=$3`,
          [context.userId, kind, reference],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.terms.amount !== input.amount ||
          existing.terms.destination !== destination ||
          existing.terms.rail !== config.rail
        )
          error("idempotency key has different quote terms");
        return existing;
      }
      await lockSandboxBook(client, context.userId);
      const now = (
        await client.query<{ now: Date }>(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
        )
      ).rows[0]!.now;
      const expiresAt = new Date(now.getTime() + 300_000),
        id = randomUUID();
      const terms: Record<string, string> = {
        requestId: id,
        quoteId: id,
        environment: "sandbox",
        rail: config.rail,
        asset: "USDC",
        precision: "6",
        amount: input.amount,
        network: config.network,
        destination,
        provider:
          config.rail === "simulation"
            ? "deterministic-simulation"
            : "circle-test-usdc",
        expiresAt: expiresAt.toISOString(),
      };
      if (kind === "withdrawal")
        Object.assign(terms, {
          gross: input.amount,
          fee: config.fee,
          net: String(amount - BigInt(config.fee)),
        });
      else
        Object.assign(terms, {
          inputAsset: "USDC",
          inputAmount: input.amount,
          conversionRate: "1",
          yapCoinsPerUsdc: "100",
        });
      return insertRequest(client, {
        id,
        userId: context.userId,
        kind,
        reference,
        terms,
        expiresAt,
        status: "quoted",
      });
    });
  }
  async function completeFunding(
    client: PoolClient,
    context: SandboxContext,
    request: SandboxRequest,
    evidence: SandboxTransferReceipt,
  ) {
    if (request.kind !== "funding" || request.terms.rail !== config.rail)
      error("funding request conflicts");
    const key = ref(context.userId, "funding.completed", request.id),
      prior = await priorEvent(client, context.userId, key);
    if (prior) {
      await receipt(
        client,
        request,
        evidence,
        request.terms.amount!,
        config.network,
      );
      return { created: false, request };
    }
    if (!["quoted", "pending", "uncertain"].includes(request.status))
      error("funding request is not awaiting confirmation");
    const snapshot = await lockSandboxBook(client, context.userId),
      buckets = await ensureSandboxBuckets(client, context.userId);
    await receipt(
      client,
      request,
      evidence,
      request.terms.amount!,
      config.network,
    );
    const cashJournalId = await journal(client, {
      userId: context.userId,
      reference: ref(context.userId, "funding.cash", request.id),
      operation: "funding",
      postings: [
        {
          accountId: buckets.system.purchased_external,
          amount: String(-BigInt(request.terms.amount!)),
        },
        { accountId: buckets.cashAvailable, amount: request.terms.amount! },
      ],
    });
    const after: GrantAccountingBook = {
      ...snapshot.book,
      purchased: [
        ...snapshot.book.purchased,
        {
          id: request.id,
          kind: "purchased_principal",
          purchaseId: request.id,
          createdAt: new Date().toISOString(),
          balance: request.terms.amount!,
        },
      ],
    };
    await client.query(
      "UPDATE coin_sandbox_requests SET status='completed' WHERE id=$1",
      [request.id],
    );
    await appendSandboxBookEvent(client, {
      userId: context.userId,
      snapshot,
      book: after,
      kind: "funding.completed",
      reference: key,
      termsDigest: request.termsDigest,
      requestId: request.id,
      cashJournalId,
      metadata: {
        rail: config.rail,
        simulation: config.rail === "simulation",
        receiptLocator: evidence.locator,
        transactionId: evidence.transactionId,
      },
    });
    // A simulation confirmation may wait behind an unrelated ledger mutation.
    // Check the DB clock again after every wait/write so an expired quote rolls
    // back receipt, journal and source book together. Real incoming funds are
    // reconciled by the owner even when a quoted deposit arrives late.
    if (config.rail === "simulation") await activeQuote(client, request);
    return { created: true, request: { ...request, status: "completed" } };
  }
  return Object.freeze({
    configuration: Object.freeze({
      environment: "sandbox",
      rail: config.rail,
      network: config.network,
      simulation: config.rail === "simulation",
    }),
    getRequest(context: SandboxContext, requestId: string) {
      return tx(context, (client) =>
        requestForUpdate(client, context.userId, requestId),
      );
    },
    async summary(context: SandboxContext) {
      return tx(
        context,
        async (client) => {
          const row = (
            await client.query<SandboxBookSnapshot>(
              "SELECT book,version::text FROM coin_sandbox_books WHERE user_id=$1",
              [context.userId],
            )
          ).rows[0];
          const book = row?.book ?? emptyBook(context.userId);
          checkBook(context.userId, book);
          const balances = (
            await client.query<{
              asset: string;
              kind: string;
              balance: string;
            }>(
              "SELECT asset,kind,balance::text FROM coin_accounts WHERE user_id=$1 AND environment='sandbox'",
              [context.userId],
            )
          ).rows;
          const amount = (asset: string, kind: string) =>
            balances.find(
              (entry) => entry.asset === asset && entry.kind === kind,
            )?.balance ?? "0";
          const requests = (
            await client.query<SandboxRequest>(
              `SELECT ${columns} FROM coin_sandbox_requests WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
              [context.userId],
            )
          ).rows;
          return {
            environment: "sandbox",
            sessionId: (
              await assertActiveSession(
                client,
                context.userId,
                context.sessionTokenHash,
              )
            ).id,
            rail: config.rail,
            simulation: config.rail === "simulation",
            initialized: book.grants.some((grant) => grant.kind === "welcome"),
            version: row?.version ?? "0",
            book,
            projection: projectGrantAccounting(book, backing(book)),
            balances: {
              cashAvailable: amount("USDC", "available"),
              reserved: amount("USDC", "reserved"),
              pending: amount("USDC", "pending"),
              promotionalPrincipal: amount("YC_PROMO", "promotional"),
              // Grant principal held by open stakes, so the header can show
              // every reserved Yap Coin, not only reserved cash.
              promotionalReserved: amount("YC_PROMO", "reserved"),
            },
            opened: Boolean(
              (
                await client.query(
                  "SELECT 1 FROM coin_sandbox_openings WHERE user_id=$1",
                  [context.userId],
                )
              ).rowCount,
            ),
            financialReviewRequired: Boolean(
              (
                await client.query(
                  "SELECT 1 FROM coin_sandbox_requests WHERE user_id=$1 AND kind='correction' AND status='uncertain' LIMIT 1",
                  [context.userId],
                )
              ).rowCount,
            ),
            requests,
          };
        },
        false,
      );
    },
    // Decision 0013: the account's first request opens its sandbox (through
    // the strong transaction) and claims the welcome grant exactly once.
    // Browsers call this as soon as a summary reports no welcome grant.
    initialize(context: SandboxContext) {
      return tx(context, (client) => claim(client, context, "welcome"));
    },
    claimGrant(context: SandboxContext, kind: "welcome" | "daily") {
      if (kind !== "welcome" && kind !== "daily")
        error("invalid grant kind", 400);
      return tx(context, (client) => claim(client, context, kind));
    },
    quoteFunding(
      context: SandboxContext,
      input: { idempotencyKey: string; amount: string },
    ) {
      return quote(context, "funding", input);
    },
    quoteWithdrawal(
      context: SandboxContext,
      input: { idempotencyKey: string; gross: string; destination: string },
    ) {
      return quote(context, "withdrawal", { ...input, amount: input.gross });
    },
    confirmSimulatedFunding(
      context: SandboxContext,
      input: { requestId: string },
    ) {
      if (config.rail !== "simulation")
        error("simulated credits are prohibited in the testnet ledger", 403);
      return tx(context, async (client) => {
        const request = await requestForUpdate(
          client,
          context.userId,
          input.requestId,
        );
        if (request.status === "quoted") await activeQuote(client, request);
        return completeFunding(client, context, request, {
          network: config.network,
          transactionId: `simulation:${request.id}`,
          locator: "credit:0",
          amount: request.terms.amount!,
          evidenceDigest: hash([
            "deterministic-simulation",
            request.id,
            request.termsDigest,
          ]),
        });
      });
    },
    async requestWithdrawal(
      context: SandboxContext,
      input: { requestId: string; approval: PreparedCoinApproval },
    ) {
      const observed = (
        await database.query<SandboxRequest>(
          `SELECT ${columns} FROM coin_sandbox_requests WHERE id=$1 AND user_id=$2`,
          [input.requestId, context.userId],
        )
      ).rows[0];
      if (!observed || observed.kind !== "withdrawal")
        error("withdrawal quote unavailable", 404);
      input.approval.assertContext(context.userId, context.sessionTokenHash);
      if (
        input.approval.purpose !== "withdrawal.request" ||
        input.approval.termsDigest !==
          accountOperationTermsDigest(withdrawalApprovalTerms(observed))
      )
        error("approval does not authorize this withdrawal", 403);
      return tx(context, async (client) =>
        input.approval.consume(client, async () => {
          const request = await requestForUpdate(
            client,
            context.userId,
            input.requestId,
          );
          if (
            request.kind !== "withdrawal" ||
            request.termsDigest !== observed.termsDigest ||
            request.terms.rail !== config.rail
          )
            error("withdrawal quote changed");
          if (request.status !== "quoted")
            error("withdrawal request already submitted");
          await activeQuote(client, request);
          const snapshot = await lockSandboxBook(client, context.userId),
            planned = planWithdrawal(
              snapshot.book,
              request.terms.gross!,
              orderedPurchasedSourceIds(snapshot.book),
              backing(snapshot.book),
            );
          const buckets = await ensureSandboxBuckets(client, context.userId),
            cashJournalId = await journal(client, {
              userId: context.userId,
              reference: ref(context.userId, "withdrawal.reserve", request.id),
              operation: "reserve",
              postings: [
                {
                  accountId: buckets.cashAvailable,
                  amount: String(-BigInt(request.terms.gross!)),
                },
                {
                  accountId: buckets.cashReserved,
                  amount: request.terms.gross!,
                },
              ],
            });
          await client.query(
            "UPDATE coin_sandbox_requests SET status='review' WHERE id=$1",
            [request.id],
          );
          await appendSandboxBookEvent(client, {
            userId: context.userId,
            snapshot,
            book: planned.book,
            kind: "withdrawal.reserved",
            reference: ref(context.userId, "withdrawal.reserved", request.id),
            termsDigest: request.termsDigest,
            requestId: request.id,
            cashJournalId,
            metadata: {
              reservation: planned.reservation,
              rail: config.rail,
              manualReview: true,
            },
          });
          await activeQuote(client, request);
          return { ...request, status: "review" };
        }),
      );
    },
    // Trusted owner-only facade below reuses the same funding implementation.
    async confirmSimulationFundingByOwner(input: {
      userId: string;
      requestId: string;
    }) {
      if (config.rail !== "simulation")
        error("simulated funding requires an isolated simulation ledger", 403);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        await requireSandboxOpening(client, input.userId);
        await assertSandboxFinancialOpen(client, input.userId);
        const request = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        return completeFunding(
          client,
          { userId: input.userId, sessionTokenHash: "" },
          request,
          {
            network: config.network,
            transactionId: `simulation:${request.id}`,
            locator: "credit:0",
            amount: request.terms.amount!,
            evidenceDigest: hash([
              "deterministic-simulation",
              request.id,
              request.termsDigest,
            ]),
          },
        );
      });
    },
    async confirmFundingByOwner(input: {
      userId: string;
      requestId: string;
      receipt: SandboxTransferReceipt;
    }) {
      if (config.rail !== "base-sepolia")
        error("testnet funding cannot enter a simulation ledger", 403);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        await requireTestnetFundingOpening(client, input.userId);
        await assertSandboxFinancialOpen(client, input.userId);
        const request = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        return completeFunding(
          client,
          { userId: input.userId, sessionTokenHash: "" },
          request,
          input.receipt,
        );
      });
    },
  });
}
async function ownerTx<T>(
  database: Pool,
  rail: SandboxRail,
  userId: string,
  mutation: (client: PoolClient) => Promise<T>,
) {
  return withTransaction(database, async (client) => {
    if (
      (await client.query<{ role: string }>("SELECT current_user AS role"))
        .rows[0]?.role !== "yaparena_owner"
    )
      error("sandbox operator ownership is required", 403);
    if (
      !(
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          userId,
        ])
      ).rows[0]
    )
      error("account unavailable", 404);
    await assertSandboxRail(client, rail);
    return mutation(client);
  });
}
export function createCoinSandboxOperatorRepository(
  database: Pool,
  configuration: SandboxConfiguration,
) {
  const config = configure(configuration);
  return Object.freeze({
    async confirmTreasuryFunding(input: {
      operatorUserId: string;
      purpose: "promotional" | "center" | "correction";
      amount: string;
      idempotencyKey: string;
      receipt: SandboxTransferReceipt;
    }) {
      if (config.rail !== "base-sepolia")
        error(
          "reconciled treasury funding requires an isolated testnet ledger",
          403,
        );
      atomicAmount(input.amount);
      if (!["promotional", "center", "correction"].includes(input.purpose))
        error("invalid treasury purpose", 400);
      return ownerTx(
        database,
        config.rail,
        input.operatorUserId,
        async (client) => {
          const reference = ref(
            input.operatorUserId,
            "treasury.funding",
            input.idempotencyKey,
          );
          let request = (
            await client.query<SandboxRequest>(
              `SELECT ${columns} FROM coin_sandbox_requests WHERE user_id=$1 AND kind='treasury' AND reference=$2 FOR UPDATE`,
              [input.operatorUserId, reference],
            )
          ).rows[0];
          const scopeTerms = {
            environment: "sandbox",
            rail: config.rail,
            network: config.network,
            asset: "USDC",
            precision: "6",
            provider: "circle-test-usdc",
            destination: config.depositDestination,
            purpose: input.purpose,
            amount: input.amount,
          };
          if (request) {
            const previous = request;
            if (
              Object.entries(scopeTerms).some(
                ([key, value]) => previous.terms[key] !== value,
              )
            )
              error("treasury funding idempotency conflict");
            await receipt(
              client,
              request,
              input.receipt,
              input.amount,
              config.network,
            );
            return { created: false, request };
          }
          const id = randomUUID();
          request = await insertRequest(client, {
            id,
            userId: input.operatorUserId,
            kind: "treasury",
            reference,
            terms: { ...scopeTerms, requestId: id },
            status: "completed",
          });
          // The trusted owner process must first reconcile the exact incoming
          // transfer to the fixed custody address. Global receipt identity below
          // prevents assigning that transfer to any user purchase/payout/treasury
          // twice, including concurrent confirmations by different operators.
          await receipt(
            client,
            request,
            input.receipt,
            input.amount,
            config.network,
          );
          const snapshot = await lockSandboxBook(client, input.operatorUserId),
            buckets = await ensureSandboxBuckets(client, input.operatorUserId);
          const source =
            input.purpose === "promotional"
              ? buckets.system.promotional_external
              : buckets.system.center_external;
          const destination =
            input.purpose === "promotional"
              ? buckets.system.promotional_available
              : input.purpose === "center"
                ? buckets.system.center_available
                : buckets.system.correction_available;
          const cashJournalId = await journal(client, {
            userId: input.operatorUserId,
            reference: ref(input.operatorUserId, "treasury.funding.cash", id),
            operation: "funding",
            postings: [
              { accountId: source, amount: String(-BigInt(input.amount)) },
              { accountId: destination, amount: input.amount },
            ],
          });
          await appendSandboxBookEvent(client, {
            userId: input.operatorUserId,
            snapshot,
            book: snapshot.book,
            kind: "treasury.funding.completed",
            reference,
            termsDigest: request.termsDigest,
            requestId: id,
            cashJournalId,
            metadata: {
              purpose: input.purpose,
              rail: config.rail,
              actorRole: "yaparena_owner",
              receiptLocator: input.receipt.locator,
              transactionId: input.receipt.transactionId,
            },
          });
          return { created: true, request };
        },
      );
    },
    confirmSimulatedFunding(input: { userId: string; requestId: string }) {
      return createCoinSandboxRepository(
        database,
        configuration,
      ).confirmSimulationFundingByOwner(input);
    },
    confirmFunding(input: {
      userId: string;
      requestId: string;
      receipt: SandboxTransferReceipt;
    }) {
      return createCoinSandboxRepository(
        database,
        configuration,
      ).confirmFundingByOwner(input);
    },
    async reserveSignedPayout(input: {
      userId: string;
      requestId: string;
      prepared: PreparedTestTransfer;
    }) {
      if (config.rail !== "base-sepolia")
        error("signed payouts require an isolated testnet ledger", 403);
      // Pure verification happens before locks. No RPC, signing or broadcast
      // occurs here; admit only these exact bytes for the approved request.
      await validatePreparedTestTransfer(input.prepared);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const request = await requestForUpdate(
            client,
            input.userId,
            input.requestId,
          ),
          prepared = input.prepared;
        if (
          request.kind !== "withdrawal" ||
          request.terms.rail !== config.rail ||
          request.terms.network !== config.network ||
          prepared.operationId !== request.id ||
          getAddress(prepared.from) !== getAddress(config.depositDestination) ||
          getAddress(prepared.to) !== getAddress(request.terms.destination!) ||
          prepared.amount !== BigInt(request.terms.net!)
        )
          error("signed payout does not authorize the approved request");
        await assertSandboxNewPayoutAuthorization(client, input.userId);
        const prior = (
          await client.query<{
            sender: string;
            nonce: string;
            transaction_id: string;
            signed_bytes: string;
          }>(
            "SELECT sender,nonce::text,transaction_id,signed_bytes FROM coin_nonce_reservations WHERE request_id=$1",
            [request.id],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.sender !== prepared.from.toLowerCase() ||
            prior.nonce !== String(prepared.nonce) ||
            prior.transaction_id !== prepared.hash.toLowerCase() ||
            prior.signed_bytes !== prepared.serializedTransaction
          )
            error("payout already has a different immutable signed identity");
          return {
            created: false,
            transactionId: prior.transaction_id,
            nonce: Number(prior.nonce),
          };
        }
        if (request.status !== "approved")
          error("manual approval is required before signing admission");
        await client.query(
          `INSERT INTO coin_nonce_reservations(request_id,network,sender,nonce,transaction_id,signed_bytes)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [
            request.id,
            config.network,
            prepared.from.toLowerCase(),
            String(prepared.nonce),
            prepared.hash.toLowerCase(),
            prepared.serializedTransaction,
          ],
        );
        const snapshot = await lockSandboxBook(client, input.userId);
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: snapshot.book,
          kind: "withdrawal.signed",
          requestId: request.id,
          reference: ref(input.userId, "withdrawal.signed", request.id),
          termsDigest: request.termsDigest,
          metadata: {
            rail: config.rail,
            actorRole: "yaparena_owner",
            transactionId: prepared.hash.toLowerCase(),
            sender: prepared.from.toLowerCase(),
            nonce: String(prepared.nonce),
          },
        });
        return {
          created: true,
          transactionId: prepared.hash.toLowerCase(),
          nonce: prepared.nonce,
        };
      });
    },
    async observeFunding(input: {
      userId: string;
      requestId: string;
      event: ExternalObservation;
    }) {
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const request = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        if (
          request.kind !== "funding" ||
          request.terms.rail !== config.rail ||
          input.event.externalId !== request.id ||
          input.event.termsDigest !== request.termsDigest
        )
          error("external funding does not match its local request");
        if (input.event.status === "completed")
          error("funding completion requires an exact reconciled receipt");
        const key = ref(input.userId, "funding.observation", input.event.id),
          digest = hash(input.event),
          prior = await priorEvent(client, input.userId, key);
        if (prior) {
          if (prior.requestId !== request.id || prior.termsDigest !== digest)
            error("external funding observation idempotency conflict");
          return { ...request, created: false };
        }
        const previous: ExternalOperationStatus =
          request.status === "completed"
            ? "completed"
            : request.status === "failed"
              ? "failed"
              : request.status === "uncertain"
                ? "uncertain"
                : "pending";
        const transition = observeExternalOperation(
          {
            termsDigest: request.termsDigest,
            externalId: request.id,
            status: previous,
            transactionId: null,
          },
          input.event,
        );
        const snapshot = await lockSandboxBook(client, input.userId);
        if (request.status !== transition.state.status)
          await client.query(
            "UPDATE coin_sandbox_requests SET status=$2 WHERE id=$1",
            [request.id, transition.state.status],
          );
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: snapshot.book,
          kind: "funding.observed",
          reference: key,
          termsDigest: digest,
          requestId: request.id,
          metadata: {
            observation: input.event,
            rail: config.rail,
            actorRole: "yaparena_owner",
            cashIssued: false,
          },
        });
        return { ...request, status: transition.state.status, created: true };
      });
    },
    async review(input: {
      userId: string;
      requestId: string;
      decision: "approve" | "reject";
      idempotencyKey: string;
    }) {
      if (input.decision !== "approve" && input.decision !== "reject")
        error("invalid review decision", 400);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const request = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        if (request.kind !== "withdrawal" || request.terms.rail !== config.rail)
          error("withdrawal request required");
        const key = ref(
            input.userId,
            "withdrawal.review",
            input.idempotencyKey,
          ),
          prior = await priorEvent(client, input.userId, key);
        if (prior) {
          if (
            prior.requestId !== request.id ||
            prior.metadata.decision !== input.decision
          )
            error("review idempotency conflict");
          return { ...request, created: false };
        }
        if (request.status !== "review")
          error("withdrawal is not awaiting review");
        if (input.decision === "approve")
          await assertSandboxNewPayoutAuthorization(client, input.userId);
        const snapshot = await lockSandboxBook(client, input.userId),
          buckets = await ensureSandboxBuckets(client, input.userId);
        const approved = input.decision === "approve",
          gross = request.terms.gross!,
          restored = approved
            ? null
            : restoreWithdrawalSources(
                snapshot.book,
                await savedReservation(client, request),
                backing(snapshot.book),
              );
        const cashJournalId = await journal(client, {
          userId: input.userId,
          reference: ref(input.userId, "withdrawal.review.cash", request.id),
          operation: approved ? "reserve" : "release",
          postings: [
            { accountId: buckets.cashReserved, amount: String(-BigInt(gross)) },
            {
              accountId: approved ? buckets.cashPending : buckets.cashAvailable,
              amount: gross,
            },
          ],
        });
        const status = approved ? "approved" : "failed";
        await client.query(
          "UPDATE coin_sandbox_requests SET status=$2 WHERE id=$1",
          [request.id, status],
        );
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: restored?.book ?? snapshot.book,
          kind: approved ? "withdrawal.approved" : "withdrawal.rejected",
          reference: key,
          termsDigest: request.termsDigest,
          requestId: request.id,
          cashJournalId,
          metadata: {
            decision: input.decision,
            actorRole: "yaparena_owner",
            rail: config.rail,
            noSubmission: !approved,
          },
        });
        return { ...request, status, created: true };
      });
    },
    async observe(input: {
      userId: string;
      requestId: string;
      event: ExternalObservation;
      receipt?: SandboxTransferReceipt;
    }) {
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const request = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        if (
          request.kind !== "withdrawal" ||
          request.terms.rail !== config.rail ||
          input.event.externalId !== request.id ||
          input.event.termsDigest !== request.termsDigest
        )
          error("external operation does not match its local request");
        if (
          !["approved", "pending", "uncertain", "completed", "failed"].includes(
            request.status,
          )
        )
          error("withdrawal has not been approved");
        const key = ref(input.userId, "external.observation", input.event.id),
          prior = await priorEvent(client, input.userId, key),
          digest = hash([input.event, input.receipt ?? null]);
        if (prior) {
          if (prior.requestId !== request.id || prior.termsDigest !== digest)
            error("external observation idempotency conflict");
          return { ...request, created: false };
        }
        const previous: ExternalOperationStatus =
          request.status === "completed"
            ? "completed"
            : request.status === "failed"
              ? "failed"
              : request.status === "uncertain"
                ? "uncertain"
                : "pending";
        const transition = observeExternalOperation(
          {
            termsDigest: request.termsDigest,
            externalId: request.id,
            status: previous,
            transactionId:
              request.status === "completed"
                ? ((
                    await client.query<{ id: string }>(
                      "SELECT transaction_id AS id FROM coin_external_receipts WHERE request_id=$1 ORDER BY created_at LIMIT 1",
                      [request.id],
                    )
                  ).rows[0]?.id ?? null)
                : null,
          },
          input.event,
        );
        const snapshot = await lockSandboxBook(client, input.userId);
        let after = snapshot.book,
          cashJournalId: string | undefined;
        const settledSources: {
          sourceId: string;
          kind: string;
          gross: string;
          fee: string;
          net: string;
        }[] = [];
        if (transition.disposition !== "retain") {
          const buckets = await ensureSandboxBuckets(client, input.userId),
            gross = request.terms.gross!;
          if (transition.disposition === "settle") {
            if (
              !input.receipt ||
              input.receipt.transactionId !== input.event.transactionId
            )
              error(
                "completion requires the original reconciled transfer receipt",
              );
            await receipt(
              client,
              request,
              input.receipt,
              request.terms.net!,
              config.network,
            );
            const reservation = await savedReservation(client, request);
            const feeShares = allocateAtomicProportionally(
              BigInt(request.terms.fee!),
              reservation.sources.map((source) => BigInt(source.amount)),
            );
            const postings = [
              {
                accountId: buckets.cashPending,
                amount: String(-BigInt(gross)),
              },
            ];
            for (const [index, source] of reservation.sources.entries()) {
              const net = BigInt(source.amount) - feeShares[index]!;
              settledSources.push({
                sourceId: source.id,
                kind: source.kind,
                gross: source.amount,
                fee: String(feeShares[index]!),
                net: String(net),
              });
              if (net > 0n)
                postings.push({
                  accountId:
                    source.kind === "grant"
                      ? buckets.system.promotional_external
                      : buckets.system.purchased_external,
                  amount: String(net),
                });
            }
            if (BigInt(request.terms.fee!))
              postings.push({
                accountId: buckets.system.fees,
                amount: request.terms.fee!,
              });
            cashJournalId = await journal(client, {
              userId: input.userId,
              reference: ref(input.userId, "withdrawal.settle", request.id),
              operation: "payout",
              postings,
            });
          } else {
            after = restoreWithdrawalSources(
              snapshot.book,
              await savedReservation(client, request),
              backing(snapshot.book),
            ).book;
            cashJournalId = await journal(client, {
              userId: input.userId,
              reference: ref(input.userId, "withdrawal.release", request.id),
              operation: "release",
              postings: [
                {
                  accountId: buckets.cashPending,
                  amount: String(-BigInt(gross)),
                },
                { accountId: buckets.cashAvailable, amount: gross },
              ],
            });
          }
        }
        await client.query(
          "UPDATE coin_sandbox_requests SET status=$2 WHERE id=$1",
          [request.id, transition.state.status],
        );
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: after,
          kind: `withdrawal.external.${input.event.status}`,
          reference: key,
          termsDigest: digest,
          requestId: request.id,
          cashJournalId,
          metadata: {
            event: input.event,
            disposition: transition.disposition,
            rail: config.rail,
            settledSources,
          },
        });
        return {
          ...request,
          status: transition.state.status,
          created: true,
          disposition: transition.disposition,
        };
      });
    },
    async seedSandboxTreasury(input: {
      userId: string;
      purpose: "promotional" | "center" | "correction";
      amount: string;
      idempotencyKey: string;
    }) {
      if (config.rail !== "simulation")
        error("invented treasury credits cannot enter the testnet ledger", 403);
      atomicAmount(input.amount);
      if (!["promotional", "center", "correction"].includes(input.purpose))
        error("invalid treasury purpose", 400);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const key = ref(
            input.userId,
            "treasury.simulation",
            input.idempotencyKey,
          ),
          terms = {
            rail: config.rail,
            purpose: input.purpose,
            amount: input.amount,
            simulation: "true",
          },
          digest = accountOperationTermsDigest(terms),
          prior = await priorEvent(client, input.userId, key);
        if (prior) {
          if (prior.termsDigest !== digest)
            error("treasury idempotency conflict");
          return { created: false };
        }
        const snapshot = await lockSandboxBook(client, input.userId),
          buckets = await ensureSandboxBuckets(client, input.userId);
        const source =
          input.purpose === "promotional"
            ? buckets.system.promotional_external
            : buckets.system.center_external;
        const destination =
          input.purpose === "promotional"
            ? buckets.system.promotional_available
            : input.purpose === "center"
              ? buckets.system.center_available
              : buckets.system.correction_available;
        const cashJournalId = await journal(client, {
          userId: input.userId,
          reference: ref(
            input.userId,
            "treasury.simulation.cash",
            input.idempotencyKey,
          ),
          operation: "funding",
          postings: [
            { accountId: source, amount: String(-BigInt(input.amount)) },
            { accountId: destination, amount: input.amount },
          ],
        });
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: snapshot.book,
          kind: "treasury.seed.simulation",
          reference: key,
          termsDigest: digest,
          cashJournalId,
          metadata: {
            ...terms,
            actorRole: "yaparena_owner",
            notRealMoney: true,
          },
        });
        return { created: true };
      });
    },
    async correctFunding(input: {
      userId: string;
      requestId: string;
      idempotencyKey: string;
      reason: "incorrect_funding" | "operator_error";
      review?: PreparedFundingCorrectionReview;
    }) {
      if (!["incorrect_funding", "operator_error"].includes(input.reason))
        error("invalid correction reason", 400);
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const original = await requestForUpdate(
          client,
          input.userId,
          input.requestId,
        );
        if (original.kind !== "funding" || original.status !== "completed")
          error("completed funding request is required");
        if (input.review) await input.review.validate(client, original.id);
        const key = ref(
            input.userId,
            "funding.correction",
            input.idempotencyKey,
          ),
          prior = await priorEvent(client, input.userId, key);
        if (prior) {
          if (
            prior.metadata.originalRequestId !== original.id ||
            prior.metadata.reason !== input.reason
          )
            error("correction idempotency conflict");
          return { created: false };
        }
        const funded = await priorEvent(
          client,
          input.userId,
          ref(input.userId, "funding.completed", original.id),
        );
        if (!funded?.cashJournalId)
          error("original funding journal is unavailable", 503);
        if (
          (
            await client.query(
              "SELECT 1 FROM coin_journals WHERE reversal_of=$1",
              [funded.cashJournalId],
            )
          ).rowCount
        )
          error("funding was already corrected");
        const snapshot = await lockSandboxBook(client, input.userId);
        let after = snapshot.book,
          cashJournalId: string | undefined,
          status = "completed";
        try {
          after = planPurchaseRefund(
            snapshot.book,
            original.id,
            original.terms.amount!,
          ).book;
        } catch (failure) {
          if (!(failure instanceof CoinOperationError)) throw failure;
          status = "uncertain";
        }
        const id = randomUUID(),
          terms = {
            requestId: id,
            environment: "sandbox",
            asset: "USDC",
            precision: "6",
            network: config.network,
            originalRequestId: original.id,
            reason: input.reason,
            rail: config.rail,
            ...(input.review ? { reviewId: input.review.id } : {}),
          };
        await insertRequest(client, {
          id,
          userId: input.userId,
          kind: "correction",
          reference: key,
          terms,
          status,
        });
        if (status === "completed")
          cashJournalId = (
            await reverseCoinJournal(client, {
              originalId: funded.cashJournalId,
              environment: "sandbox",
              reference: ref(
                input.userId,
                "funding.correction.reversal",
                original.id,
              ),
            })
          ).id;
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: after,
          kind:
            status === "completed"
              ? "funding.correction.reversed"
              : "funding.correction.review_required",
          reference: key,
          termsDigest: accountOperationTermsDigest(terms),
          requestId: id,
          cashJournalId,
          metadata: {
            ...terms,
            actorRole: "yaparena_owner",
            financialReviewRequired: status === "uncertain",
          },
        });
        return {
          created: true,
          requestId: id,
          status,
          financialReviewRequired: status === "uncertain",
        };
      });
    },
    async retryCorrection(input: {
      userId: string;
      correctionId: string;
      idempotencyKey: string;
      review?: PreparedFundingCorrectionReview;
    }) {
      return ownerTx(database, config.rail, input.userId, async (client) => {
        const correction = await requestForUpdate(
          client,
          input.userId,
          input.correctionId,
        );
        if (
          correction.kind !== "correction" ||
          !correction.terms.originalRequestId ||
          correction.terms.rail !== config.rail
        )
          error("funding correction request is required");
        if (input.review) {
          if (
            correction.terms.reviewId &&
            correction.terms.reviewId !== input.review.id
          )
            error(
              "correction review differs from its original authorization",
              403,
            );
          await input.review.validate(
            client,
            correction.terms.originalRequestId,
          );
        }
        const key = ref(
            input.userId,
            "funding.correction.retry",
            input.idempotencyKey,
          ),
          prior = await priorEvent(client, input.userId, key);
        if (prior) {
          if (prior.requestId !== correction.id)
            error("correction retry idempotency conflict");
          return { created: false, status: correction.status };
        }
        if (correction.status !== "uncertain")
          error("correction is not awaiting reconciliation");
        const original = await requestForUpdate(
          client,
          input.userId,
          correction.terms.originalRequestId,
        );
        const funded = await priorEvent(
          client,
          input.userId,
          ref(input.userId, "funding.completed", original.id),
        );
        if (original.kind !== "funding" || !funded?.cashJournalId)
          error("original funding journal unavailable", 503);
        const snapshot = await lockSandboxBook(client, input.userId);
        const existing = (
          await client.query<{ id: string }>(
            "SELECT id FROM coin_journals WHERE reversal_of=$1",
            [funded.cashJournalId],
          )
        ).rows[0];
        const after = existing
          ? snapshot.book
          : planPurchaseRefund(
              snapshot.book,
              original.id,
              original.terms.amount!,
            ).book;
        const cashJournalId =
          existing?.id ??
          (
            await reverseCoinJournal(client, {
              originalId: funded.cashJournalId,
              environment: "sandbox",
              reference: ref(
                input.userId,
                "funding.correction.reversal",
                original.id,
              ),
            })
          ).id;
        await client.query(
          "UPDATE coin_sandbox_requests SET status='completed' WHERE id=$1",
          [correction.id],
        );
        await appendSandboxBookEvent(client, {
          userId: input.userId,
          snapshot,
          book: after,
          kind: "funding.correction.resolved",
          reference: key,
          termsDigest: correction.termsDigest,
          requestId: correction.id,
          cashJournalId,
          metadata: {
            originalRequestId: original.id,
            actorRole: "yaparena_owner",
            resolvedByExistingReversal: Boolean(existing),
            ...(input.review ? { reviewId: input.review.id } : {}),
            rail: config.rail,
          },
        });
        return { created: true, status: "completed" };
      });
    },
  });
}
