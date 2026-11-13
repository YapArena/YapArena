// Decision 0015: the counting rule, in one pure, browser-safe place. The SQL
// selects the eligible answers; these functions turn them into the rate and
// the switching statistics.
import type {
  DebateEndorsement,
  DebateEndorsementFigure,
  EndorsementAnswer,
  EndorsementFold,
  EndorsementSide,
  Switching,
} from "./types.ts";

export const ENDORSEMENT_METHOD = "last-answer-v1";

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Answer order: order time, then the round's reveal time, turn and round id,
 * all ascending, so ties on order time always resolve the same way.
 */
export function compareAnswers(a: EndorsementAnswer, b: EndorsementAnswer) {
  return (
    compareText(a.createdAt, b.createdAt) ||
    compareText(a.revealedAt, b.revealedAt) ||
    a.turnNumber - b.turnNumber ||
    compareText(a.roundId, b.roundId)
  );
}

export function orderAnswers(answers: readonly EndorsementAnswer[]) {
  return [...answers].sort(compareAnswers);
}

export function emptySwitching(): Switching {
  return {
    multiAnswerAccounts: 0,
    switchers: 0,
    stayed: 0,
    cameBack: 0,
    pairs: { within: 0, between: 0 },
    switches: { within: 0, between: 0 },
    toYes: 0,
    toNo: 0,
  };
}

interface AccountTrail {
  first: EndorsementSide;
  last: EndorsementSide;
  lastDebate: string;
  answers: number;
  switched: boolean;
}

function trails(answers: readonly EndorsementAnswer[], switching: Switching) {
  const byAccount = new Map<string, AccountTrail>();
  for (const answer of orderAnswers(answers)) {
    const trail = byAccount.get(answer.userId);
    if (!trail) {
      byAccount.set(answer.userId, {
        first: answer.side,
        last: answer.side,
        lastDebate: answer.debateId,
        answers: 1,
        switched: false,
      });
      continue;
    }
    const where = trail.lastDebate === answer.debateId ? "within" : "between";
    switching.pairs[where]++;
    if (answer.side !== trail.last) {
      switching.switches[where]++;
      if (answer.side === "YES") switching.toYes++;
      else switching.toNo++;
      trail.switched = true;
    }
    trail.last = answer.side;
    trail.lastDebate = answer.debateId;
    trail.answers++;
  }
  return byAccount;
}

/**
 * Each account's kept (last) answer, the YES share of them, and how answers
 * changed. Answers may come in any order.
 */
export function foldAnswers(
  answers: readonly EndorsementAnswer[],
): EndorsementFold {
  const switching = emptySwitching();
  let yes = 0;
  const accounts = trails(answers, switching);
  for (const trail of accounts.values()) {
    if (trail.last === "YES") yes++;
    if (trail.answers >= 2) switching.multiAnswerAccounts++;
    if (trail.switched) {
      switching.switchers++;
      if (trail.first === trail.last) switching.cameBack++;
      else switching.stayed++;
    }
  }
  return { yes, accounts: accounts.size, switching };
}

function highestTurn(answers: readonly EndorsementAnswer[]) {
  let highest: number | null = null;
  for (const answer of answers)
    if (highest === null || answer.turnNumber > highest)
      highest = answer.turnNumber;
  return highest;
}

function figureThrough(
  answers: readonly EndorsementAnswer[],
  throughTurn: number,
): DebateEndorsementFigure {
  const { yes, accounts } = foldAnswers(
    answers.filter((answer) => answer.turnNumber <= throughTurn),
  );
  return { throughTurn, yes, accounts };
}

/**
 * One debate's figure through a counted turn, with the figure through the
 * previous counted turn and, per account, its first to last answer. The
 * answers are one debate's counted answers; null when none reach the turn.
 */
export function debateFigure(
  answers: readonly EndorsementAnswer[],
  throughTurn: number,
): DebateEndorsement | null {
  const counted = answers.filter((answer) => answer.turnNumber <= throughTurn);
  if (!counted.length) return null;
  const current = figureThrough(counted, throughTurn);
  const earlier = highestTurn(
    counted.filter((answer) => answer.turnNumber < throughTurn),
  );
  const previous = earlier === null ? null : figureThrough(counted, earlier);
  const switched = { toYes: 0, toNo: 0, cameBack: 0 };
  let multiAnswerAccounts = 0;
  for (const trail of trails(counted, emptySwitching()).values()) {
    if (trail.answers >= 2) multiAnswerAccounts++;
    if (!trail.switched) continue;
    if (trail.first === trail.last) switched.cameBack++;
    else if (trail.last === "YES") switched.toYes++;
    else switched.toNo++;
  }
  return { ...current, previous, switched, multiAnswerAccounts };
}

/** The debate figure through its highest counted turn. */
export function latestDebateFigure(answers: readonly EndorsementAnswer[]) {
  const turn = highestTurn(answers);
  return turn === null ? null : debateFigure(answers, turn);
}

/**
 * The debate figure through each counted turn, in turn order, so a replay's
 * bar can follow the playing turn. The last one is latestDebateFigure.
 */
export function debateFigures(
  answers: readonly EndorsementAnswer[],
): DebateEndorsement[] {
  const turns = [...new Set(answers.map((answer) => answer.turnNumber))].sort(
    (a, b) => a - b,
  );
  return turns.flatMap((turn) => debateFigure(answers, turn) ?? []);
}
