// Decision 0015: the last-answer endorsement rate. Browser-safe types shared
// by the recorder, the public reads and the pages that show them.

export type EndorsementSide = "YES" | "NO";

/**
 * One counted answer: an order in a settled, revealed turn window of a
 * counted debate. Timestamps are UTC with microseconds
 * ("2026-11-13T12:00:00.123456Z"), so they compare as strings.
 */
export interface EndorsementAnswer {
  userId: string;
  side: EndorsementSide;
  createdAt: string;
  revealedAt: string;
  debateId: string;
  turnNumber: number;
  roundId: string;
}

/** How answers changed, over consecutive answers of each account. */
export interface Switching {
  multiAnswerAccounts: number;
  /** Accounts with at least one switch. */
  switchers: number;
  /** Switchers whose first answer differs from their last. */
  stayed: number;
  /** Switchers whose first answer equals their last. */
  cameBack: number;
  pairs: { within: number; between: number };
  switches: { within: number; between: number };
  /** Switches by direction. */
  toYes: number;
  toNo: number;
}

export interface EndorsementFold {
  yes: number;
  accounts: number;
  switching: Switching;
}

export interface DebateEndorsementFigure {
  throughTurn: number;
  yes: number;
  accounts: number;
}

/** The debate figure through its latest counted turn (the video bar). */
export interface DebateEndorsement extends DebateEndorsementFigure {
  previous: DebateEndorsementFigure | null;
  /** Per account, first to last answer in this debate. */
  switched: { toYes: number; toNo: number; cameBack: number };
  multiAnswerAccounts: number;
}

/** One stored point: the topic figure once a round was revealed. */
export interface EndorsementPoint {
  id: string;
  roundId: string;
  topicId: string;
  debateId: string;
  turnNumber: number;
  revealedAt: string;
  topicYes: number;
  topicAccounts: number;
  debateYes: number;
  debateAccounts: number;
  switching: Switching;
  /** The same statistics over this debate's answers only. */
  debateSwitching: Switching;
  method: string;
}

/** A published debate's link; null once the debate is no longer public. */
export interface EndorsementDebateLink {
  slug: string;
  title: string;
}

/** A history chart point (topic page). */
export interface EndorsementHistoryPoint {
  id: string;
  revealedAt: string;
  turnNumber: number;
  debate: EndorsementDebateLink | null;
  yes: number;
  accounts: number;
}

/** A counted debate's final figure, from its latest point. */
export interface EndorsementDebateResult {
  debateId: string;
  throughTurn: number;
  yes: number;
  accounts: number;
  switching: Switching;
}

/** The topic figure: its latest point. */
export interface TopicEndorsement {
  yes: number;
  accounts: number;
  switching: Switching;
  revealedAt: string;
  /** The debate behind the latest point (D14), null once it is hidden. */
  lastDebate: (EndorsementDebateLink & { liveEndedAt: string | null }) | null;
  /** Published debates with at least one point. */
  debatesCounted: number;
}

/** Everything the topic page reads, in one call. */
export interface TopicEndorsementPage {
  figure: TopicEndorsement | null;
  history: EndorsementHistoryPoint[];
  debates: EndorsementDebateResult[];
}
