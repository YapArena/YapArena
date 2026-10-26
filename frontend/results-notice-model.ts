// Pure logic for the in-app Yap Coins results notice (Decision 0013,
// interface 10): which revealed positions are new, grouped per debate, and
// the notice's words. No DOM access, so tests can import the built module.
import { signedCoins } from "./stake-model.js";

/** One revealed or voided position from GET /api/coin-sandbox/results. */
export interface RevealedResult {
  roundId: string;
  debateId: string;
  slug: string;
  proposition: string;
  turnNumber: number | null;
  turnSide: "A" | "B" | null;
  state: "settled" | "void";
  voidReason: string | null;
  side: "YES" | "NO";
  quantity: number;
  outcome: {
    status: string;
    premium: string;
    fee: string;
    payout: string;
    net: string;
  } | null;
  revealedAt: string;
}
export interface ResultsResponse {
  serverNow: string;
  results: RevealedResult[];
}

/** New results for one debate. */
export interface NoticeGroup {
  debateId: string;
  slug: string;
  proposition: string;
  positions: number;
  voided: number;
  net: bigint;
  newest: string;
}

// A device's first check looks back a week, so results revealed while it
// was away still get a notice.
const firstLookBack = 7 * 24 * 60 * 60 * 1000;
const isoTime = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** The `since` to ask for: the stored last-seen time, or a week ago. */
export function sinceFor(stored: string | null, now: number) {
  return stored && isoTime.test(stored) && !Number.isNaN(Date.parse(stored))
    ? stored
    : new Date(now - firstLookBack).toISOString();
}

/** The newest reveal time among results, to store as last seen. */
export function newestRevealed(results: readonly RevealedResult[]) {
  let newest: string | null = null;
  for (const result of results)
    if (newest === null || Date.parse(result.revealedAt) > Date.parse(newest))
      newest = result.revealedAt;
  return newest;
}

/** Results revealed after `seenAt`, grouped per debate, newest first. */
export function noticeGroups(
  results: readonly RevealedResult[],
  seenAt: string | null,
) {
  const after = seenAt === null ? -Infinity : Date.parse(seenAt);
  const groups = new Map<string, NoticeGroup>();
  for (const result of results) {
    if (!(Date.parse(result.revealedAt) > after)) continue;
    const group = groups.get(result.debateId) ?? {
      debateId: result.debateId,
      slug: result.slug,
      proposition: result.proposition,
      positions: 0,
      voided: 0,
      net: 0n,
      newest: result.revealedAt,
    };
    group.positions += 1;
    if (result.state === "void") group.voided += 1;
    else if (result.outcome) group.net += BigInt(result.outcome.net);
    if (Date.parse(result.revealedAt) > Date.parse(group.newest))
      group.newest = result.revealedAt;
    groups.set(result.debateId, group);
  }
  return [...groups.values()].sort(
    (a, b) => Date.parse(b.newest) - Date.parse(a.newest),
  );
}

/** "“Canada should expand nuclear power” · +3.40 YC across 4 turns". */
export function groupLine(group: NoticeGroup) {
  const quoted = `“${group.proposition}”`;
  if (group.voided === group.positions)
    return group.positions === 1
      ? `${quoted} · your position was refunded`
      : `${quoted} · ${group.positions} positions were refunded`;
  const refunded = group.voided ? ` · ${group.voided} refunded` : "";
  return `${quoted} · ${signedCoins(group.net)} across ${group.positions} ${group.positions === 1 ? "turn" : "turns"}${refunded}`;
}

/** The note under the debates, counting new debates the notice doesn't name. */
export function noteText(hidden: number) {
  const more =
    hidden > 0
      ? `And ${hidden} more ${hidden === 1 ? "debate" : "debates"}. `
      : "";
  return `${more}Simulated, no cash value.`;
}
