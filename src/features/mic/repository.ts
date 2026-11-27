import { randomUUID } from "node:crypto";
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
import type { StakeFunding } from "../account-wallet/grant-accounting.ts";
import {
  assertSandboxFinancialOpen,
  assertSandboxOpened,
  assertSandboxRail,
  type SandboxContext,
  type SandboxRail,
} from "../account-wallet/sandbox-repository.ts";
import { COIN_REQUEST_LIMITS } from "../account-wallet/debate-sandbox.ts";
import { viewerIdsNow } from "../presence/repository.ts";
import {
  checkPledge,
  checkQuestion,
  fire,
  fundPledge,
  MicError,
  ranked,
  total,
  withdrawal,
  YC,
  type Actor,
  type Fund,
  type Mic,
  type MicList,
  type Pledge,
  type Question,
  type Side,
} from "./rules.ts";
import { askerKind, micOn, type MicTurnKind } from "./turn-kinds.ts";
import {
  createMicMoney,
  lockMoney,
  reference,
  type HeldPledge,
} from "./money.ts";

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
// The ledger moves themselves are shared with keeping the asker on (money.ts).
//
// PR 3: a keep-the-asker-on pledge locks the account row, then the fund row
// FOR UPDATE, the books and the ledger; never debate_media or a mic turn row,
// which the clock holds while it closes a fund (funds.ts).

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
const coins = (atoms: bigint) => Number(atoms / YC);

function found(id: string, what: string) {
  if (!uuid.test(id)) throw new MicError(`${what} not found`, 404);
}

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
  // Whether this debate started with the mic on (its rules snapshot). The
  // page shows no list for a debate that will never open one.
  enabled: boolean;
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
    // PR 3: the extensions viewers funded for this mic (X4, X8).
    extensions: number;
  }[];
  // PR 3: keep-the-asker-on for the live mic, its latest fund: open while
  // viewers can pledge, else funded, closing, failed or refunded.
  fund: {
    id: string;
    micId: string;
    price: number;
    raised: number;
    state: "open" | "closing" | "funded" | "failed" | "refunded";
    // The asker's turn whose end closes it (X1, X10), and that turn's
    // deadline once it runs (null before it starts or while paused).
    closesAfter: Fund["closesAfter"];
    closesAt: Date | null;
  } | null;
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
  // Every mic turn the debate has run, oldest first: the page and a replay
  // label these turns by their kind, and count the debaters' own turns
  // without them (they don't count toward the debate's length).
  turns: {
    turnNumber: number;
    micId: string;
    kind: MicTurnKind;
    asker: string | null;
    target: Side;
    text: string | null; // an asker turn's typed text (E9), else null
  }[];
}

/**
 * What the signed-in viewer holds in a debate's mic: their open pledges
 * (a wager is the pledge that carries their own question), the mics they
 * fired, and what they pledged to the open keep-the-asker-on fund. Pledge ids
 * are what a withdrawal names; nothing here is public.
 */
