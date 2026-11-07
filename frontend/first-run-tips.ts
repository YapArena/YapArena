// The first-run tips (first-run plan PR 12). frontend/site-header.ts loads this
// only while FIRST_RUN_TIPS_ENABLED is on. It adds the coin menu's two lines on
// every page and, on a debate page, two tips that each show once per browser:
// beside Yes and No the first time a turn can be answered, and on the results
// card the first time it shows a result. The answer panel itself is unchanged.
import {
  answerTip,
  COIN_MENU_LINES,
  RESULTS_TIP,
  TIP_KEYS,
} from "./first-run-copy.js";
import { guideList, markTipSeen, tipCard, tipSeen } from "./first-run-view.js";

// Tap your coins in the top bar: how answering with contracts works.
const popover = document.querySelector(".arena-wallet-popover");
if (popover && !popover.querySelector(".coin-menu-how")) {
  const lines = guideList(COIN_MENU_LINES, "coin-menu-how");
  const link = popover.querySelector("[data-header-balances-link]");
  if (link) link.before(lines);
  else popover.append(lines);
}

const panel = document.querySelector<HTMLElement>("[data-stake-panel]");
const sides = panel?.querySelector<HTMLElement>(".stake-sides");
const results = panel?.querySelector<HTMLElement>("[data-stake-results]");
let speaker: string | null = null;
let answerCard: HTMLElement | null = null;
let resultsCard: HTMLElement | null = null;

function answerable() {
  return [
    ...(sides?.querySelectorAll<HTMLButtonElement>("[data-stake-side]") ?? []),
  ].some((button) => !button.disabled);
}

function dismissAnswer() {
  markTipSeen(TIP_KEYS.answer);
  answerCard?.remove();
  answerCard = null;
}

function dismissResults() {
  markTipSeen(TIP_KEYS.results);
  resultsCard?.remove();
  resultsCard = null;
}

function showAnswerTip() {
  if (!sides || tipSeen(TIP_KEYS.answer) || !answerable()) return;
  const card = tipCard(answerTip(speaker), dismissAnswer);
  if (answerCard) answerCard.replaceWith(card);
  else sides.after(card);
  answerCard = card;
}

function showResultsTip() {
  if (!results || results.hidden || resultsCard || tipSeen(TIP_KEYS.results))
    return;
  resultsCard = tipCard(RESULTS_TIP, dismissResults);
  const title = results.querySelector("[data-stake-results-title]");
  if (title) title.after(resultsCard);
  else results.prepend(resultsCard);
}

if (panel && sides) {
  // The tip names whoever has the floor (the media snapshot's yap:turn).
  window.addEventListener("yap:turn", (event) => {
    const side = event.detail.activeSide;
    const name = side
      ? panel.dataset[side === "A" ? "speakerA" : "speakerB"]
      : undefined;
    speaker = name ?? null;
    if (answerCard) showAnswerTip();
  });
  // Tapping Yes or No answers the first tip.
  sides.addEventListener("click", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-stake-side]")
    )
      dismissAnswer();
  });
  // The panel turns its buttons on when a turn opens and shows its results
  // card once one is revealed.
  new MutationObserver(() => {
    if (!answerCard) showAnswerTip();
    showResultsTip();
  }).observe(panel, {
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden"],
  });
  showAnswerTip();
  showResultsTip();
}
