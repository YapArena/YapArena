// The landing page at /: renders the living emblem and sends signed-in readers
// to /home. The renderer is ported from the supplied yaparena-source.zip
// animation; see docs/landing-page.md for the two intentional differences.
import {
  POINTER_SETTINGS,
  PixelLife,
  SETTINGS,
  type PlannedEvent,
  type TileGraph,
} from "./pixel-life.js";
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

interface ActiveEvent {
  lane: number | null;
  feedback?: boolean;
  event: PlannedEvent;
  started: number;
}

interface PointerSample {
  x: number;
  y: number;
  at: number;
}

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

function startEmblem() {
  const logo = document.querySelector<HTMLImageElement>("#pixel-logo");
  const stage = document.querySelector<HTMLElement>("[data-pixel-logo]");
  const cores = document.querySelector<HTMLCanvasElement>(".pixel-logo .cores");
  const bloom = document.querySelector<HTMLCanvasElement>(".pixel-logo .bloom");
  const aura = document.querySelector<HTMLCanvasElement>(".pixel-logo .aura");
  if (!logo || !stage || !cores || !bloom || !aura) return;
  const coreContext = cores.getContext("2d")!;
  const bloomContext = bloom.getContext("2d")!;
  const auraContext = aura.getContext("2d")!;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mask = document.createElement("canvas");
  const maskContext = mask.getContext("2d")!;
  let graph: TileGraph, scaleX: number, scaleY: number;
  let ready = false,
    paused = false,
    frame: number | null = null;
  let activeEvents: ActiveEvent[] = [];
  const timers: (number | null)[] = new Array<number | null>(
    SETTINGS.concurrentBursts,
  ).fill(null);
  const pointerCooldowns = new Map<number, number>();
  const pointerFeedbackSettings = {
    ...SETTINGS,
    clusterSize: [1, 1] as const,
  };
  let lastPointerPosition: PointerSample | null = null,
    pendingPointer: { from: PointerSample; to: PointerSample } | null = null,
    lastPointerStarted = -Infinity;
  const allowed = () => ready && !paused && !motion.matches && !document.hidden;
  document.documentElement.style.setProperty(
    "--rest-opacity",
    String(SETTINGS.restOpacity),
  );

  function updateActivityCounts() {
    stage!.dataset.activeBursts = String(activeEvents.length);
    stage!.dataset.pointerBursts = String(
      activeEvents.filter(({ lane }) => lane === null).length,
    );
    stage!.dataset.pointerFullBursts = String(
      activeEvents.filter(({ lane, feedback }) => lane === null && !feedback)
        .length,
    );
    stage!.dataset.pointerFeedback = String(
      activeEvents.filter(({ feedback }) => feedback).length,
    );
  }

  function resetPointerPosition() {
    lastPointerPosition = null;
    pendingPointer = null;
  }

  function stop() {
    for (const timer of timers) if (timer !== null) clearTimeout(timer);
    timers.fill(null);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    activeEvents = [];
    updateActivityCounts();
    resetPointerPosition();
    pointerCooldowns.clear();
    lastPointerStarted = -Infinity;
    for (const canvas of [cores!, bloom!, aura!]) canvas.style.opacity = "0";
  }

  function draw(now: number) {
    const w = cores!.width,
      h = cores!.height;
    coreContext.clearRect(0, 0, w, h);
    coreContext.save();
    coreContext.scale(scaleX, scaleY);
    // Composite all active bursts in one frame; intersecting colors blend as light.
    coreContext.globalCompositeOperation = "screen";
    for (const { event, started, lane } of activeEvents) {
      const elapsed = now - started;
      for (const node of event.nodes) {
        // Faster mouse feedback affects only the root's rise, never propagation or fades.
        const ignition =
          lane === null && node.id === event.root
            ? Math.min(node.attack, POINTER_SETTINGS.ignitionMs)
            : node.attack;
        const brightness = PixelLife.brightnessAt(node, elapsed, ignition);
        if (brightness < 0.001) continue;
        const tile = graph.tiles[node.id]!;
        // Every tile keeps its original color, activation time, peak and fade.
        const peak = node.epicenter ? SETTINGS.epicenterLuminosity : 73;
        coreContext.fillStyle = `hsla(${node.hue}, 100%, ${56 + brightness * (peak - 56)}%, ${brightness})`;
        coreContext.fillRect(
          tile.left - 1,
          tile.top - 1,
          tile.width + 2,
          tile.height + 2,
        );
      }
    }
    coreContext.restore();
    // Clip to the exact original alpha, preserving tile edges and empty spaces.
    coreContext.globalCompositeOperation = "destination-in";
    coreContext.drawImage(mask, 0, 0);
    coreContext.globalCompositeOperation = "source-over";
    bloomContext.clearRect(0, 0, w, h);
    bloomContext.drawImage(cores!, 0, 0);
    auraContext.clearRect(0, 0, w, h);
    auraContext.drawImage(cores!, 0, 0);
    cores!.style.opacity = String(SETTINGS.coreOpacity);
    bloom!.style.opacity = String(SETTINGS.bloomOpacity);
    aura!.style.opacity = String(SETTINGS.auraOpacity);
  }

  function schedule(lane: number, delay: number) {
    if (allowed())
      timers[lane] = window.setTimeout(
        () => startEvent(lane),
        Math.max(0, delay),
      );
  }

  function startEvent(lane: number) {
    timers[lane] = null;
    if (!allowed()) return;
    activeEvents.push({
      lane,
      event: PixelLife.planEvent(graph),
      started: performance.now(),
    });
    updateActivityCounts();
    if (frame === null) frame = requestAnimationFrame(animate);
  }

  function onPointerMove(event: PointerEvent) {
    if (!allowed() || event.pointerType === "touch") return;
    if (
      lastPointerPosition &&
      event.clientX === lastPointerPosition.x &&
      event.clientY === lastPointerPosition.y
    )
      return;
    const position = {
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
    };
    // One fresh segment per frame, never a queue of old mouse events.
    pendingPointer = {
      from: pendingPointer?.from ?? lastPointerPosition ?? position,
      to: position,
    };
    lastPointerPosition = position;
    if (frame === null) frame = requestAnimationFrame(animate);
  }

  function flushPointer() {
    const movement = pendingPointer;
    pendingPointer = null;
    if (!movement || !allowed()) return;
    const now = performance.now();
    if (now - movement.to.at > POINTER_SETTINGS.maxInputAgeMs) {
      resetPointerPosition();
      return;
    }
    const rect = logo!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((movement.to.x - rect.left) * logo!.naturalWidth) / rect.width;
    const y = ((movement.to.y - rect.top) * logo!.naturalHeight) / rect.height;
    if (x < 0 || y < 0 || x >= logo!.naturalWidth || y >= logo!.naturalHeight) {
      resetPointerPosition();
      return;
    }
    const from =
      now - movement.from.at <= POINTER_SETTINGS.maxInputAgeMs
        ? movement.from
        : movement.to;
    const fromX = ((from.x - rect.left) * logo!.naturalWidth) / rect.width;
    const fromY = ((from.y - rect.top) * logo!.naturalHeight) / rect.height;
    const tolerance = Math.min(
      (POINTER_SETTINGS.hitTolerancePx * logo!.naturalWidth) / rect.width,
      Math.min(graph.pitchX, graph.pitchY) * 0.15,
    );
    const steps = Math.min(
      POINTER_SETTINGS.maxSamplesPerFrame,
      Math.max(
        1,
        Math.ceil(
          Math.hypot((x - fromX) / graph.pitchX, (y - fromY) / graph.pitchY),
        ),
      ),
    );
    for (let i = 0; i < steps; i++) {
      const t = 1 - i / steps;
      const tile = PixelLife.hitTest(
        graph,
        fromX + (x - fromX) * t,
        fromY + (y - fromY) * t,
        tolerance,
      );
      if (
        tile === null ||
        now - (pointerCooldowns.get(tile) ?? -Infinity) <
          POINTER_SETTINGS.tileCooldownMs
      )
        continue;
      const feedback = now - lastPointerStarted < POINTER_SETTINGS.throttleMs;
      // Local feedback uses the same root, color, ignition and fade; existing bursts are untouched.
      const plan = PixelLife.planEvent(
        graph,
        feedback ? pointerFeedbackSettings : SETTINGS,
        tile,
      );
      activeEvents.push({
        lane: null,
        feedback,
        event: plan,
        started: movement.to.at,
      });
      pointerCooldowns.set(tile, now);
      if (!feedback) lastPointerStarted = now;
    }
  }
  stage.addEventListener("pointermove", onPointerMove, { passive: true });
  stage.addEventListener("pointerleave", () => {
    // Finish only the just-crossed segment; never bridge a later re-entry.
    flushPointer();
    resetPointerPosition();
    updateActivityCounts();
  });
  stage.addEventListener("pointercancel", resetPointerPosition);

  function animate(now: number) {
    frame = null;
    if (!allowed()) {
      stop();
      return;
    }
    const finished = activeEvents.filter(
      ({ event, started }) => now - started >= event.duration,
    );
    activeEvents = activeEvents.filter(
      ({ event, started }) => now - started < event.duration,
    );
    for (const { lane, event, started } of finished) {
      // Restart only this burst; the others continue their paths and fades.
      if (lane !== null) schedule(lane, event.interval - (now - started));
    }
    flushPointer();
    updateActivityCounts();
    if (activeEvents.length) {
      draw(now);
      frame = requestAnimationFrame(animate);
    } else {
      for (const canvas of [cores!, bloom!, aura!]) canvas.style.opacity = "0";
    }
  }

  function resume() {
    stop();
    let delay = PixelLife.random(250, 650);
    for (let lane = 0; lane < SETTINGS.concurrentBursts; lane++) {
      schedule(lane, delay);
      delay += PixelLife.random(...SETTINGS.overlapStagger);
    }
  }
  document.addEventListener("visibilitychange", resume);
  motion.addEventListener("change", resume);
  onPause((value) => {
    paused = value;
    resume();
  });

  async function initialize() {
    try {
      await logo!.decode();
      const source = document.createElement("canvas");
      source.width = logo!.naturalWidth;
      source.height = logo!.naturalHeight;
      const sourceContext = source.getContext("2d", {
        willReadFrequently: true,
      })!;
      sourceContext.drawImage(logo!, 0, 0);
      const pixels = sourceContext.getImageData(
        0,
        0,
        source.width,
        source.height,
      );
      graph = PixelLife.buildGraph(
        PixelLife.detectTiles(pixels.data, source.width, source.height),
      );
      // Render at twice the maximum desktop CSS size, keeping edges crisp.
      const width = Math.min(1024, logo!.naturalWidth);
      const height = Math.round(
        (width * logo!.naturalHeight) / logo!.naturalWidth,
      );
      for (const canvas of [cores!, bloom!, aura!, mask]) {
        canvas.width = width;
        canvas.height = height;
      }
      maskContext.drawImage(logo!, 0, 0, width, height);
      scaleX = width / logo!.naturalWidth;
      scaleY = height / logo!.naturalHeight;
      source.width = 0;
      source.height = 0;
      stage!.dataset.tiles = String(graph.tiles.length);
      stage!.dataset.ready = "true";
      ready = graph.tiles.length > 0;
      resume();
    } catch (error) {
      console.warn(
        "Pixel animation could not start. The original logo remains visible.",
        error,
      );
    }
  }
  void initialize();
}

startHeadline();
startEmblem();