export interface OwnMic {
  debateId: string;
  // A seated debater takes no part in the list (L17).
  seated: boolean;
  pledges: {
    id: string;
    questionId: string;
    amount: number;
    wager: boolean;
  }[];
  mics: string[];
  kept: { fundId: string; amount: number } | null;
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
  const debate = (
    await client.query<{ rules: unknown }>(
      `SELECT d.rules_snapshot AS rules FROM debates d JOIN topics t ON t.id=d.topic_id
      WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
      [debateId],
    )
  ).rows[0];
  if (!debate) return null;
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
  const extensions = new Map(
    (
      await client.query<{ micId: string; n: number }>(
        `SELECT mic_id AS "micId",count(*)::int AS n FROM mic_funds
        WHERE debate_id=$1 AND state='funded' GROUP BY mic_id`,
        [debateId],
      )
    ).rows.map((row) => [row.micId, row.n]),
  );
  const fund = (
    await client.query<{
      id: string;
      micId: string;
      price: string;
      raised: string;
      state: NonNullable<PublicMicList["fund"]>["state"];
      closesAfter: Fund["closesAfter"];
      closesAt: Date | null;
    }>(
      `SELECT f.id,f.mic_id AS "micId",f.price::text,f.state,f.closes_after AS "closesAfter",
        (SELECT COALESCE(sum(p.amount),0)::text FROM mic_fund_pledges p
          WHERE p.fund_id=f.id AND p.state<>'refunded') AS raised,
        (SELECT dm.turn_deadline_at FROM debate_media dm
          JOIN mic_turns t ON t.debate_id=dm.debate_id AND t.turn_number=dm.turn_number
          WHERE dm.debate_id=f.debate_id AND dm.state='running' AND t.mic_id=f.mic_id
            AND t.kind=f.closes_after AND t.turn_number>=f.opened_turn_number) AS "closesAt"
      FROM mic_funds f JOIN mic_mics m ON m.id=f.mic_id
      WHERE f.debate_id=$1 AND m.state='live'
      ORDER BY f.opened_turn_number DESC LIMIT 1`,
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
  const turns = (
    await client.query<{
      turnNumber: number;
      micId: string;
      kind: MicTurnKind;
      text: string | null;
      holder: string;
      target: Side;
    }>(
      `SELECT t.turn_number AS "turnNumber",t.mic_id AS "micId",t.kind,t.text,
        m.holder_id::text AS holder,m.target
      FROM mic_turns t JOIN mic_mics m ON m.id=t.mic_id
      WHERE t.debate_id=$1 ORDER BY t.turn_number`,
      [debateId],
    )
  ).rows;
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
    enabled: micOn(debate.rules),
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
      extensions: extensions.get(mic.id) ?? 0,
    })),
    fund: fund
      ? {
          id: fund.id,
          micId: fund.micId,
          price: coins(BigInt(fund.price)),
          raised: coins(BigInt(fund.raised)),
          state: fund.state,
          closesAfter: fund.closesAfter,
          closesAt: fund.closesAt,
        }
      : null,
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
    turns: turns.map((turn) => ({
      turnNumber: turn.turnNumber,
      micId: turn.micId,
      kind: turn.kind,
      asker: handle(turn.holder),
      target: turn.target,
      text: turn.text,
    })),
  };
}

/** The signed-in viewer's own part of a debate's mic; see OwnMic. */
export async function readOwn(
  client: PoolClient,
  debateId: string,
  userId: string,
): Promise<OwnMic | null> {
  if (!uuid.test(debateId)) return null;
  const debate = (
    await client.query<{ seated: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public_profiles p WHERE p.user_id=$2
          AND p.id IN (d.speaker_a_profile_id,d.speaker_b_profile_id)) AS seated
      FROM debates d JOIN topics t ON t.id=d.topic_id
      WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
      [debateId, userId],
    )
  ).rows[0];
  if (!debate) return null;
  const pledges = (
    await client.query<{
      id: string;
      questionId: string;
      amount: string;
      wager: boolean;
    }>(
      `SELECT p.id,p.question_id AS "questionId",p.amount::text,p.wager
      FROM mic_pledges p JOIN mic_questions q ON q.id=p.question_id
      WHERE q.debate_id=$1 AND p.user_id=$2 AND p.state='held' AND q.state='open'
      ORDER BY p.created_at,p.id`,
      [debateId, userId],
    )
  ).rows;
  const mics = (
    await client.query<{ id: string }>(
      "SELECT id FROM mic_mics WHERE debate_id=$1 AND holder_id=$2 ORDER BY fired_at,id",
      [debateId, userId],
    )
  ).rows;
  const kept = (
    await client.query<{ fundId: string; amount: string }>(
      `SELECT f.id AS "fundId",sum(p.amount)::text AS amount
      FROM mic_fund_pledges p JOIN mic_funds f ON f.id=p.fund_id
      WHERE f.debate_id=$1 AND f.state='open' AND p.user_id=$2 AND p.state='held'
      GROUP BY f.id,f.opened_turn_number ORDER BY f.opened_turn_number DESC LIMIT 1`,
      [debateId, userId],
    )
  ).rows[0];
  return {
    debateId,
    seated: debate.seated,
    pledges: pledges.map((pledge) => ({
      id: pledge.id,
      questionId: pledge.questionId,
      amount: coins(BigInt(pledge.amount)),
      wager: pledge.wager,
    })),
    mics: mics.map((mic) => mic.id),
    kept: kept
      ? { fundId: kept.fundId, amount: coins(BigInt(kept.amount)) }
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
  const money = createMicMoney(rail);
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
  // A question pledge's hold, its row recorded with the funding it used.
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
    await money.hold(client, books, buckets, {
      userId: input.userId,
      pledgeId: input.pledgeId,
      amount: input.amount,
      scope: { questionId: input.questionId },
      metadata: { debateId: input.debateId, wager: input.wager },
      record: (funding) =>
        client.query(
          `INSERT INTO mic_pledges(id,question_id,user_id,amount,wager,add_text,funding,request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            input.pledgeId,
            input.questionId,
            input.userId,
            String(input.amount),
            input.wager,
            input.add,
            JSON.stringify(funding),
            input.requestKey,
          ],
        ),
    });
  }
  // A question pledge's refund, the exact reverse of its hold.
  const release = (
    client: PoolClient,
    locked: Awaited<ReturnType<typeof lockMoney>>,
    pledge: PledgeRow,
    reason: "withdrawn" | "question_removed" | "camp_fired",
  ) =>
    money.release(client, locked.books, locked.buckets, pledge, {
      reason,
      scope: { questionId: pledge.question_id },
      record: () =>
        client.query(
          "UPDATE mic_pledges SET state='refunded',refund_reason=$2 WHERE id=$1",
          [pledge.id, reason],
        ),
    });

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
    /** The signed-in viewer's own pledges and mics; null as for read. */
    readOwn(debateId: string, userId: string) {
      return transaction((client) => readOwn(client, debateId, userId));
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
        const locked = await lockMoney(
          client,
          refunds.map((p) => p.user_id),
        );
        for (const refund of refunds)
          await release(
            client,
            locked,
            refund,
            refund.id === pledgeId ? "withdrawn" : "question_removed",
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
        const locked = await lockMoney(client, [
          ...paid.map((p) => p.user_id),
          ...refunded.map((p) => p.user_id),
          debaters.A,
          debaters.B,
        ]);
        await money.assertCenterCovers(client, locked.buckets, debaters, paid);
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
        await money.payDebaters(client, locked.books, locked.buckets, {
          debateId,
          micId,
          key: micId,
          source: `mic:${micId}`,
          debaters,
          pledges: paid,
          scope: { questionId },
          record: (pledge) =>
            client.query("UPDATE mic_pledges SET state='paid' WHERE id=$1", [
              pledge.id,
            ]),
        });
        for (const pledge of refunded)
          await release(client, locked, pledge, "camp_fired");
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
    /**
     * X1, X2, X6, X11, X12: a pledge to keep the asker on, to the live mic's
     * open fund. It is cut to what is left of the price; reaching the price
     * pays every pledge of the fund to the seated debaters in equal halves at
     * once, and the extension runs after the target's answer. Fund pledges
     * can't be withdrawn; an unfunded fund is refunded when it closes (X7).
     */
    keep(
      context: SandboxContext,
      debateId: string,
      input: { amount: bigint; requestId: string },
    ) {
      found(debateId, "debate");
      const requestKey = reference(context.userId, "mic.keep", input.requestId);
      return authorized(context, async (client) => {
        const prior = (
          await client.query<{
            id: string;
            fundId: string;
            requested: string;
            amount: string;
            debateId: string;
            fundState: string;
          }>(
            `SELECT p.id,p.fund_id AS "fundId",p.requested::text,p.amount::text,
              f.debate_id AS "debateId",f.state AS "fundState"
            FROM mic_fund_pledges p JOIN mic_funds f ON f.id=p.fund_id
            WHERE p.request_id=$1`,
            [requestKey],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.debateId !== debateId ||
            BigInt(prior.requested) !== input.amount
          )
            throw idempotencyConflict();
          return {
            fundId: prior.fundId,
            pledgeId: prior.id,
            amount: coins(BigInt(prior.amount)),
            funded: prior.fundState === "funded",
            created: false,
          };
        }
        // The fund row decides: a close (the clock) and a pledge that
        // reaches the price cannot both win.
        const fund = (
          await client.query<{
            id: string;
            micId: string;
            price: string;
            state: string;
            closesAfter: Fund["closesAfter"];
          }>(
            `SELECT id,mic_id AS "micId",price::text,state,closes_after AS "closesAfter"
            FROM mic_funds WHERE debate_id=$1
            ORDER BY opened_turn_number DESC LIMIT 1 FOR UPDATE`,
            [debateId],
          )
        ).rows[0];
        await assertLive(client, debateId);
        if (!fund) throw new MicError("keep-the-asker-on isn't open");
        const pledges = (
          await client.query<HeldPledge>(
            `SELECT id,user_id::text,amount::text,funding FROM mic_fund_pledges
            WHERE fund_id=$1 AND state='held' ORDER BY created_at,id`,
            [fund.id],
          )
        ).rows;
        const result = fundPledge(
          {
            price: BigInt(fund.price),
            closesAfter: fund.closesAfter,
            state:
              fund.state === "open"
                ? "open"
                : fund.state === "funded"
                  ? "funded"
                  : "failed",
            pledges: pledges.map((p) => ({
              account: p.user_id,
              amount: BigInt(p.amount),
            })),
          },
          await actorFor(client, debateId, context.userId),
          input.amount,
        );
        let debaters: Record<Side, string> | null = null;
        if (result.funded) {
          const seat = await seats(client, debateId);
          // As for firing: both halves need a seated debater (S13 is later).
          if (!seat.A || !seat.B)
            throw new MicError(
              "both debater seats must be filled to keep the asker on",
              409,
            );
          debaters = { A: seat.A, B: seat.B };
        }
        const locked = await lockMoney(client, [
          context.userId,
          ...(debaters
            ? [...pledges.map((p) => p.user_id), debaters.A, debaters.B]
            : []),
        ]);
        const pledgeId = randomUUID();
        const held = await money.hold(client, locked.books, locked.buckets, {
          userId: context.userId,
          pledgeId,
          amount: result.accepted,
          scope: { fundId: fund.id },
          metadata: { debateId, micId: fund.micId },
          record: (funding) =>
            client.query(
              `INSERT INTO mic_fund_pledges(id,fund_id,user_id,requested,amount,funding,request_id)
              VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
              [
                pledgeId,
                fund.id,
                context.userId,
                String(input.amount),
                String(result.accepted),
                JSON.stringify(funding),
                requestKey,
              ],
            ),
        });
        if (debaters) {
          const paid = [...pledges, held];
          await money.assertCenterCovers(
            client,
            locked.buckets,
            debaters,
            paid,
          );
          await client.query(
            "UPDATE mic_funds SET state='funded' WHERE id=$1",
            [fund.id],
          );
          await money.payDebaters(client, locked.books, locked.buckets, {
            debateId,
            micId: fund.micId,
            key: `fund:${fund.id}`,
            source: `mic-fund:${fund.id}`,
            debaters,
            pledges: paid,
            scope: { fundId: fund.id },
            record: (pledge) =>
              client.query(
                "UPDATE mic_fund_pledges SET state='paid' WHERE id=$1",
                [pledge.id],
              ),
          });
        }
        return {
          fundId: fund.id,
          pledgeId,
          amount: coins(result.accepted),
          funded: result.funded,
          created: true,
        };
      });
    },
  });
}
export type MicRepository = ReturnType<typeof createMicRepository>;
