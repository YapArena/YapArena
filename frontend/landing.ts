// The landing page at /: renders the living emblem and sends signed-in readers
// to /home. The renderer is ported from the supplied yaparena-source.zip
// animation; see docs/landing-page.md for the two intentional differences.
import { SETTINGS } from "./pixel-life.js";
import { createLivingEmblem } from "./pixel-emblem.js";
import { pickHeadlineColors } from "./landing-colors.js";
import {
  FINAL_STEP,
  FLIP_EVERY_MS,
  FLIP_MS,
  NOUN_TRACK,
  PRONOUN_TRACK,
  REVEAL_END_MS,
  canAdvance,
  initialStep,
  nextMove,
  restingPositions,
  type SlotPositions,
} from "./landing-headline.js";

// The session cookie is SameSite=Strict, so a reader arriving from another
// site reaches / as a guest. This same-origin request carries the cookie.
void fetch("/api/auth/me", { credentials: "same-origin" })
  .then((response) => {
    if (response.ok) location.replace("/home");
  })
  .catch(() => {});

// Space pauses and resumes both animations (WCAG 2.2.2: the headline loops
// indefinitely). It must still activate the focused control instead.
const interactive =
  "a[href], button, input, select, textarea, summary, [contenteditable]";
const pauseListeners: ((paused: boolean) => void)[] = [];
let animationsPaused = false;
function onPause(listener: (paused: boolean) => void) {
  pauseListeners.push(listener);
}
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "Space" ||
    event.repeat ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  if (event.target instanceof Element && event.target.closest(interactive))
    return;
  event.preventDefault();
  animationsPaused = !animationsPaused;
  const status = document.querySelector<HTMLElement>("[data-pixel-status]");
  if (status)
    status.textContent = animationsPaused
      ? "Animation paused."
      : "Animation resumed.";
  for (const listener of pauseListeners) listener(animationsPaused);
});

