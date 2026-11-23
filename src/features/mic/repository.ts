import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  databaseFailure,
  withTransaction,
  type TransactionOptions,
} from "../../platform/transaction.ts";
import {
  assertActiveSession,
  lockAccount,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
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
  assertSandboxFinancialOpen,
  assertSandboxOpened,
  assertSandboxRail,
  ensureSandboxBuckets,
  lockSandboxBooks,
  type SandboxBookSnapshot,
  type SandboxBuckets,
  type SandboxContext,
  type SandboxRail,
} from "../account-wallet/sandbox-repository.ts";
import {
  COIN_REQUEST_LIMITS,
  lockLedger,
} from "../account-wallet/debate-sandbox.ts";
import { viewerIdsNow } from "../presence/repository.ts";
import {
  checkPledge,
  checkQuestion,
  fire,
  MicError,
  ranked,
  splitToDebaters,
  total,
  withdrawal,
  YC,
  type Actor,
  type Mic,
  type MicList,
  type Pledge,
  type Question,
  type Side,
} from "./rules.ts";
import { askerKind, type MicTurnKind } from "./turn-kinds.ts";

// Decision 0018, PR 2a: the list on the database and the coin ledger.
//
// Every pledge (a question's wager included) is a hold: the pledger's own
// available Yap Coins move to their own reserved accounts, grant coins first,
// exactly as a debate stake reserves them. Withdrawing, or another question of
// the camp firing, reverses the hold to the same sources. Firing spends the
// fired question's holds: cash-backed coins go to the two seated debaters,
// grant coins are burned to the grant issuer and the center treasury pays the
// debaters the same amount, so the debaters receive everything as cash-backed
// Yap Coins, in equal halves (L15, founder 2026-11-23).
//
// Locks, in one order everywhere: the caller's account row, the list row FOR
// UPDATE, the sandbox books (ascending account id), then the ledger accounts
// (lockLedger). The list lock decides "is this the #1?" and the fire under
// one lock, so an outbid and a fire that arrive together cannot both win (F1).

type ListRow = MicList & { debateId: string; n: number; extra: boolean };
interface QuestionRow {
  id: string;
  list_id: string;
  author_id: string;
  target: Side;
  body: string;
  seq: string;
  state: Question["state"];
}
interface PledgeRow {
  id: string;
  question_id: string;
  user_id: string;
  amount: string;
  wager: boolean;
  add_text: string | null;
  state: Pledge["state"];
  funding: StakeFunding;
}
interface MicRow {
  id: string;
  list_id: string;
  camp: Side;
  question_id: string;
  holder_id: string;
  target: Side;
  state: Mic["state"];
  price: string;
}
interface Loaded {
  questions: Question[];
  mics: Mic[];
  pledges: Map<string, PledgeRow>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reference = (userId: string, operation: string, key: string) =>
  coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byAccount = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const coins = (atoms: bigint) => Number(atoms / YC);

function found(id: string, what: string) {
  if (!uuid.test(id)) throw new MicError(`${what} not found`, 404);
}
// The grant and cash parts of a hold, as debate stakes split them (a grant's
// principal is grant coins; its profit and purchases are cash-backed).
function fundingTotals(funding: StakeFunding) {
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

/**
 * Opens a debate's next list, unless one is open already. The turn engine
 * calls it when both debaters complete three rounds (L2); tests call it too.
 */
export async function createList(
  client: PoolClient,
  debateId: string,
  openedRound: number,
  extra: boolean,
) {
  found(debateId, "debate");
  if (!Number.isSafeInteger(openedRound) || openedRound < 1)
    throw new MicError("invalid opening round", 400);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('mic-list:'||$1::text,0))",
    [debateId],
  );
  const open = (
    await client.query<{ id: string; n: number }>(
      "SELECT id,n FROM mic_lists WHERE debate_id=$1 AND state='open'",
      [debateId],
    )
  ).rows[0];
  if (open) return { id: open.id, n: open.n, created: false };
  const id = randomUUID();
  const n = (
    await client.query<{ n: number }>(
      `INSERT INTO mic_lists(id,debate_id,n,extra,opened_round)
      SELECT $1,$2,COALESCE(max(n),0)+1,$3,$4 FROM mic_lists WHERE debate_id=$2
      RETURNING n`,
      [id, debateId, extra, openedRound],
    )
  ).rows[0]!.n;
  return { id, n, created: true };
}

