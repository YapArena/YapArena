// Every sentence of the first-run guide (first-run plan PRs 11 and 12) in one
// place, for the founder's review. Each part shows only while its switch is on
// (FIRST_RUN_WELCOME_ENABLED, FIRST_RUN_TIPS_ENABLED). The coin sentences
// follow the repo's A4 (docs/a4-mechanism.md): a contract pays the final share
// of people who answered its way, counted once each, and gains when that share
// ends above the price paid.

/** The welcome grant every account gets, in Yap Coins (grant-accounting.ts). */
export const WELCOME_GRANT_COINS = 2500;

/** One line of "How YAP Arena works": a bold lead, then the rest. */
export interface GuideLine {
  icon: "debate" | "answer" | "coins";
  lead: string;
  rest: string;
}

/** The welcome screen's three lines, on the handle pop-up's last step. */
export const WELCOME_LINES: readonly GuideLine[] = [
  {
    icon: "debate",
    lead: "Two people debate live",
    rest: ", on video, in short turns.",
  },
  {
    icon: "answer",
    lead: "During each turn, tap Yes or No.",
    rest: " Do you agree?",
  },
  {
    icon: "coins",
    lead: "Put Yap Coins on your answer.",
    rest: ` Each contract pays the final share who answered your way, so you gain when that share ends above the price you paid. Play money: you start with ${WELCOME_GRANT_COINS.toLocaleString("en-US")}.`,
  },
];

export const WELCOME_COPY = {
  eyebrow: "How YAP Arena works",
  ask: "What brings you here?",
  watch: "Watch debates",
  debate: "Debate myself",
  look: "Just look around",
} as const;

/** "Welcome, Maya": the first word of the new username. */
export function welcomeTitle(displayName: string) {
  const first = displayName.trim().split(/\s+/)[0];
  return first ? `Welcome, ${first}` : "Welcome";
}

/** Where each answer to "What brings you here?" leads; null stays put. */
export function intentPath(
  intent: string | undefined,
  matchmaking: boolean,
): string | null {
  if (intent === "watch") return "/live";
  if (intent === "debate") return matchmaking ? "/queue" : "/match";
  return null;
}

/** A one-time tip: its bold lead, the rest, and its count. */
export interface Tip {
  lead: string;
  rest: string;
  count: string;
}

/** Tip 1, beside Yes and No the first time a turn can be answered. */
export function answerTip(speaker: string | null): Tip {
  return {
    lead: "Your first turn.",
    rest: ` Listen to ${speaker || "the speaker"}, then tap Yes or No before the turn ends. You can answer again next turn.`,
    count: "Tip 1 of 2",
  };
}

/** Tip 2, on the results card the first time it shows a result. */
export const RESULTS_TIP: Tip = {
  lead: "Your first results.",
  rest: " A Yes contract pays the share of people who said yes, and a No contract the share who said no. You gain when your side's share ends above the price you paid, and lose when it ends below.",
  count: "Tip 2 of 2",
};

/** The coin menu's two lines (tap your coins in the top bar). */
export const COIN_MENU_LINES: readonly GuideLine[] = [
  {
    icon: "answer",
    lead: "Answer with contracts.",
    rest: " On any turn, say Yes or No, then choose how many contracts and the most you'll pay for each.",
  },
  {
    icon: "coins",
    lead: "Each contract pays the final share who answered your way.",
    rest: " You gain when that share ends above the price you paid, and lose when it ends below.",
  },
];

/** This browser's record of the tips already seen. */
export const TIP_KEYS = {
  answer: "yap:first-run-tip:answer",
  results: "yap:first-run-tip:results",
} as const;
