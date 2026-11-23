// Borrow the microphone, Decision 0018: the pure rules.
// Plain data in, decisions out. No database, clock or randomness: the
// repository and the turn engine apply what these functions return, so every
// rule can be tested on its own. Rule IDs (L, F, E, X, N, D, S) are the
// decision record's.

export type Side = "A" | "B";
export const otherSide = (side: Side): Side => (side === "A" ? "B" : "A");
/** A question's camp is the side opposite its target. */
export const campOf = (target: Side): Side => otherSide(target);

/** Atoms per Yap Coin, the same unit as the welcome grant and debate windows. */
export const YC = 10_000n;

export type MicTerms = {
  questionMaxChars: number; // L16
  minPledge: bigint; // L16, in atoms
  turnSeconds: number; // E4, E5, X5
};
export const MIC_TERMS: Readonly<MicTerms> = Object.freeze({
  questionMaxChars: 200,
  minPledge: YC,
  turnSeconds: 60,
});

export class MicError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export type PledgeState = "held" | "paid" | "refunded";
export interface Pledge {
  id: string;
  account: string;
  amount: bigint;
  wager: boolean;
  add: string | null;
  state: PledgeState;
}
export type QuestionState = "open" | "fired" | "removed" | "refunded";
export interface Question {
  id: string;
  listId: string;
  author: string;
  target: Side;
  text: string;
  seq: number; // submission order, for ties (L9)
  state: QuestionState;
  pledges: Pledge[];
}
export type MicState = "queued" | "live" | "done";
export interface Mic {
  id: string;
  listId: string;
  camp: Side;
  questionId: string;
  holder: string;
  target: Side;
  state: MicState;
  price: bigint; // the question's total when it fired (X2)
}
export interface MicList {
  id: string;
  state: "open" | "closed";
  openedRound: number; // the round in progress when the list opened
}
/** Someone acting on the list, as the repository sees them right now. */
export interface Actor {
  account: string;
  present: boolean; // a signed-in viewer connected to the live debate (D4)
  seated: boolean; // holds a debater seat now
  heldSeat: boolean; // has held a seat in this debate at any point (S14)
}

export const total = (question: Question) =>
  question.pledges.reduce(
    (sum, pledge) => sum + (pledge.state === "held" ? pledge.amount : 0n),
    0n,
  );

/** Open questions of one camp, highest total first, ties to the earlier (L8, L9). */
export function ranked(
  questions: readonly Question[],
  listId: string,
  camp: Side,
) {
  return questions
    .filter(
      (q) =>
        q.listId === listId && q.state === "open" && campOf(q.target) === camp,
    )
    .sort((a, b) => {
      const diff = total(b) - total(a);
      return diff > 0n ? 1 : diff < 0n ? -1 : a.seq - b.seq;
    });
}
export const micFor = (mics: readonly Mic[], listId: string, camp: Side) =>
  mics.find((mic) => mic.listId === listId && mic.camp === camp);

/** Debaters, and anyone who has held a seat, take no part in the list (L17, S4, S14). */
export function assertViewer(actor: Actor) {
  if (!actor.present) throw new MicError("join the live debate first", 403);
  if (actor.seated || actor.heldSeat)
    throw new MicError(
      "debaters can't submit, pledge or trade in their debate",
      403,
    );
}
function assertOpen(list: MicList | undefined): asserts list is MicList {
  if (!list || list.state !== "open") throw new MicError("the list isn't open");
}
function wholeCoins(amount: bigint, terms: MicTerms) {
  if (amount < terms.minPledge || amount % YC !== 0n)
    throw new MicError(
      `pledge whole Yap Coins, at least ${terms.minPledge / YC}`,
      400,
    );
}
function cleanText(
  text: string,
  terms: MicTerms,
  what: string,
  required: boolean,
) {
  const clean = text.trim();
  if (required && !clean) throw new MicError(`write a ${what} first`, 400);
  if ([...clean].length > terms.questionMaxChars)
    throw new MicError(
      `a ${what} is at most ${terms.questionMaxChars} characters`,
      400,
    );
  return clean;
}

/** L5, L16, L17, L21, L22, L23: whether a viewer may submit this question. */
export function checkQuestion(input: {
  list: MicList | undefined;
  questions: readonly Question[];
  mics: readonly Mic[];
  actor: Actor;
  target: Side;
  text: string;
  wager: bigint;
  terms?: MicTerms;
}) {
  const terms = input.terms ?? MIC_TERMS;
  assertOpen(input.list);
  assertViewer(input.actor);
  const text = cleanText(input.text, terms, "question", true);
  const list = input.list;
  if (micFor(input.mics, list.id, campOf(input.target)))
    throw new MicError("that debater's camp has already fired in this list");
  if (
    input.questions.some(
      (q) =>
        q.listId === list.id &&
        q.author === input.actor.account &&
        q.state === "open",
    )
  )
    throw new MicError("you already have a question open in this list");
  wholeCoins(input.wager, terms);
  return { text, wager: input.wager, camp: campOf(input.target) };
}