// The rotating headline: each step moves a slot's track up by 1.6em while the
// slot's width follows the incoming word, as on dydema.com.
function startHeadline() {
  const headline = document.querySelector<HTMLElement>("[data-headline]");
  const pronounSlot = document.querySelector<HTMLElement>(
    '[data-flip="pronoun"]',
  );
  const nounSlot = document.querySelector<HTMLElement>('[data-flip="noun"]');
  const initial = headline?.querySelector<HTMLElement>(".headline-y");
  if (!headline || !pronounSlot || !nounSlot || !initial) return;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // A new set of five distinct colors on every visit.
  const colors = pickHeadlineColors();
  const slot = (element: HTMLElement) => {
    const track = element.querySelector<HTMLElement>(".flip-track")!;
    return {
      element,
      track,
      words: [...track.querySelectorAll<HTMLElement>(".flip-word")],
      widths: [] as number[],
      position: 0,
    };
  };
  type Slot = ReturnType<typeof slot>;
  const slots = { pronoun: slot(pronounSlot), noun: slot(nounSlot) };
  let step = 0,
    paused = false,
    timer: number | null = null,
    wrapTimer: number | null = null;

  function place(target: Slot, position: number) {
    target.position = position;
    target.track.style.transform = position
      ? `translateY(${-1.6 * position}em)`
      : "";
    target.element.style.width = `${target.widths[position] ?? 0}px`;
  }
  // Each word keeps its color; the trailing copy of "opinions" matches the
  // first, so the 5→1 reset shows no color jump. "Your" and "matter" stay white.
  function paintWords() {
    slots.noun.words.forEach((element, index) => {
      const word = NOUN_TRACK[index];
      if (word) element.style.color = colors[word].css;
    });
    slots.pronoun.words.forEach((element, index) => {
      if (PRONOUN_TRACK[index] === "appers")
        element.style.color = colors.yappers.css;
    });
  }
  // The "Y" joins "Yappers" in its color and is white for every other phrase.
  function paintInitial() {
    initial!.style.color = step === FINAL_STEP ? colors.yappers.css : "";
  }
  // Apply positions without animating, e.g. after measuring or a loop reset.
  function settle(positions: SlotPositions) {
    headline!.classList.add("flip-instant");
    place(slots.pronoun, positions.pronoun);
    place(slots.noun, positions.noun);
    paintInitial();
    void headline!.offsetWidth;
    headline!.classList.remove("flip-instant");
  }
  // The slot boundary breaks the font's kerning between "Y" and "our" or
  // "appers", so pull each word in by the pair's kerning, measured in the
  // headline's own font and as displayed (the lines are set in capitals).
  function kern() {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const style = getComputedStyle(slots.pronoun.element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const shown = (text: string) =>
      style.textTransform === "uppercase" ? text.toUpperCase() : text;
    const width = (text: string) => context.measureText(shown(text)).width;
    for (const word of slots.pronoun.words) {
      const text = word.textContent ?? "";
      word.style.marginLeft = `${width(`Y${text}`) - width("Y") - width(text)}px`;
    }
  }
  function measure() {
    kern();
    for (const target of [slots.pronoun, slots.noun])
      target.widths = target.words.map(
        (word) =>
          word.getBoundingClientRect().width +
          parseFloat(getComputedStyle(word).marginLeft),
      );
    settle({
      pronoun: slots.pronoun.position,
      noun: slots.noun.position,
    });
  }
  function advance() {
    if (!canAdvance({ hidden: document.hidden, paused })) return;
    const move = nextMove(step);
    if (move.moves.pronoun) place(slots.pronoun, move.positions.pronoun);
    if (move.moves.noun) place(slots.noun, move.positions.noun);
    step = move.to;
    headline!.dataset.step = String(step);
    paintInitial();
    // Landed on the trailing copies: jump back to the identical first items.
    if (move.wraps)
      wrapTimer = window.setTimeout(() => {
        wrapTimer = null;
        settle(restingPositions(step));
      }, FLIP_MS);
  }
  function stop() {
    if (timer !== null) clearTimeout(timer);
    if (wrapTimer !== null) {
      clearTimeout(wrapTimer);
      wrapTimer = null;
      settle(restingPositions(step));
    }
    timer = null;
  }
  function start() {
    stop();
    if (motion.matches) {
      step = initialStep(true);
      headline!.dataset.step = String(step);
      settle(restingPositions(step));
      return;
    }
    // The first flip comes one interval after the headline's reveal ends.
    const tick = () => {
      advance();
      timer = window.setTimeout(tick, FLIP_EVERY_MS);
    };
    timer = window.setTimeout(
      tick,
      Math.max(0, REVEAL_END_MS + FLIP_EVERY_MS - performance.now()),
    );
  }

  headline.dataset.step = String(step);
  paintWords();
  measure();
  void document.fonts.ready.then(measure).catch(() => {});
  // Slot widths and kerning depend on the headline font, so measure again
  // once Dydema Capitals has loaded (it can arrive after fonts.ready).
  void document.fonts
    .load('400 1em "Dydema Capitals"')
    .then(measure)
    .catch(() => {});
  window.addEventListener("resize", measure);
  motion.addEventListener("change", start);
  onPause((value) => {
    paused = value;
  });
  start();
}

// The living emblem: the landing's renderer, shared with the queue overlay
// (frontend/pixel-emblem.ts).
function startEmblem() {
  const logo = document.querySelector<HTMLImageElement>("#pixel-logo");
  const stage = document.querySelector<HTMLElement>("[data-pixel-logo]");
  const cores = document.querySelector<HTMLCanvasElement>(".pixel-logo .cores");
  const bloom = document.querySelector<HTMLCanvasElement>(".pixel-logo .bloom");
  const aura = document.querySelector<HTMLCanvasElement>(".pixel-logo .aura");
  if (!logo || !stage || !cores || !bloom || !aura) return;
  document.documentElement.style.setProperty(
    "--rest-opacity",
    String(SETTINGS.restOpacity),
  );
  const emblem = createLivingEmblem(stage, { logo, cores, bloom, aura });
  onPause((value) => emblem.setPaused(value));
}

startHeadline();
startEmblem();
