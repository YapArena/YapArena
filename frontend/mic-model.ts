// Decision 0018, borrow the microphone: the pure rules of its interface. What
// the list, the live mic, the keep-the-asker-on fund, the asker's own
// controls, the band over the video and the "Yapper incoming" animation say,
// from the public list (GET /api/debates/:id/mic) and the signed-in viewer's
// own part (GET …/mic/mine). It also names a mic's turns for the rest of the
// page: a debate with the mic no longer alternates A, B, A, B, and its mic
// turns don't count toward its length. No DOM access, so tests import the
// built module; frontend/mic.ts puts it on the page.

export type Side = "A" | "B";
export type MicTurnKind =
  "question" | "answer" | "followup" | "answer2" | "extq" | "exta" | "resume";

export interface MicQuestion {
  id: string;
  target: Side;
  text: string;
  author: string | null;
  total: number;
  pledges: number;
  adds: { text: string; by: string | null }[];
}
export interface MicEntry {
  id: string;
  listId: string;
  camp: Side;
  target: Side;
  state: "queued" | "live" | "done";
  price: number;
  holder: string | null;
  questionId: string;
  text: string;
  started: boolean;
  cut: { turnNumber: number; side: Side; lostMs: number } | null;
  extensions: number;
}
export interface MicFund {
  id: string;
  micId: string;
  price: number;
  raised: number;
  state: "open" | "closing" | "funded" | "failed" | "refunded";
  closesAfter: "followup" | "extq";
  closesAt: string | null;
}
/** The mic turn on the clock now. */
export interface MicTurn {
  turnNumber: number;
  micId: string;
  kind: MicTurnKind;
  speaker: "asker" | Side;
  side: Side;
  asker: string | null;
  target: Side;
  text: string | null;
  deadline: string | null;
}
/** A mic turn the debate has run, the current one included. */
export interface MicPastTurn {
  turnNumber: number;
  micId: string;
  kind: MicTurnKind;
  asker: string | null;
  target: Side;
  text: string | null;
}
/** The public list, as JSON. `enabled` and `turns` are absent from an older server. */
export interface MicPublic {
  debateId: string;
  enabled?: boolean;
  list: {
    id: string;
    n: number;
    extra: boolean;
    state: "open" | "closed";
    openedRound: number;
    camps: Record<Side, MicQuestion[]>;
  } | null;
  mics: MicEntry[];
  fund: MicFund | null;
  turn: MicTurn | null;
  turns?: MicPastTurn[];
}
/** The signed-in viewer's own part. */
export interface MicOwn {
  debateId: string;
  seated: boolean;
  pledges: { id: string; questionId: string; amount: number; wager: boolean }[];
  mics: string[];
  kept: { fundId: string; amount: number } | null;
}

export type Names = Record<Side, string>;
/** L2: the list opens when both debaters have completed three rounds. */
export const LIST_OPENS_AFTER_ROUND = 3;
/** F16: the animation's length; the simulator the founder tested ran 2.7 s. */
export const INCOMING_MS = 2700;

const other = (side: Side): Side => (side === "A" ? "B" : "A");
export const askerKind = (kind: MicTurnKind) =>
  kind === "question" || kind === "followup" || kind === "extq";

/** "340 YC": mic amounts are whole Yap Coins. */
export const yc = (amount: number) => `${amount.toLocaleString("en-US")} YC`;
/** "@zoe", or "A viewer" for an asker without a published profile. */
export const askerName = (handle: string | null) =>
  handle ? `@${handle}` : "A viewer";
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// ---- Naming turns ----

/** The mic turn with this number, if it was one. */
export function micTurnAt(
  turns: readonly MicPastTurn[] | undefined,
  turnNumber: number | null,
) {
  if (turnNumber === null || !turns) return null;
  return turns.find((turn) => turn.turnNumber === turnNumber) ?? null;
}

/**
 * The debate's number of turns once a mic has run: a mic's turns take turn
 * numbers and don't count toward the debate's length, so each one makes the
 * debate one turn longer ("Turn 13 of 15" after a five-turn exchange).
 */
