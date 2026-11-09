// The one source for an account's Yap Coins balance: the coin sandbox
// summary (Decision 0013). The header, its pop-up, /coins and the debate
// panel all read it, and each reads again on `yap:coins-changed`, which a
// stake, a daily claim and a reveal dispatch.
import { api, apiError, apiErrorStatus, apiFetch } from "./api.js";

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
    /** A summary this page just read, for every balance on it. */
    "yap:coins-summary": CustomEvent<CoinSummary>;
  }
  interface Window {
    /** The summary request in flight, shared by the page's modules. */
    yapCoinSummaryRead?: Promise<Response>;
  }
}

/**
 * Reads the summary once for the whole page: a caller that asks while a read
 * is in flight gets a copy of its response. The page's modules each bundle
 * their own copy of this file, so the request in flight lives on window.
 * Each successful read is announced as yap:coins-summary.
 */
export async function fetchSummary(timeout = 10_000): Promise<Response> {
  let pending = window.yapCoinSummaryRead;
  if (!pending) {
    const request = apiFetch("/api/coin-sandbox/summary", {
      cache: "no-store",
      timeout,
    });
    pending = window.yapCoinSummaryRead = request;
    // Shared only while in flight: the next caller after it answers reads anew.
    void request
      .finally(() => {
        if (window.yapCoinSummaryRead === request)
          delete window.yapCoinSummaryRead;
      })
      .catch(() => {
        // Each caller sees the failure itself.
      });
    void request
      .then(async (response) => {
        if (!response.ok) return;
        const value: CoinSummary = await response.clone().json();
        window.dispatchEvent(
          new CustomEvent("yap:coins-summary", { detail: value }),
        );
      })
      .catch(() => {
        // A body that isn't a summary is the callers' failure to report.
      });
  }
  return (await pending).clone();
}

// A read sent for the previous account never answers for the next one.
if (typeof window !== "undefined" && "addEventListener" in window)
  for (const name of ["yap:account-changed", "yap:provider-logout"] as const)
    window.addEventListener(name, () => {
      delete window.yapCoinSummaryRead;
    });

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

/** The signed-in account's summary, through the page's shared read. */
export async function readSummary(timeout = 10_000): Promise<CoinSummary> {
  const response = await fetchSummary(timeout);
  if (!response.ok) throw await apiError(response);
  const value: CoinSummary = await response.json();
  return value;
}
const read = readSummary;

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