/** L6, L16, L19: whether a viewer may pledge to this question, with an optional add. */
export function checkPledge(input: {
  list: MicList | undefined;
  question: Question;
  actor: Actor;
  amount: bigint;
  add?: string | null;
  terms?: MicTerms;
}) {
  const terms = input.terms ?? MIC_TERMS;
  assertOpen(input.list);
  assertViewer(input.actor);
  if (
    input.question.listId !== input.list.id ||
    input.question.state !== "open"
  )
    throw new MicError("this question isn't open any more");
  wholeCoins(input.amount, terms);
  const add = cleanText(input.add ?? "", terms, "comment", false);
  return { amount: input.amount, add: add || null };
}

/**
 * L11, L20, S5: a pledge or wager can be withdrawn at any time until its camp's
 * mic fires. Withdrawing the wager removes the question and refunds every pledge.
 */
export function withdrawal(question: Question, pledgeId: string, actor: Actor) {
  const pledge = question.pledges.find((p) => p.id === pledgeId);
  if (
    !pledge ||
    pledge.account !== actor.account ||
    pledge.state !== "held" ||
    question.state !== "open"
  )
    throw new MicError("nothing to withdraw", 404);
  if (actor.seated || actor.heldSeat)
    throw new MicError("debaters can't change their pledges", 403);
  if (pledge.wager)
    return {
      removesQuestion: true,
      refund: question.pledges.filter((p) => p.state === "held"),
    };
  return { removesQuestion: false, refund: [pledge] };
}

/**
 * F1, F11 to F13, L13, L14: the camp's current #1 fires. Its held pledges are
 * paid, every other open question of the camp is refunded, and the mic is
 * queued when another one is live or queued.
 */
export function fire(input: {
  list: MicList | undefined;
  questions: readonly Question[];
  mics: readonly Mic[];
  questionId: string;
  actor: Actor;
}) {
  assertOpen(input.list);
  const list = input.list;
  const question = input.questions.find((q) => q.id === input.questionId);
  if (!question || question.listId !== list.id || question.state !== "open")
    throw new MicError("this question isn't open", 404);
  if (question.author !== input.actor.account)
    throw new MicError("only the question's author can fire it", 403);
  assertViewer(input.actor);
  const camp = campOf(question.target);
  if (micFor(input.mics, list.id, camp))
    throw new MicError("this camp has already fired");
  if (ranked(input.questions, list.id, camp)[0] !== question)
    throw new MicError("only the camp's #1 can fire");
  const others = input.questions.filter(
    (q) =>
      q.listId === list.id &&
      q.state === "open" &&
      q.id !== question.id &&
      campOf(q.target) === camp,
  );
  const busy = input.mics.some(
    (mic) => mic.state === "live" || mic.state === "queued",
  );
  return {
    camp,
    target: question.target,
    price: total(question),
    paid: question.pledges.filter((p) => p.state === "held"),
    refunded: others.flatMap((q) =>
      q.pledges.filter((p) => p.state === "held"),
    ),
    refundedQuestions: others.map((q) => q.id),
    state: (busy ? "queued" : "live") as MicState,
  };
}

export type TurnKind =
  "debate" | "question" | "answer" | "followup" | "answer2" | "extq" | "exta";
export const askerTurn = (kind: TurnKind) =>
  kind === "question" || kind === "followup" || kind === "extq";

/**
 * E1, E4, E8, X4: the turn after an exchange turn. "resume" hands the floor to
 * the debater who was not the target for a full turn.
 */
export function nextTurn(kind: TurnKind, funded: boolean): TurnKind | "resume" {
  switch (kind) {
    case "question":
      return "answer";
    case "answer":
      return "followup";
    case "followup":
      return "answer2";
    case "extq":
      return "exta";
    case "answer2":
    case "exta":
      return funded ? "extq" : "resume";
    default:
      throw new MicError("not an exchange turn", 500);
  }
}

/**
 * E5, E6, E10: a mic that cuts a turn takes the rest of it away, whoever was
 * speaking. Nobody's answer is stretched, and the cut turn's window is refunded.
 */
export function cutTurn(remainingMs: number, terms: MicTerms = MIC_TERMS) {
  return {
    lostMs: Math.max(0, remainingMs),
    answerMs: terms.turnSeconds * 1000,
    refundWindow: true,
  };
}