export function totalTurns(
  total: number | null,
  turns: readonly MicPastTurn[] | undefined,
) {
  return total === null ? null : total + (turns?.length ?? 0);
}

/** A mic turn's kind in a word or two. */
export function kindWord(kind: MicTurnKind) {
  switch (kind) {
    case "question":
      return "Question";
    case "followup":
      return "Follow-up";
    case "extq":
      return "Extra question";
    case "resume":
      return "Floor back";
    default:
      return "Answer";
  }
}

/** Who has the floor in a mic turn: the asker's handle or a debater's name. */
export function micTurnWho(
  turn: Pick<MicPastTurn, "kind" | "asker" | "target">,
  names: Names,
) {
  if (askerKind(turn.kind)) return askerName(turn.asker);
  return names[turn.kind === "resume" ? other(turn.target) : turn.target];
}

/** The side whose debater speaks in a mic turn; null in the asker's turns. */
export function micTurnSpeaker(
  turn: Pick<MicPastTurn, "kind" | "target">,
): Side | null {
  if (askerKind(turn.kind)) return null;
  return turn.kind === "resume" ? other(turn.target) : turn.target;
}

/** "Question · @zoe", "Answer · Léo Tremblay", "Floor back · Maya Chen". */
export function micTurnLabel(
  turn: Pick<MicPastTurn, "kind" | "asker" | "target">,
  names: Names,
) {
  return `${kindWord(turn.kind)} · ${micTurnWho(turn, names)}`;
}

/** What a mic turn is, as a sentence: "@zoe asks Léo Tremblay". */
export function micTurnSentence(
  turn: Pick<MicPastTurn, "kind" | "asker" | "target">,
  names: Names,
) {
  const asker = askerName(turn.asker);
  switch (turn.kind) {
    case "question":
      return `${asker} asks ${names[turn.target]}`;
    case "followup":
      return `${asker} follows up with ${names[turn.target]}`;
    case "extq":
      return `${asker} asks ${names[turn.target]} one more`;
    case "resume":
      return `${names[other(turn.target)]} has the floor back`;
    default:
      return `${names[turn.target]} answers ${asker}`;
  }
}

/**
 * The label under the clock: a mic's turn by its kind and who has the floor,
 * a debater's turn by its number out of the debate's turns.
 */
export function turnTitle(input: {
  turnNumber: number | null;
  total: number | null;
  turns: readonly MicPastTurn[] | undefined;
  names: Names;
}) {
  if (!input.turnNumber) return "";
  const mic = micTurnAt(input.turns, input.turnNumber);
  if (mic) return micTurnLabel(mic, input.names);
  const total = totalTurns(input.total, input.turns);
  return total
    ? `Turn ${input.turnNumber} of ${total}`
    : `Turn ${input.turnNumber}`;
}

/**
 * Who speaks after a mic turn ends, as far as the page can tell: the target
 * after the asker; the asker after the first answer; after the last answer,
 * the asker again if viewers funded an extension, else the other debater.
 * Null after the resume turn: a queued mic may start.
 */
export function nextAfterMicTurn(
  turn: Pick<MicTurn, "kind" | "asker" | "target">,
  funded: boolean,
  names: Names,
): { side: Side | null; name: string } | null {
  switch (turn.kind) {
    case "question":
    case "followup":
    case "extq":
      return { side: turn.target, name: first(names[turn.target]) };
    case "answer":
      return { side: null, name: askerName(turn.asker) };
    case "answer2":
    case "exta":
      return funded
        ? { side: null, name: askerName(turn.asker) }
        : { side: other(turn.target), name: first(names[other(turn.target)]) };
    default:
      return null;
  }
}

// ---- The list ----

export type MicPhase =
  /** The debate has no mic: nothing is shown. */
  | "off"
  /** The mic is on and the list has not opened yet. */
  | "before"
  | "open"
  /** The debate is over: the list took its last question. */
  | "over";