async function loadList(client: PoolClient, list: ListRow): Promise<Loaded> {
  const questionRows = (
    await client.query<QuestionRow>(
      `SELECT id,list_id,author_id::text,target,body,seq::text,state
      FROM mic_questions WHERE list_id=$1 ORDER BY seq`,
      [list.id],
    )
  ).rows;
  const pledgeRows = (
    await client.query<PledgeRow>(
      `SELECT p.id,p.question_id,p.user_id::text,p.amount::text,p.wager,p.add_text,
        p.state,p.funding
      FROM mic_pledges p JOIN mic_questions q ON q.id=p.question_id
      WHERE q.list_id=$1 ORDER BY p.created_at,p.id`,
      [list.id],
    )
  ).rows;
  const micRows = (
    await client.query<MicRow>(
      `SELECT id,list_id,camp,question_id,holder_id::text,target,state,price::text
      FROM mic_mics WHERE debate_id=$1 ORDER BY fired_at,id`,
      [list.debateId],
    )
  ).rows;
  const questions = questionRows.map((row): Question => ({
    id: row.id,
    listId: row.list_id,
    author: row.author_id,
    target: row.target,
    text: row.body,
    seq: Number(row.seq),
    state: row.state,
    pledges: pledgeRows
      .filter((pledge) => pledge.question_id === row.id)
      .map((pledge) => ({
        id: pledge.id,
        account: pledge.user_id,
        amount: BigInt(pledge.amount),
        wager: pledge.wager,
        add: pledge.add_text,
        state: pledge.state,
      })),
  }));
  const mics = micRows.map((row): Mic => ({
    id: row.id,
    listId: row.list_id,
    camp: row.camp,
    questionId: row.question_id,
    holder: row.holder_id,
    target: row.target,
    state: row.state,
    price: BigInt(row.price),
  }));
  return {
    questions,
    mics,
    pledges: new Map(pledgeRows.map((row) => [row.id, row])),
  };
}

interface PublicQuestion {
  id: string;
  target: Side;
  text: string;
  author: string | null;
  total: number;
  pledges: number;
  adds: { text: string; by: string | null }[];
}
export interface PublicMicList {
  debateId: string;
  list: {
    id: string;
    n: number;
    extra: boolean;
    state: MicList["state"];
    openedRound: number;
    // Each camp's open questions, highest total first (L7 to L9).
    camps: Record<Side, PublicQuestion[]>;
  } | null;
  mics: {
    id: string;
    listId: string;
    camp: Side;
    target: Side;
    state: Mic["state"];
    price: number;
    holder: string | null;
    questionId: string;
    text: string;
    // PR 2b: whether the turn engine has started it, and the turn it cut
    // (F15: whom it cut and the time they lost).
    started: boolean;
    cut: { turnNumber: number; side: Side; lostMs: number } | null;
  }[];
  // The mic turn now on the clock, or null in a debater's own turn.
  turn: {
    turnNumber: number;
    micId: string;
    kind: MicTurnKind;
    // Who has the floor: the asker, in their own turns, or a debater.
    speaker: "asker" | Side;
    side: Side; // the clock's side, the asker's camp in their turns (E11)
    asker: string | null;
    target: Side;
    text: string | null; // the asker's typed text, as typed (E9)
    deadline: Date | null; // null while the debate is paused
  } | null;
}

/**
 * The public list of a published debate: its open list (or, with none open,
 * its latest), each camp's open questions ranked with their public totals
 * (L7), the paid comments under them, and the debate's mics. Names are
 * published profile handles; nothing else about an account is shown.
 */