export interface FundPledge {
  account: string;
  amount: bigint;
}
export interface Fund {
  price: bigint;
  closesAfter: "followup" | "extq";
  state: "open" | "funded" | "failed";
  pledges: FundPledge[];
}
export const raised = (fund: Fund) =>
  fund.pledges.reduce((sum, p) => sum + p.amount, 0n);

/**
 * X1, X2, X10: keep-the-asker-on opens when the asker's first turn of a
 * segment starts and closes when their last turn of it ends.
 */
export function openFund(kind: TurnKind, price: bigint): Fund {
  if (kind !== "question" && kind !== "extq")
    throw new MicError("funding opens on an asker's first turn", 500);
  return {
    price,
    closesAfter: kind === "question" ? "followup" : "extq",
    state: "open",
    pledges: [],
  };
}
/** X6, X11, X12: a pledge is cut to what is left; reaching the price funds it at once. */
export function fundPledge(
  fund: Fund,
  actor: Actor,
  amount: bigint,
  terms: MicTerms = MIC_TERMS,
) {
  if (fund.state !== "open") throw new MicError("keep-the-asker-on isn't open");
  assertViewer(actor);
  wholeCoins(amount, terms);
  const accepted =
    amount < fund.price - raised(fund) ? amount : fund.price - raised(fund);
  return { accepted, funded: raised(fund) + accepted >= fund.price };
}
/** X7: an open fund closes, unfunded, when the turn it waits for ends. */
export const fundCloses = (fund: Fund, endedKind: TurnKind) =>
  fund.state === "open" && fund.closesAfter === endedKind;

/**
 * D6, D8: a camp is done once its mic is done. An empty camp counts as done
 * only after the round in which its list opened has ended, because the list
 * never closes and could still receive a first question.
 */
export function campDone(input: {
  list: MicList;
  questions: readonly Question[];
  mics: readonly Mic[];
  camp: Side;
  roundsDone: number;
}) {
  const mic = micFor(input.mics, input.list.id, input.camp);
  if (mic) return mic.state === "done";
  return (
    input.roundsDone >= input.list.openedRound &&
    ranked(input.questions, input.list.id, input.camp).length === 0
  );
}
export const listDone = (input: Omit<Parameters<typeof campDone>[0], "camp">) =>
  campDone({ ...input, camp: "A" }) && campDone({ ...input, camp: "B" });

/** D2, N1: more than half of the viewers present have their standing button on. */
export function majority(
  presentAccounts: readonly string[],
  onAccounts: ReadonlySet<string>,
) {
  const on = presentAccounts.filter((account) =>
    onAccounts.has(account),
  ).length;
  return presentAccounts.length > 0 && on * 2 > presentAccounts.length;
}
/** D5: viewers can end the debate only after three rounds and both standard mics. */
export const viewersCanEnd = (roundsDone: number, firstListDone: boolean) =>
  roundsDone >= 3 && firstListDone;
/** N1, N5: a new-list vote counts once the current list is done and no mic is live or queued. */
export const newListVoteCounts = (input: {
  latestListDone: boolean;
  mics: readonly Mic[];
  votePassed: boolean;
}) =>
  input.latestListDone &&
  !input.votePassed &&
  input.mics.every((mic) => mic.state === "done");

/**
 * L15, S13: spent YC goes to the two seated debaters in equal halves. A half
 * due to an empty seat is kept for whoever claims it. Amounts are whole YC,
 * so a half is always a whole number of atoms.
 */
export function splitToDebaters(
  amount: bigint,
  seats: Readonly<Record<Side, string | null>>,
) {
  const half = amount / 2n;
  return (["A", "B"] as const).map((side) => ({
    side,
    account: seats[side],
    amount: side === "A" ? amount - half : half,
  }));
}

/** S8: a viewer who claims a seat has every open question of theirs refunded, with no forfeit. */
export const seatClaimRefunds = (
  questions: readonly Question[],
  claimant: string,
) => questions.filter((q) => q.state === "open" && q.author === claimant);

/**
 * D7, D9: ending the debate refunds every question that hasn't fired and every
 * open keep-the-asker-on pledge. A queued mic has fired, so its YC stays paid.
 */
export function endingRefunds(
  questions: readonly Question[],
  funds: readonly Fund[],
) {
  return {
    questions: questions.filter((q) => q.state === "open"),
    pledges: questions.flatMap((q) =>
      q.state === "open" ? q.pledges.filter((p) => p.state === "held") : [],
    ),
    fundPledges: funds.flatMap((fund) =>
      fund.state === "open" ? fund.pledges : [],
    ),
  };
}