export interface RowView {
  id: string;
  rank: number;
  text: string;
  /** "@zoe · 4 pledges". */
  meta: string;
  total: string;
  /** The question's total as a percent of the list leader's, for its bar. */
  share: number;
  adds: { text: string; by: string }[];
  /** The viewer's own held pledges on it; the wager carries their question. */
  mine: { id: string; amount: number; wager: boolean }[];
  own: boolean;
  /** F1: only the camp's #1 can fire, and only its author. */
  canFire: boolean;
  canPledge: boolean;
}
export interface CampView {
  /** The debater this camp's questions are for. */
  target: Side;
  rows: RowView[];
  /** The camp's mic once it fired: no more questions in this list (L22). */
  fired: MicEntry | null;
  /** Why the viewer can't ask this debater now; null when they can. */
  askBlocked: string | null;
  empty: string;
}
export interface Viewer {
  signedIn: boolean;
  own: MicOwn | null;
  /** The debate's status: the list is for a live debate only (L18). */
  eventStatus: string;
}

export function micPhase(mic: MicPublic | null, eventStatus: string): MicPhase {
  if (!mic || mic.enabled === false) return "off";
  if (!["scheduled", "ready", "live"].includes(eventStatus)) return "over";
  if (mic.list?.state === "open") return "open";
  // An older server names no switch; a debate with a list has the mic on.
  if (mic.enabled === undefined && !mic.list) return "off";
  return mic.list ? "over" : "before";
}

/** The line under the panel's heading. */
export function stateLine(phase: MicPhase, mic: MicPublic | null) {
  switch (phase) {
    case "before":
      return `The question list opens after round ${LIST_OPENS_AFTER_ROUND}.`;
    case "open":
      return mic?.list?.extra
        ? "A new list is open. Each debater's top question can fire at any time."
        : "The list is open. Each debater's top question can fire at any time.";
    case "over":
      return "The list is closed. Unfired questions were refunded.";
    default:
      return "";
  }
}

export function campView(
  mic: MicPublic,
  target: Side,
  viewer: Viewer,
  names: Names,
): CampView {
  const camp = other(target);
  const list = mic.list;
  const open = list?.state === "open" && viewer.eventStatus === "live";
  const fired =
    (list && mic.mics.find((m) => m.listId === list.id && m.camp === camp)) ||
    null;
  const own = viewer.own;
  const canAct = open && viewer.signedIn && own !== null && !own.seated;
  const questions = list?.camps[camp] ?? [];
  const everyQuestion = list ? [...list.camps.A, ...list.camps.B] : [];
  const ownQuestion = everyQuestion.find((question) =>
    own?.pledges.some((p) => p.wager && p.questionId === question.id),
  );
  const most = Math.max(0, ...questions.map((question) => question.total));
  const rows = questions.map((question, index): RowView => {
    const mine = (own?.pledges ?? [])
      .filter((pledge) => pledge.questionId === question.id)
      .map(({ id, amount, wager }) => ({ id, amount, wager }));
    const isOwn = mine.some((pledge) => pledge.wager);
    return {
      id: question.id,
      rank: index + 1,
      text: question.text,
      meta: `${askerName(question.author)} · ${question.pledges} pledge${question.pledges === 1 ? "" : "s"}`,
      total: yc(question.total),
      share: most > 0 ? Math.round((question.total / most) * 100) : 0,
      adds: question.adds.map((add) => ({
        text: add.text,
        by: askerName(add.by),
      })),
      mine,
      own: isOwn,
      canFire: canAct && isOwn && index === 0 && !fired,
      canPledge: canAct && !fired,
    };
  });
  const askBlocked = !open
    ? "The list isn't open."
    : fired
      ? `${first(names[target])} has already been asked in this list.`
      : !viewer.signedIn
        ? "Asking and pledging need an account."
        : own?.seated
          ? "Debaters can't ask or pledge in their own debate."
          : ownQuestion
            ? "You already have a question in this list. Withdraw it to ask another."
            : own === null
              ? "Checking your pledges…"
              : null;
  return {
    target,
    rows,
    fired,
    askBlocked,
    empty: fired
      ? `${askerName(fired.holder)} fired this mic for ${yc(fired.price)}.`
      : open
        ? `No questions for ${first(names[target])} yet.`
        : "",
  };
}