export async function readList(
  client: PoolClient,
  debateId: string,
): Promise<PublicMicList | null> {
  if (!uuid.test(debateId)) return null;
  if (
    !(
      await client.query(
        `SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id
        WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
        [debateId],
      )
    ).rowCount
  )
    return null;
  const list = (
    await client.query<ListRow>(
      `SELECT id,debate_id AS "debateId",n,extra,state,opened_round AS "openedRound"
      FROM mic_lists WHERE debate_id=$1 ORDER BY (state='open') DESC,n DESC LIMIT 1`,
      [debateId],
    )
  ).rows[0];
  const handles = new Map(
    (
      await client.query<{ userId: string; handle: string }>(
        `SELECT p.user_id::text AS "userId",p.handle FROM public_profiles p
        WHERE p.publication_state='published' AND p.user_id IN (
          SELECT author_id FROM mic_questions WHERE debate_id=$1
          UNION SELECT p2.user_id FROM mic_pledges p2
            JOIN mic_questions q ON q.id=p2.question_id WHERE q.debate_id=$1
          UNION SELECT holder_id FROM mic_mics WHERE debate_id=$1)`,
        [debateId],
      )
    ).rows.map((row) => [row.userId, row.handle]),
  );
  const handle = (account: string) => handles.get(account) ?? null;
  const runs = new Map(
    (
      await client.query<{
        micId: string;
        turnNumber: number | null;
        side: Side | null;
        lostMs: number | null;
      }>(
        `SELECT mic_id AS "micId",cut_turn_number AS "turnNumber",cut_side AS side,
          lost_ms AS "lostMs" FROM mic_runs WHERE debate_id=$1`,
        [debateId],
      )
    ).rows.map((row) => [row.micId, row]),
  );
  const current = (
    await client.query<{
      turnNumber: number;
      micId: string;
      kind: MicTurnKind;
      side: Side;
      text: string | null;
      holder: string;
      target: Side;
      deadline: Date | null;
    }>(
      `SELECT t.turn_number AS "turnNumber",t.mic_id AS "micId",t.kind,t.side,t.text,
        m.holder_id::text AS holder,m.target,dm.turn_deadline_at AS deadline
      FROM debate_media dm
      JOIN mic_turns t ON t.debate_id=dm.debate_id AND t.turn_number=dm.turn_number
      JOIN mic_mics m ON m.id=t.mic_id
      WHERE dm.debate_id=$1 AND dm.state IN ('running','paused')`,
      [debateId],
    )
  ).rows[0];
  const fired = new Map(
    (
      await client.query<{ id: string; body: string }>(
        `SELECT q.id,q.body FROM mic_mics m JOIN mic_questions q ON q.id=m.question_id
        WHERE m.debate_id=$1`,
        [debateId],
      )
    ).rows.map((row) => [row.id, row.body]),
  );
  const loaded = list
    ? await loadList(client, list)
    : {
        questions: [],
        mics: (
          await client.query<MicRow>(
            `SELECT id,list_id,camp,question_id,holder_id::text,target,state,price::text
            FROM mic_mics WHERE debate_id=$1 ORDER BY fired_at,id`,
            [debateId],
          )
        ).rows.map((row): Mic => ({
          id: row.id,
          listId: row.list_id,
          camp: row.camp,
          questionId: row.question_id,
          holder: row.holder_id,
          target: row.target,
          state: row.state,
          price: BigInt(row.price),
        })),
      };
  const publicQuestion = (question: Question): PublicQuestion => {
    const held = question.pledges.filter((p) => p.state === "held");
    return {
      id: question.id,
      target: question.target,
      text: question.text,
      author: handle(question.author),
      total: coins(total(question)),
      pledges: held.length,
      adds: held
        .filter((p) => p.add !== null)
        .map((p) => ({ text: p.add!, by: handle(p.account) })),
    };
  };
  return {
    debateId,
    list: list
      ? {
          id: list.id,
          n: list.n,
          extra: list.extra,
          state: list.state,
          openedRound: list.openedRound,
          camps: {
            A: ranked(loaded.questions, list.id, "A").map(publicQuestion),
            B: ranked(loaded.questions, list.id, "B").map(publicQuestion),
          },
        }
      : null,
    mics: loaded.mics.map((mic) => ({
      id: mic.id,
      listId: mic.listId,
      camp: mic.camp,
      target: mic.target,
      state: mic.state,
      price: coins(mic.price),
      holder: handle(mic.holder),
      questionId: mic.questionId,
      text: fired.get(mic.questionId) ?? "",
      started: runs.has(mic.id),
      cut: ((run) =>
        run?.turnNumber != null && run.side && run.lostMs != null
          ? { turnNumber: run.turnNumber, side: run.side, lostMs: run.lostMs }
          : null)(runs.get(mic.id)),
    })),
    turn: current
      ? {
          turnNumber: current.turnNumber,
          micId: current.micId,
          kind: current.kind,
          speaker: askerKind(current.kind) ? "asker" : current.side,
          side: current.side,
          asker: handle(current.holder),
          target: current.target,
          text: current.text,
          deadline: current.deadline,
        }
      : null,
  };
}

const busyError = () =>
  new CoinOperationError(
    "Yap Coins are busy; try again. Nothing was held.",
    503,
    "busy",
  );
const idempotencyConflict = () =>
  new MicError("this request id was used for a different request", 409);

export function createMicRepository(
  database: Pool,
  rail: SandboxRail,
  options: {
    limits?: TransactionOptions;
    // Starts a live mic in the turn engine; never throws (turns.ts start).
    afterFire?: (debateId: string) => Promise<unknown>;
  } = {},
) {
  const limits = options.limits ?? COIN_REQUEST_LIMITS;
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    return withTransaction(
      database,
      async (client) => {
        await assertSandboxRail(client, rail);
        return work(client);
      },
      {
        ...limits,
        mapError: (error) =>
          databaseFailure(error) === "busy" ? busyError() : error,
      },
    ).catch((error: unknown) => {
      throw error instanceof Error &&
        error.message === "timeout exceeded when trying to connect"
        ? busyError()
        : error;
    });
  }
  // The caller's account and session first, as every sandbox write does.
  async function authorized<T>(
    context: SandboxContext,
    work: (client: PoolClient) => Promise<T>,
  ) {
    return transaction(async (client) => {
      if (!(await lockAccount(client, context.userId)))
        throw new SessionUnavailableError("account unavailable");
      const session = await assertActiveSession(
        client,
        context.userId,
        context.sessionTokenHash,
      );
      if (
        context.expectedSessionId !== undefined &&
        session.id !== context.expectedSessionId
      )
        throw new CoinOperationError(
          "account context changed; refresh balances and review again",
          409,
          "session_changed",
        );
      await assertSandboxOpened(client, context.userId);
      await assertSandboxFinancialOpen(client, context.userId);
      return work(client);
    });
  }
  async function openList(client: PoolClient, debateId: string) {
    return (
      await client.query<ListRow>(
        `SELECT id,debate_id AS "debateId",n,extra,state,opened_round AS "openedRound"
        FROM mic_lists WHERE debate_id=$1 AND state='open' FOR UPDATE`,
        [debateId],
      )
    ).rows[0];
  }
  async function assertLive(client: PoolClient, debateId: string) {
    const debate = (
      await client.query<{ status: string }>(
        `SELECT d.status FROM debates d JOIN topics t ON t.id=d.topic_id
        WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
        [debateId],
      )
    ).rows[0];
    if (!debate) throw new MicError("debate not found", 404);
    // L18: the list is for viewers of the live debate, never its replay.
    if (debate.status !== "live")
      throw new MicError("the mic is only open while the debate is live");
  }
  async function seats(client: PoolClient, debateId: string) {
    const row = (
      await client.query<{ a: string | null; b: string | null }>(
        `SELECT pa.user_id::text AS a,pb.user_id::text AS b FROM debates d
        LEFT JOIN public_profiles pa ON pa.id=d.speaker_a_profile_id
        LEFT JOIN public_profiles pb ON pb.id=d.speaker_b_profile_id
        WHERE d.id=$1`,
        [debateId],
      )
    ).rows[0];
    return { A: row?.a ?? null, B: row?.b ?? null };
  }
  async function actorFor(
    client: PoolClient,
    debateId: string,
    userId: string,
  ): Promise<Actor> {
    const seat = await seats(client, debateId);
    const seated = seat.A === userId || seat.B === userId;
    return {
      account: userId,
      // A seated debater is on stage, never counted present (Decision 0017),
      // so the rules refuse them as a debater (L17), not as absent.
      present:
        seated || (await viewerIdsNow(client, debateId)).includes(userId),
      seated,
      // Seat replacement (S14) is a later pull request: until then nobody
      // leaves a seat during a debate.
      heldSeat: false,
    };
  }
  async function priorPledge(client: PoolClient, key: string) {
    return (
      await client.query<{
        id: string;
        question_id: string;
        user_id: string;
        amount: string;
        wager: boolean;
        add_text: string | null;
        target: Side;
        body: string;
        debate_id: string;
      }>(
        `SELECT p.id,p.question_id,p.user_id::text,p.amount::text,p.wager,p.add_text,
          q.target,q.body,q.debate_id
        FROM mic_pledges p JOIN mic_questions q ON q.id=p.question_id WHERE p.request_id=$1`,
        [key],
      )
    ).rows[0];
  }
  // Books in ascending account order, then their buckets, then every ledger
  // account they can touch, before the first journal.
  async function lockMoney(client: PoolClient, accounts: readonly string[]) {
    const ids = [...new Set(accounts)].sort(byAccount);
    const books = await lockSandboxBooks(client, ids);
    const buckets = new Map<string, SandboxBuckets>();
    for (const id of ids)
      buckets.set(id, await ensureSandboxBuckets(client, id));
    await lockLedger(client, [...buckets.values()]);
    return { books, buckets };
  }
  // A pledge's hold: available to reserved, on the pledger's own accounts.
  async function hold(
    client: PoolClient,
    input: {
      userId: string;
      debateId: string;
      questionId: string;
      pledgeId: string;
      amount: bigint;
      wager: boolean;
      add: string | null;
      requestKey: string;
    },
  ) {
    const { books, buckets } = await lockMoney(client, [input.userId]);
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
    await client.query(
      `INSERT INTO mic_pledges(id,question_id,user_id,amount,wager,add_text,funding,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        input.pledgeId,
        input.questionId,
        input.userId,
        String(input.amount),
        input.wager,
        input.add,
        JSON.stringify(plan.funding),
        input.requestKey,
      ],
    );
    await appendSandboxBookEvent(client, {
      userId: input.userId,
      snapshot: before,
      book: plan.book,
      kind: "mic.held",
      reference: reference(input.userId, "mic.hold", input.pledgeId),
      termsDigest: digest([
        input.pledgeId,
        input.questionId,
        String(input.amount),
        plan.funding,
      ]),
      cashJournalId,
      promoJournalId,
      metadata: {
        debateId: input.debateId,
        questionId: input.questionId,
        pledgeId: input.pledgeId,
        wager: input.wager,
        funding: plan.funding,
        rail,
      },
    });
  }
  // The exact reverse of a hold, to the same sources (as a voided stake).
  async function release(
    client: PoolClient,
    pledge: PledgeRow,
    before: SandboxBookSnapshot,
    bucket: SandboxBuckets,
    reason: "withdrawn" | "question_removed" | "camp_fired",
  ) {
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
      termsDigest: digest([pledge.id, reason, pledge.funding]),
      cashJournalId,
      promoJournalId,
      metadata: {
        questionId: pledge.question_id,
        pledgeId: pledge.id,
        reason,
        funding: pledge.funding,
        rail,
      },
    });
    await client.query(
      "UPDATE mic_pledges SET state='refunded',refund_reason=$2 WHERE id=$1",
      [pledge.id, reason],
    );
    return advanced(before, book);
  }

  return Object.freeze({
    /** Opens the debate's next list in its own transaction (see createList). */
    createList(debateId: string, openedRound: number, extra = false) {
      return transaction((client) =>
        createList(client, debateId, openedRound, extra),
      );
    },
    /** The public list; null when the debate is not published. */
    read(debateId: string) {
      return transaction((client) => readList(client, debateId));
    },
    /** L5, L16, L21: a viewer's question with its wager, held at once. */
    submitQuestion(
      context: SandboxContext,
      debateId: string,
      input: { target: Side; text: string; wager: bigint; requestId: string },
    ) {
      found(debateId, "debate");
      const requestKey = reference(
        context.userId,
        "mic.request",
        input.requestId,
      );
      return authorized(context, async (client) => {
        const list = await openList(client, debateId);
        const prior = await priorPledge(client, requestKey);
        if (prior) {
          if (
            !prior.wager ||
            prior.debate_id !== debateId ||
            prior.target !== input.target ||
            prior.body !== input.text.trim() ||
            BigInt(prior.amount) !== input.wager
          )
            throw idempotencyConflict();
          return {
            questionId: prior.question_id,
            pledgeId: prior.id,
            created: false,
          };
        }
        await assertLive(client, debateId);
        const loaded = list
          ? await loadList(client, list)
          : { questions: [], mics: [] };
        const checked = checkQuestion({
          list,
          questions: loaded.questions,
          mics: loaded.mics,
          actor: await actorFor(client, debateId, context.userId),
          target: input.target,
          text: input.text,
          wager: input.wager,
        });
        // checkQuestion refuses a missing list, so the list is open here.
        const open = list!;
        const questionId = randomUUID(),
          pledgeId = randomUUID();
        await client.query(
          `INSERT INTO mic_questions(id,list_id,debate_id,author_id,target,body,seq)
          SELECT $1,$2,$3,$4,$5,$6,COALESCE(max(seq),0)+1 FROM mic_questions WHERE list_id=$2`,
          [
            questionId,
            open.id,
            debateId,
            context.userId,
            input.target,
            checked.text,
          ],
        );
        await hold(client, {
          userId: context.userId,
          debateId,
          questionId,
          pledgeId,
          amount: checked.wager,
          wager: true,
          add: null,
          requestKey,
        });
        return { questionId, pledgeId, created: true };
      });
    },
    /** L6, L16, L19: a pledge to an open question, with an optional comment. */
    pledge(
      context: SandboxContext,
      debateId: string,
      questionId: string,
      input: { amount: bigint; add?: string | null; requestId: string },
    ) {
      found(debateId, "debate");
      found(questionId, "question");
      const requestKey = reference(
        context.userId,
        "mic.request",
        input.requestId,
      );
      return authorized(context, async (client) => {
        const list = await openList(client, debateId);
        const prior = await priorPledge(client, requestKey);
        if (prior) {
          if (
            prior.wager ||
            prior.debate_id !== debateId ||
            prior.question_id !== questionId ||
            BigInt(prior.amount) !== input.amount ||
            (prior.add_text ?? "") !== (input.add ?? "").trim()
          )
            throw idempotencyConflict();
          return { questionId, pledgeId: prior.id, created: false };
        }
        await assertLive(client, debateId);
        if (!list) throw new MicError("the list isn't open");
        const loaded = await loadList(client, list);
        const question = loaded.questions.find((q) => q.id === questionId);
        if (!question) throw new MicError("question not found", 404);
        const checked = checkPledge({
          list,
          question,
          actor: await actorFor(client, debateId, context.userId),
          amount: input.amount,
          add: input.add ?? null,
        });
        const pledgeId = randomUUID();
        await hold(client, {
          userId: context.userId,
          debateId,
          questionId,
          pledgeId,
          amount: checked.amount,
          wager: false,
          add: checked.add,
          requestKey,
        });
        return { questionId, pledgeId, created: true };
      });
    },
    /**
     * L11, L20: withdraws a pledge, at any time until its camp fires.
     * Withdrawing the wager removes the question and refunds every pledge.
     * Repeating a withdrawal that went through changes nothing.
     */
    withdraw(context: SandboxContext, debateId: string, pledgeId: string) {
      found(debateId, "debate");
      found(pledgeId, "pledge");
      return authorized(context, async (client) => {
        const where = (
          await client.query<{ listId: string }>(
            `SELECT q.list_id AS "listId" FROM mic_pledges p
            JOIN mic_questions q ON q.id=p.question_id
            WHERE p.id=$1 AND q.debate_id=$2 AND p.user_id=$3`,
            [pledgeId, debateId, context.userId],
          )
        ).rows[0];
        if (!where) throw new MicError("nothing to withdraw", 404);
        const list = (
          await client.query<ListRow>(
            `SELECT id,debate_id AS "debateId",n,extra,state,opened_round AS "openedRound"
            FROM mic_lists WHERE id=$1 FOR UPDATE`,
            [where.listId],
          )
        ).rows[0]!;
        const loaded = await loadList(client, list);
        const pledge = loaded.pledges.get(pledgeId)!;
        const question = loaded.questions.find(
          (q) => q.id === pledge.question_id,
        )!;
        if (pledge.state === "refunded")
          return {
            pledgeId,
            questionId: question.id,
            removedQuestion: question.state === "removed",
            refunded: [pledgeId],
            created: false,
          };
        const plan = withdrawal(
          question,
          pledgeId,
          await actorFor(client, debateId, context.userId),
        );
        const refunds = plan.refund.map((p) => loaded.pledges.get(p.id)!);
        const { books, buckets } = await lockMoney(
          client,
          refunds.map((p) => p.user_id),
        );
        for (const refund of refunds)
          books.set(
            refund.user_id,
            await release(
              client,
              refund,
              books.get(refund.user_id)!,
              buckets.get(refund.user_id)!,
              refund.id === pledgeId ? "withdrawn" : "question_removed",
            ),
          );
        if (plan.removesQuestion)
          await client.query(
            "UPDATE mic_questions SET state='removed' WHERE id=$1",
            [question.id],
          );
        return {
          pledgeId,
          questionId: question.id,
          removedQuestion: plan.removesQuestion,
          refunded: refunds.map((p) => p.id),
          created: true,
        };
      });
    },
    /**
     * F1, F11 to F13, L13 to L15: the camp's #1 fires. Its pledges are paid
     * to the seated debaters in equal halves, the camp's other questions are
     * refunded, and the mic goes live, or queues behind one live or queued.
     */
    async fire(
      context: SandboxContext,
      debateId: string,
      questionId: string,
      requestId: string,
    ) {
      found(debateId, "debate");
      found(questionId, "question");
      const requestKey = reference(context.userId, "mic.fire", requestId);
      const fired = await authorized(context, async (client) => {
        const list = await openList(client, debateId);
        const prior = (
          await client.query<{
            id: string;
            question_id: string;
            state: Mic["state"];
            price: string;
          }>(
            "SELECT id,question_id,state,price::text FROM mic_mics WHERE request_id=$1",
            [requestKey],
          )
        ).rows[0];
        if (prior) {
          if (prior.question_id !== questionId) throw idempotencyConflict();
          return {
            micId: prior.id,
            questionId,
            state: prior.state,
            price: coins(BigInt(prior.price)),
            created: false,
          };
        }
        await assertLive(client, debateId);
        const loaded = list
          ? await loadList(client, list)
          : { questions: [], mics: [], pledges: new Map<string, PledgeRow>() };
        const result = fire({
          list,
          questions: loaded.questions,
          mics: loaded.mics,
          questionId,
          actor: await actorFor(client, debateId, context.userId),
        });
        const open = list!;
        const seat = await seats(client, debateId);
        // Seat replacement (S13: a half waits for an empty seat's next
        // occupant) is a later pull request; until then both must be filled.
        if (!seat.A || !seat.B)
          throw new MicError(
            "both debater seats must be filled to fire a mic",
            409,
          );
        const debaters = { A: seat.A, B: seat.B };
        const paid = result.paid.map((p) => loaded.pledges.get(p.id)!);
        const refunded = result.refunded.map((p) => loaded.pledges.get(p.id)!);
        const { books, buckets } = await lockMoney(client, [
          ...paid.map((p) => p.user_id),
          ...refunded.map((p) => p.user_id),
          debaters.A,
          debaters.B,
        ]);
        const center = buckets.get(debaters.A)!.system;
        // The center pays the debaters the grant part it burns. Say so
        // plainly when its float runs low, instead of the ledger's refusal.
        const grantPart = paid.reduce(
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
        const micId = randomUUID();
        await client.query(
          `INSERT INTO mic_mics(id,list_id,debate_id,camp,question_id,holder_id,target,state,price,request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            micId,
            open.id,
            debateId,
            result.camp,
            questionId,
            context.userId,
            result.target,
            result.state,
            String(result.price),
            requestKey,
          ],
        );
        await client.query(
          "UPDATE mic_questions SET state='fired' WHERE id=$1",
          [questionId],
        );
        if (result.refundedQuestions.length)
          await client.query(
            "UPDATE mic_questions SET state='refunded' WHERE id=ANY($1::uuid[])",
            [result.refundedQuestions],
          );
        const now = (
          await client.query<{ now: Date }>(
            "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          )
        ).rows[0]!.now.toISOString();
        const earned: Record<Side, bigint> = { A: 0n, B: 0n };
        const journals: string[] = [];
        for (const pledge of paid) {
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
          for (const share of splitToDebaters(
            BigInt(pledge.amount),
            debaters,
          )) {
            move(
              cash,
              buckets.get(share.account!)!.cashAvailable,
              share.amount,
            );
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
              debateId,
              micId,
              questionId,
              pledgeId: pledge.id,
              funding: committed.funding,
              rail,
            },
          });
          books.set(pledge.user_id, advanced(before, committed.book));
          await client.query(
            "UPDATE mic_pledges SET state='paid' WHERE id=$1",
            [pledge.id],
          );
        }
        // Each debater's half arrives as cash-backed Yap Coins: a
        // purchased_profit source on their book, matching the ledger credit.
        for (const side of ["A", "B"] as const) {
          const account = debaters[side],
            amount = earned[side];
          if (!amount) continue;
          const before = books.get(account)!;
          const id = `mic:${micId}`;
          const book: GrantAccountingBook = {
            ...before.book,
            purchased: [
              ...before.book.purchased,
              {
                id,
                kind: "purchased_profit",
                purchaseId: id,
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
            reference: reference(account, "mic.earned", micId),
            termsDigest: digest([micId, side, String(amount)]),
            metadata: {
              debateId,
              micId,
              side,
              amount: String(amount),
              cashJournalIds: journals,
              rail,
            },
          });
          books.set(account, advanced(before, book));
        }
        for (const pledge of refunded)
          books.set(
            pledge.user_id,
            await release(
              client,
              pledge,
              books.get(pledge.user_id)!,
              buckets.get(pledge.user_id)!,
              "camp_fired",
            ),
          );
        return {
          micId,
          questionId,
          state: result.state,
          price: coins(result.price),
          created: true,
        };
      });
      // PR 2b: the turn engine starts the live mic after the fire commits,
      // outside its locks (a retried fire starts nothing twice).
      if (fired.state === "live") await options.afterFire?.(debateId);
      return fired;
    },
  });
}
export type MicRepository = ReturnType<typeof createMicRepository>;
