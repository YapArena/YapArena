// The one source for an account's Yap Coins balance: the coin sandbox
// summary (Decision 0013). The header, its pop-up, /coins and the debate
// panel all read it, and each reads again on `yap:coins-changed`, which a
// stake, a daily claim and a reveal dispatch.
import { api, apiErrorStatus } from "./api.js";

export interface CoinBalances {
  cashAvailable: string;
  reserved: string;
  pending: string;
  promotionalPrincipal: string;
  promotionalReserved: string;
}
export interface CoinFeatures {
  /** Simulated purchases, withdrawals and their error reports. */
  transfers: boolean;
  /** The /coins manual round form; off while turn windows run. */
  manualRounds: boolean;
}
export interface CoinSummary {
  sessionId: string;
  initialized: boolean;
  financialReviewRequired: boolean;
  balances: CoinBalances;
  /** Absent from servers that predate it, which offered every flow. */
  features?: CoinFeatures;
}

declare global {
  interface WindowEventMap {
    "yap:coins-changed": Event;
  }
}

/** Coins the account can spend now: cash plus grant principal. */
export function spendable(balances: CoinBalances) {
  return BigInt(balances.cashAvailable) + BigInt(balances.promotionalPrincipal);
}
/** Coins held by open positions, cash and grant principal alike. */
export function held(balances: CoinBalances) {
  return BigInt(balances.reserved) + BigInt(balances.promotionalReserved);
}
/** What this deployment offers; older servers offered everything. */
export function features(summary: CoinSummary): CoinFeatures {
  return summary.features ?? { transfers: true, manualRounds: true };
}

export type CoinRead =
  | { state: "signed-out" }
  | { state: "absent" }
  | { state: "ready"; summary: CoinSummary };

const read = (timeout: number) =>
  api<CoinSummary>("/api/coin-sandbox/summary", {
    cache: "no-store",
    timeout,
  });

/**
 * The signed-in account's summary; "absent" when the site runs without the
 * coin sandbox (404). Other failures throw.
 */
export async function readCoins(timeout = 10_000): Promise<CoinRead> {
  try {
    return { state: "ready", summary: await read(timeout) };
  } catch (error) {
    const status = apiErrorStatus(error);
    if (status === 401 || status === 403) return { state: "signed-out" };
    if (status === 404) return { state: "absent" };
    throw error;
  }
}

/**
 * Decision 0013: claims the welcome grant when a summary shows none, then
 * reads the summary again and tells the page's other balances. The server
 * claims it at most once, so concurrent callers are safe.
 */
export async function claimWelcome(
  summary: CoinSummary,
  timeout = 10_000,
): Promise<CoinSummary> {
  if (summary.initialized || summary.financialReviewRequired) return summary;
  await api("/api/coin-sandbox/initialize", {
    method: "POST",
    cache: "no-store",
    headers: { "X-YapArena-Session": summary.sessionId },
    json: {},
    timeout,
  });
  const next = await read(timeout);
  window.dispatchEvent(new Event("yap:coins-changed"));
  return next;
}