/**
 * The debater whose questions a phone shows first (it shows one list at a
 * time): the one the viewer asked, else the one with the most backed
 * question, else side A.
 */
export function firstCamp(mic: MicPublic, own: MicOwn | null): Side {
  const list = mic.list;
  if (!list) return "A";
  // A camp's questions are for the debater on the other side.
  const asked = (["A", "B"] as const).find((camp) =>
    list.camps[camp].some((question) =>
      own?.pledges.some((p) => p.wager && p.questionId === question.id),
    ),
  );
  if (asked) return other(asked);
  const top = (camp: Side) => list.camps[camp][0]?.total ?? 0;
  return top("A") > top("B") ? "B" : "A";
}

/** The question the viewer could fire now, in either camp. */
export function fireable(mic: MicPublic, viewer: Viewer, names: Names) {
  for (const target of ["A", "B"] as const) {
    const row = campView(mic, target, viewer, names).rows.find(
      (candidate) => candidate.canFire,
    );
    if (row) return { target, row };
  }
  return null;
}

/** The tab's and the rail button's badge: "#1" when the viewer can fire, else the open questions. */
export function micBadge(mic: MicPublic | null, viewer: Viewer, names: Names) {
  if (!mic?.list || mic.list.state !== "open") return "";
  if (fireable(mic, viewer, names)) return "#1";
  const count = mic.list.camps.A.length + mic.list.camps.B.length;
  return count ? String(count) : "";
}

// ---- The live mic, its queue and the fund ----

export interface LiveView {
  /** "@zoe has the mic". */
  line: string;
  /** "Asking Léo Tremblay · follow-up". */
  detail: string;
  /** The mics waiting their turn: "@kofi asks Maya Chen". */
  queued: string[];
}

export function liveView(mic: MicPublic, names: Names): LiveView | null {
  const live = mic.mics.find((entry) => entry.state === "live");
  const queued = mic.mics
    .filter((entry) => entry.state === "queued")
    .map((entry) => `${askerName(entry.holder)} asks ${names[entry.target]}`);
  if (!live) return queued.length ? { line: "", detail: "", queued } : null;
  const turn = mic.turn?.micId === live.id ? mic.turn : null;
  return {
    line: `${askerName(live.holder)} has the mic`,
    detail: turn
      ? `Asking ${names[live.target]} · ${kindWord(turn.kind).toLowerCase()}`
      : `Asking ${names[live.target]} · starting`,
    queued,
  };
}

export interface FundView {
  /** "Keep @zoe on for one more question". */
  title: string;
  /** "120 of 340 YC". */
  progress: string;
  percent: number;
  /** Whole YC still missing; a pledge above it is cut to it (X12). */
  left: number;
  open: boolean;
  /** What happens next, or what happened. */
  note: string;
  /** "You pledged 20 YC." */
  mine: string;
}

export function fundView(mic: MicPublic, own: MicOwn | null): FundView | null {
  const fund = mic.fund;
  if (!fund) return null;
  const holder = mic.mics.find((entry) => entry.id === fund.micId)?.holder;
  const who = askerName(holder ?? null);
  const left = Math.max(0, fund.price - fund.raised);
  const mine =
    own?.kept?.fundId === fund.id ? `You pledged ${yc(own.kept.amount)}.` : "";
  const note =
    fund.state === "open"
      ? `Open until their ${fund.closesAfter === "followup" ? "follow-up" : "extra question"} ends. Refunded if the price isn't reached.`
      : fund.state === "funded"
        ? `Funded: ${who} stays on for one more question and answer.`
        : "Not funded. Pledges are refunded.";
  return {
    title: `Keep ${who} on for one more question`,
    progress: `${fund.raised.toLocaleString("en-US")} of ${yc(fund.price)}`,
    percent: fund.price
      ? Math.min(100, Math.round((fund.raised / fund.price) * 100))
      : 0,
    left,
    open: fund.state === "open" && left > 0,
    note,
    mine,
  };
}

