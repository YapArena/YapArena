import type { AccountWalletSummary } from "../src/features/account-wallet/types.js";
import { apiFetch } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";

type WalletView = AccountWalletSummary & {
  enabled: boolean;
  withdrawalsEnabled: boolean;
};
// The page's session store turns other tabs' account changes into
// yap:account-changed, which clears the wallet below.
sessionStore();
let walletRead: Promise<WalletView | null> | undefined;
let walletEpoch = 0;
window.addEventListener("yap:account-changed", () => {
  walletEpoch++;
  walletRead = undefined;
});
function readWallet() {
  const epoch = walletEpoch;
  walletRead ??= apiFetch("/api/account-wallet", { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) return null;
      if (!response.ok)
        throw new Error("Balance unavailable. Try again shortly.");
      const value: WalletView = await response.json();
      return value.enabled && epoch === walletEpoch ? value : null;
    })
    .finally(() => {
      if (epoch === walletEpoch) walletRead = undefined;
    });
  return walletRead;
}
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
  note.textContent = value.withdrawalsEnabled
    ? "Coins you buy can be withdrawn. Grant coins can only be spent; their profits unlock once the grant qualifies."
    : "Withdrawals aren’t open yet.";
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
  const content: HTMLElement[] = [heading, note];
  if (target !== moneyCard) {
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
    content.push(breakdown);
  }
  if (value.grants.length) {
    const title = document.createElement("h3");
    title.className = "wallet-grants-title";
    title.textContent = "Grant progress";
    content.push(title);
  }
  target.replaceChildren(...content, list);
  target.hidden = false;
}
const moneyCard = document.querySelector<HTMLElement>(
  "#account-wallet-progress",
);
// The /coins wallet: balances for members, a sign-in prompt for visitors.
const coinWallet = document.querySelector<HTMLElement>("#account-wallet");
function showCoinWallet(value: WalletView | null, problem = "") {
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
  for (const target of coinWallet.querySelectorAll<HTMLElement>(
    "[data-funds]",
  )) {
    const kind = target.dataset.funds;
    const amount =
      kind === "available" ||
      kind === "reserved" ||
      kind === "pending" ||
      kind === "promotional"
        ? value?.[kind]
        : undefined;
    target.textContent = amount ? `${amount} YC` : "—";
  }
}
async function refreshMoneyCard() {
  if (!moneyCard) return;
  const epoch = walletEpoch;
  try {
    const value = await readWallet();
    if (epoch !== walletEpoch) return;
    showCoinWallet(value);
    if (value) showWalletSummary(moneyCard, value);
    else {
      moneyCard.replaceChildren();
      moneyCard.hidden = true;
    }
  } catch {
    if (epoch !== walletEpoch) return;
    showCoinWallet(
      null,
      "Your balance is temporarily unavailable. Refresh to try again.",
    );
    moneyCard.textContent =
      "Withdrawal progress is temporarily unavailable. Try your balance menu again shortly.";
    moneyCard.hidden = false;
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
  popover.classList.add("wallet-progress-enabled");
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
    status.textContent = "Checking withdrawal balance…";
    // Remove stale values while refreshing; never keep another account's data.
    summary.hidden = true;
    try {
      const value = await readWallet();
      if (current !== version || !menu.open) return;
      status.textContent = "";
      if (value) showWalletSummary(summary, value);
    } catch {
      if (current === version)
        status.textContent =
          "Withdrawal balance unavailable. Close and reopen to retry.";
    }
  });
  window.addEventListener("yap:account-changed", () => {
    version++;
    summary.replaceChildren();
    summary.hidden = true;
    status.textContent = "";
    if (menu.open) {
      menu.open = false;
    }
  });
}
window.addEventListener("yap:account-changed", () => {
  void refreshMoneyCard();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refreshMoneyCard();
});
for (const opener of document.querySelectorAll<HTMLAnchorElement>(
  "[data-wallet-progress-open]",
)) {
  const dialog = document.createElement("dialog"),
    header = document.createElement("div"),
    heading = document.createElement("div"),
    eyebrow = document.createElement("span"),
    title = document.createElement("h2"),
    body = document.createElement("section"),
    close = document.createElement("button"),
    status = document.createElement("p"),
    account = document.createElement("a");
  dialog.className = "wallet-balance-dialog information-card";
  header.className = "wallet-dialog-header";
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "YOUR ACCOUNT WALLET";
  title.id = "wallet-progress-title";
  title.textContent = "Your Yap Coins";
  dialog.setAttribute("aria-labelledby", title.id);
  body.id = "homepage-withdrawal-summary";
  body.className = "wallet-money-summary";
  close.type = "button";
  close.className = "wallet-dialog-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  status.role = "status";
  status.className = "wallet-dialog-status";
  account.href = "/coins";
  account.textContent = "Balances and Yap Coins →";
  account.className = "wallet-dialog-account-link";
  heading.append(eyebrow, title);
  header.append(heading, close);
  dialog.append(header, status, body, account);
  document.body.append(dialog);
  let version = 0;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    version++;
    body.replaceChildren();
    opener.focus();
  });
  window.addEventListener("yap:account-changed", () => dialog.close());
  opener.addEventListener("click", async (event) => {
    event.preventDefault();
    if (dialog.open) return;
    const current = ++version;
    status.textContent = "Checking your withdrawal balance…";
    body.replaceChildren();
    dialog.showModal();
    try {
      const value = await readWallet();
      if (!dialog.open || current !== version) return;
      status.textContent = value
        ? ""
        : "Sign in to view your balance and withdrawal progress.";
      if (value) showWalletSummary(body, value);
    } catch {
      if (dialog.open && current === version)
        status.textContent =
          "Withdrawal balance is temporarily unavailable. Close and try again.";
    }
  });
}
void refreshMoneyCard();
