import type { AccountWalletSummary } from "../src/features/account-wallet/types.js";
import { apiFetch } from "./lib/api.js";
import { formatCoins } from "./lib/coin-format.js";
import { held, readCoins, spendable, type CoinSummary } from "./lib/coins.js";
import { sessionStore } from "./lib/session.js";

type WalletView = AccountWalletSummary & {
  enabled: boolean;
  withdrawalsEnabled: boolean;
};
// Yap Coins are always on (Decision 0013): while the coin sandbox runs, its
// summary is the account's balance everywhere. The live wallet is the
// fallback for a site without it (404); it holds nothing in phase 1.
type Balance =
  | { kind: "coins"; summary: CoinSummary }
  | { kind: "wallet"; value: WalletView };
// The page's session store turns other tabs' account changes into
// yap:account-changed, which clears the wallet below.
sessionStore();
let walletRead: Promise<Balance | null> | undefined;
let walletEpoch = 0;
window.addEventListener("yap:account-changed", () => {
  walletEpoch++;
  walletRead = undefined;
});
async function liveWallet(epoch: number): Promise<Balance | null> {
  const response = await apiFetch("/api/account-wallet", { cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Balance unavailable. Try again shortly.");
  const value: WalletView = await response.json();
  return value.enabled && epoch === walletEpoch
    ? { kind: "wallet", value }
    : null;
}
function readWallet() {
  const epoch = walletEpoch;
  walletRead ??= readCoins()
    .then((read): Promise<Balance | null> | Balance | null =>
      read.state === "ready"
        ? epoch === walletEpoch
          ? { kind: "coins", summary: read.summary }
          : null
        : read.state === "absent"
          ? liveWallet(epoch)
          : null,
    )
    .finally(() => {
      if (epoch === walletEpoch) walletRead = undefined;
    });
  return walletRead;
}
// The live wallet's withdrawal balance and grant progress. Shown only once
// real withdrawals open (founder D3); until then the header shows the
// balance alone.
function showWalletSummary(target: HTMLElement, value: WalletView) {
  const heading = document.createElement("strong"),
    headingLabel = document.createElement("span"),
    amount = document.createElement("span"),
    unit = document.createElement("small");
  heading.className = "wallet-available";
  headingLabel.textContent = "Available for withdrawal:";
  amount.className = "wallet-available-amount";
  amount.textContent = value.withdrawable + " ";
  unit.textContent = "YC";
  amount.append(unit);
  heading.append(headingLabel, document.createTextNode(" "), amount);
  const note = document.createElement("p");
  note.className = "wallet-availability-note";
  note.textContent =
    "Coins you buy can be withdrawn. Grant coins can only be spent; their profits unlock once the grant qualifies.";
  const list = document.createElement("div");
  list.className = "wallet-grant-progress";
  if (!value.grants.length) {
    const empty = document.createElement("p");
    empty.className = "wallet-grants-empty";
    empty.textContent = "No grants yet.";
    list.append(empty);
  }
  for (const [index, grant] of value.grants.entries()) {
    const row = document.createElement("div"),
      label = document.createElement("label"),
      name = document.createElement("span"),
      state = document.createElement("span"),
      bar = document.createElement("progress"),
      detail = document.createElement("p");
    const id = `${target.id}-grant-${index}`;
    label.htmlFor = id;
    row.className = `wallet-grant-row${grant.qualified ? " is-qualified" : ""}`;
    name.textContent = grant.label;
    state.className = "wallet-grant-state";
    state.textContent = grant.qualified ? "Qualified ✓" : `${grant.percent}%`;
    label.append(name, state);
    bar.id = id;
    bar.max = 100;
    bar.value = grant.percent;
    bar.setAttribute(
      "aria-valuetext",
      grant.qualified
        ? "Qualified; this grant stays qualified"
        : `${grant.netProfit} of ${grant.target} YC net profit. ${grant.remaining} YC still needed.`,
    );
    detail.textContent = grant.qualified
      ? "Qualified. Remaining profits stay eligible after losses."
      : `${grant.netProfit} / ${grant.target} YC net profit · ${grant.remaining} YC to qualify`;
    row.append(label, bar, detail);
    list.append(row);
  }
  const breakdown = document.createElement("dl");
  breakdown.className = "wallet-balance-breakdown";
  for (const [label, amount] of [
    ["Available", value.available],
    ["Reserved", value.reserved],
    ["Pending", value.pending],
    ["Promotional", value.promotional],
  ] as const) {
    const item = document.createElement("div"),
      term = document.createElement("dt"),
      balance = document.createElement("dd");
    term.textContent = label;
    balance.textContent = `${amount} YC`;
    item.append(term, balance);
    breakdown.append(item);
  }
  const content: HTMLElement[] = [heading, note, breakdown];
  if (value.grants.length) {
    const title = document.createElement("h3");
    title.className = "wallet-grants-title";
    title.textContent = "Grant progress";
    content.push(title);
  }
  target.replaceChildren(...content, list);
  target.hidden = false;
}
// The /coins card: the balance and what open positions hold, from the same
// summary as the header and the debate panel; a sign-in prompt for visitors.
const coinWallet = document.querySelector<HTMLElement>("#account-wallet");
function showCoinWallet(value: Balance | null, problem = "") {
  if (!coinWallet) return;
  const status = coinWallet.querySelector<HTMLElement>(
    "[data-coin-wallet-status]",
  );
  const signedOut = coinWallet.querySelector<HTMLElement>(
    "[data-coin-wallet-signed-out]",
  );
  const balances = coinWallet.querySelector<HTMLElement>(
    "[data-coin-wallet-balances]",
  );
  if (status) {
    status.textContent = problem;
    status.hidden = !problem;
  }
  if (signedOut) signedOut.hidden = Boolean(value) || Boolean(problem);
  if (balances) balances.hidden = !value;
  const figures =
    value?.kind === "coins"
      ? {
          available: formatCoins(spendable(value.summary.balances)),
          held: formatCoins(held(value.summary.balances)),
        }
      : value?.kind === "wallet"
        ? {
            available: `${value.value.available} YC`,
            held: `${value.value.reserved} YC`,
          }
        : null;
  for (const target of coinWallet.querySelectorAll<HTMLElement>(
    "[data-funds]",
  )) {
    const kind = target.dataset.funds;
    target.textContent =
      figures && (kind === "available" || kind === "held")
        ? figures[kind]
        : "—";
  }
}
let cardVersion = 0;
async function refreshCard() {
  if (!coinWallet) return;
  const epoch = walletEpoch,
    current = ++cardVersion;
  try {
    const value = await readWallet();
    if (epoch !== walletEpoch || current !== cardVersion) return;
    showCoinWallet(value);
  } catch {
    if (epoch !== walletEpoch || current !== cardVersion) return;
    showCoinWallet(
      null,
      "Your balance is temporarily unavailable. Refresh to try again.",
    );
  }
}
for (const [index, menu] of document
  .querySelectorAll<HTMLDetailsElement>(".arena-wallet-menu")
  .entries()) {
  const popover = menu.querySelector<HTMLElement>(".arena-wallet-popover");
  if (
    !popover ||
    (!document.documentElement.hasAttribute("data-email-first") &&
      !document.querySelector("#email-auth"))
  )
    continue;
  const summary = document.createElement("section");
  summary.id = `wallet-withdrawal-${index}`;
  summary.className = "wallet-money-summary";
  summary.hidden = true;
  const status = document.createElement("p");
  status.role = "status";
  popover.prepend(summary);
  popover.append(status);
  let version = 0;
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
  menu.addEventListener("toggle", async () => {
    const current = ++version;
    if (!menu.open) return;
    // Remove stale values while refreshing; never keep another account's data.
    summary.hidden = true;
    try {
      const value = await readWallet();
      if (current !== version || !menu.open) return;
      status.textContent = "";
      const withdrawals =
        value?.kind === "wallet" && value.value.withdrawalsEnabled;
      popover.classList.toggle("wallet-progress-enabled", Boolean(withdrawals));
      if (withdrawals) showWalletSummary(summary, value.value);
    } catch {
      if (current === version)
        status.textContent = "Balance unavailable. Close and reopen to retry.";
    }
  });
  window.addEventListener("yap:account-changed", () => {
    version++;
    summary.replaceChildren();
    summary.hidden = true;
    status.textContent = "";
    popover.classList.remove("wallet-progress-enabled");
    if (menu.open) {
      menu.open = false;
    }
  });
}
window.addEventListener("yap:account-changed", () => {
  void refreshCard();
});
// A stake, a daily claim or a reveal changed the balance.
window.addEventListener("yap:coins-changed", () => {
  void refreshCard();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refreshCard();
});
void refreshCard();