// ---- The band over the video ----

export interface BandView {
  /** "MIC · QUESTION". */
  kicker: string;
  /** "@zoe asks Léo Tremblay". */
  line: string;
  /** The words on screen: the asker's typed text, else the question backed. */
  text: string;
  /** True while the asker has the floor: the text is the turn's content. */
  asking: boolean;
  /** "Keep @zoe on · 120 of 340 YC", while the fund takes pledges. */
  fund: { label: string; percent: number } | null;
}

/**
 * The words on screen in a mic turn. The asker's own turn shows what they
 * typed; until they type, their first question shows the one that won the
 * mic (E7: they may ask another). An answer shows the question it answers.
 */
function shownText(mic: MicPublic, turn: MicTurn) {
  const backed = mic.mics.find((entry) => entry.id === turn.micId)?.text ?? "";
  if (askerKind(turn.kind))
    return turn.text ?? (turn.kind === "question" ? backed : "");
  const asked = (mic.turns ?? [])
    .filter(
      (past) =>
        past.micId === turn.micId &&
        past.turnNumber < turn.turnNumber &&
        askerKind(past.kind),
    )
    .at(-1);
  return asked?.text ?? (!asked || asked.kind === "question" ? backed : "");
}

export function bandView(mic: MicPublic | null, names: Names): BandView | null {
  const turn = mic?.turn;
  if (!mic || !turn || turn.kind === "resume") return null;
  const fund =
    mic.fund && mic.fund.micId === turn.micId && mic.fund.state === "open"
      ? fundView(mic, null)
      : null;
  return {
    kicker: `Mic · ${kindWord(turn.kind)}`,
    line: micTurnSentence(turn, names),
    text: shownText(mic, turn),
    asking: turn.speaker === "asker",
    fund: fund
      ? {
          label: `Keep ${askerName(turn.asker)} on · ${fund.progress}`,
          percent: fund.percent,
        }
      : null,
  };
}

// ---- The asker's own controls ----

export interface AskerView {
  /** "You have the mic: your question to Léo Tremblay". */
  title: string;
}

/** The viewer's own controls, only in their own asker turn. */
export function askerView(
  mic: MicPublic | null,
  own: MicOwn | null,
  names: Names,
): AskerView | null {
  const turn = mic?.turn;
  if (!turn || turn.speaker !== "asker" || !own?.mics.includes(turn.micId))
    return null;
  const what =
    turn.kind === "question"
      ? "question"
      : turn.kind === "followup"
        ? "follow-up"
        : "extra question";
  return {
    title: `You have the mic: your ${what} to ${names[turn.target]}`,
  };
}

// ---- "Yapper incoming" (F15) ----

