// Decision 0016 point 7: when a turn the viewer answered is revealed, a
// pixel-framed plate pops up mid-screen on the phone's full screen for about
// 3.6 s: "YOU WON", "YOU LOST" or "BROKE EVEN", the amount counting up beside
// a pixel YC coin, and "N WINS IN A ROW" from the second win in a row. It
// reads the viewer's rounds from the answer panel's reads
// (frontend/stake-windows.ts), so it adds no request of its own. Results
// already revealed when it starts never pop; two revealed together show one
// after the other. Each is announced once, politely; the visuals are hidden
// from assistive technology. Under reduced motion the plate only fades and
// shows the final figure at once (public/arena.css).
import { onOwnRounds } from "./stake-windows.js";
import {
  COUNT_DELAY_MS,
  COUNT_MS,
  PLATE_MS,
  amountText,
  burstBits,
  countedHundredths,
  revealedTurnResults,
  type TurnResult,
} from "./turn-result-model.js";

export interface TurnResultOptions {
  /** The debate to follow; by default the host's closest data-debate-id. */
  debateId?: string;
  /** Whether to skip the count-up; by default prefers-reduced-motion. */
  reducedMotion?: () => boolean;
}

function part(tag: string, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The plate's visuals for one result, hidden from assistive technology. */
function plateElement(result: TurnResult) {
  const root = part("div", "watch-result");
  root.dataset.tone = result.tone;
  root.setAttribute("aria-hidden", "true");
  const anchor = part("div", "watch-result-anchor");
  anchor.append(part("span", "watch-result-wave"));
  for (const bit of burstBits(result.tone)) {
    const ray = part("span", "watch-result-ray");
    ray.style.setProperty("--watch-result-angle", `${bit.angle}deg`);
    const dot = part("i", "watch-result-bit");
    dot.classList.toggle("watch-result-near", bit.near);
    dot.classList.toggle("watch-result-drop", bit.drop);
    dot.classList.toggle("watch-result-small", bit.small);
    dot.classList.toggle("watch-result-alt", bit.alt);
    dot.style.setProperty("--watch-result-delay", `${bit.delayMs}ms`);
    ray.append(dot);
    anchor.append(ray);
  }
  const amount = part("span", "watch-result-amt", amountText(result.tone, 0));
  const figure = part("span", "watch-result-figure");
  figure.append(amount, part("span", "watch-result-coin", "YC"));
  const body = part("div", "watch-result-px watch-result-body");
  body.append(part("span", "watch-result-word", result.word), figure);
  if (result.streakText)
    body.append(
      part("span", "watch-result-px watch-result-streak", result.streakText),
    );
  const frame = part("div", "watch-result-px watch-result-frame");
  frame.classList.toggle("watch-result-shake", result.tone === "loss");
  frame.append(body);
  const plate = part("div", "watch-result-plate");
  plate.append(frame);
  const centre = part("div", "watch-result-centre");
  centre.append(plate);
  anchor.append(centre);
  root.append(part("div", "watch-result-flash"), anchor);
  return { root, amount };
}

/**
 * Pops the viewer's turn results on `host`, a positioned layer over the whole
 * full screen. The plate centres on the host, or on the point its
 * --watch-result-x and --watch-result-y custom properties name. Returns a
 * function that stops watching and removes the plate.
 */
export function watchTurnResults(
  host: HTMLElement,
  options: TurnResultOptions = {},
) {
  const debateId =
    options.debateId ??
    host.closest<HTMLElement>("[data-debate-id]")?.dataset.debateId;
  if (!debateId) return () => {};
  const reducedMotion =
    options.reducedMotion ??
    (() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  // A polite live region that stays in place, so each announcement is read.
  const status = part("p", "sr-only watch-result-status");
  status.setAttribute("role", "status");
  status.dataset.watchResultStatus = "";
  host.append(status);

  let seen: ReadonlySet<string> | null = null;
  const queue: TurnResult[] = [];
  let shown: HTMLElement | null = null;
  let frame = 0;
  let timer: number | undefined;

  function countUp(amount: HTMLElement, result: TurnResult, start: number) {
    const run = (now: number) => {
      const elapsed = now - start;
      amount.textContent = amountText(
        result.tone,
        countedHundredths(result.hundredths, elapsed),
      );
      if (elapsed < COUNT_DELAY_MS + COUNT_MS)
        frame = requestAnimationFrame(run);
    };
    frame = requestAnimationFrame(run);
  }

  function showNext() {
    const result = queue.shift();
    if (!result) return;
    const { root, amount } = plateElement(result);
    shown = root;
    host.append(root);
    status.textContent = result.announcement;
    if (reducedMotion()) amount.textContent = result.amountText;
    else countUp(amount, result, performance.now());
    timer = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      root.remove();
      shown = null;
      status.textContent = "";
      showNext();
    }, PLATE_MS);
  }

  const unsubscribe = onOwnRounds(debateId, (rounds) => {
    const next = revealedTurnResults(seen, rounds);
    seen = next.seen;
    if (!next.results.length) return;
    queue.push(...next.results);
    if (!shown) showNext();
  });

  return () => {
    unsubscribe();
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    queue.length = 0;
    shown?.remove();
    shown = null;
    status.remove();
  };
}