export interface IncomingView {
  /** "@zoe". */
  asker: string;
  /** "asks Léo Tremblay". */
  target: string;
  /** "Maya Chen cut off · 0:23 lost", when the mic cut a turn. */
  cut: string;
  /** What a screen reader hears, once. */
  spoken: string;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The animation for a mic turn that just started: every mic's first question
 * (naming whom it cut and the time they lost) and every extension question.
 * Null for a turn already shown, or one the page found already under way, so
 * opening the page mid-question plays nothing.
 */
export function incomingView(input: {
  mic: MicPublic | null;
  names: Names;
  /** The turn the animation last played for. */
  seen: number | null;
  /** Server time in milliseconds. */
  now: number;
  turnSeconds: number;
}): (IncomingView & { turnNumber: number }) | null {
  const turn = input.mic?.turn;
  if (!input.mic || !turn || !turn.deadline) return null;
  if (turn.kind !== "question" && turn.kind !== "extq") return null;
  if (turn.turnNumber === input.seen) return null;
  const elapsed =
    input.turnSeconds * 1000 - (Date.parse(turn.deadline) - input.now);
  if (elapsed > 8000) return null;
  const entry = input.mic.mics.find((mic) => mic.id === turn.micId);
  const asker = askerName(turn.asker);
  const cut =
    turn.kind === "question" && entry?.cut
      ? `${input.names[entry.cut.side]} cut off · ${clock(entry.cut.lostMs)} lost`
      : "";
  return {
    turnNumber: turn.turnNumber,
    asker,
    target: `${turn.kind === "extq" ? "asks one more of" : "asks"} ${input.names[turn.target]}`,
    cut,
    spoken: `Yapper incoming. ${asker} ${turn.kind === "extq" ? "asks one more of" : "asks"} ${input.names[turn.target]}.${cut ? ` ${cut.replace(" · ", ", ")}.` : ""}`,
  };
}

// ---- "Yappers, the mic is open" ----

/** How long the phone full screen's invitation stays, in milliseconds. */
export const INVITE_MS = 4200;

/**
 * The list the phone full screen should announce as open, or null: an open
 * list not announced yet, to a viewer who can take part (not a seated
 * debater), while no mic is live or waiting to start.
 */
export function inviteDue(input: {
  mic: MicPublic | null;
  eventStatus: string;
  own: MicOwn | null;
  /** The list last announced on this device. */
  seen: string | null;
}) {
  const list = input.mic?.list;
  if (!input.mic || !list || micPhase(input.mic, input.eventStatus) !== "open")
    return null;
  if (list.id === input.seen || input.own?.seated) return null;
  if (input.mic.mics.some((entry) => entry.state !== "done")) return null;
  return list.id;
}

// ---- Reading the list ----

/**
 * How long until the page reads the list again, in milliseconds; null stops
 * it. A live debate's list moves by the second; an upcoming one only needs to
 * learn that it went live; a replay reads once, for its turns' names.
 */
export function pollDelay(input: {
  /** False once the server said it has no mic routes. */
  available: boolean;
  eventStatus: string;
  hidden: boolean;
  /** A mic is live or queued. */
  busy: boolean;
}): number | null {
  if (!input.available) return null;
  if (input.eventStatus !== "live")
    return ["scheduled", "ready"].includes(input.eventStatus) ? 30_000 : null;
  if (input.hidden) return 20_000;
  return input.busy ? 2000 : 4000;
}

/**
 * What the viewer's own part depends on in the public list: it is read again
 * when a mic fires or ends, a fund opens or closes, or one of the questions
 * the viewer pledged to leaves the list.
 */
export function ownSignature(mic: MicPublic | null, own: MicOwn | null) {
  if (!mic) return "";
  const open = new Set(
    mic.list ? [...mic.list.camps.A, ...mic.list.camps.B].map((q) => q.id) : [],
  );
  return JSON.stringify([
    mic.list?.id ?? null,
    mic.mics.map((entry) => [entry.id, entry.state]),
    mic.fund ? [mic.fund.id, mic.fund.state] : null,
    (own?.pledges ?? []).map((pledge) => open.has(pledge.questionId)),
  ]);
}

/** A whole number of Yap Coins from a field, or null. */
export function wholeCoins(value: string) {
  const text = value.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(text)) return null;
  return Number(text);
}

/** The server's short reasons as sentences a viewer can act on. */
export function micError(
  status: number | undefined,
  message: string,
  code?: string,
) {
  if (status === 401) return "Sign in to use the mic.";
  if (status === 429)
    return "Too many requests. Wait a moment, then try again.";
  if (message === "join the live debate first")
    return "Stay on this page a few seconds so the debate counts you as watching, then try again.";
  if (code === "insufficient_balance")
    return "You don't have enough Yap Coins for that.";
  if (code === "mic_paused")
    return "The mic is paused for a moment. Nothing was spent; try again.";
  if (code === "busy")
    return "Yap Coins are busy. Nothing was held; try again.";
  if (code === "session_changed")
    return "Your account changed in another tab. Reload the page.";
  if (!message || status === undefined || status >= 500)
    return "That didn't go through. Nothing was held; try again.";
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
