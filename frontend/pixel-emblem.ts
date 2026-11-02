// The landing emblem's tiles, drawn two ways (docs/debate-page-design.md,
// docs/queue-overlay.md):
// - Living mode is the landing's own renderer: bursts of light spread through
//   neighbouring tiles, and the mouse wakes more. The landing page and the
//   queue overlay's waiting screen run it.
// - Countdown mode draws each tile lit, spent, glowing or at rest on one
//   canvas, with no element per tile. The debate page's turn clock and the
//   queue overlay's match countdown run it.
// Both find the tiles in the emblem image itself, once per page, with the
// landing's own detection (frontend/pixel-life.ts).
import {
  POINTER_SETTINGS,
  PixelLife,
  SETTINGS,
  type PlannedEvent,
  type Tile,
  type TileGraph,
} from "./pixel-life.js";
import { HOLE, tileAngle, type TileLook } from "./turn-clock-logic.js";

interface Detection {
  tiles: Tile[];
  width: number;
  height: number;
}

let detection: Promise<Detection> | null = null;
/** The emblem's tiles in image pixels, detected once per page. */
function detectEmblem(image: HTMLImageElement) {
  detection ??= (async () => {
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const source = document.createElement("canvas");
    source.width = width;
    source.height = height;
    const context = source.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height);
    source.width = 0;
    source.height = 0;
    return {
      tiles: PixelLife.detectTiles(pixels.data, width, height),
      width,
      height,
    };
  })();
  return detection;
}

/** A tile as fractions of the emblem box, and its clockwise angle. */
export interface EmblemTile {
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
}

let found: Promise<EmblemTile[]> | null = null;
/** The emblem's tiles, detected once per page from its image. */
export function emblemTiles(src: string) {
  found ??= (async () => {
    const image = new Image();
    image.src = src;
    const { tiles, width, height } = await detectEmblem(image);
    return tiles.map((tile) => ({
      left: tile.left / width,
      top: tile.top / height,
      width: tile.width / width,
      height: tile.height / height,
      angle: tileAngle(tile.x, tile.y, {
        x: HOLE.x * width,
        y: HOLE.y * height,
      }),
    }));
  })();
  return found;
}

export interface EmblemColors {
  lit: string;
  warn: string;
  ember: string;
  spent: string;
  rest: string;
}

/**
 * Countdown mode. With `glow` canvases, each draw also copies the lit,
 * coral and ember tiles onto them, for the page to blur behind the ring
 * (the queue overlay); without them the ring stays flat (the debate page).
 */
export function createEmblem(
  stage: HTMLCanvasElement,
  {
    tiles,
    glow = [],
  }: {
    mode: "countdown";
    tiles: readonly EmblemTile[];
    glow?: readonly HTMLCanvasElement[];
  },
) {
  const context = stage.getContext("2d")!;
  const glowContexts = glow.map((canvas) => canvas.getContext("2d")!);
  let width = 0;
  let height = 0;
  function resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = Math.round(stage.clientWidth * ratio);
    height = Math.round(stage.clientHeight * ratio);
    if (stage.width !== width || stage.height !== height) {
      stage.width = width;
      stage.height = height;
      for (const canvas of glow) {
        canvas.width = width;
        canvas.height = height;
      }
      return true;
    }
    return false;
  }
  function fill(
    target: CanvasRenderingContext2D,
    tile: EmblemTile,
    color: string,
    opacity: number,
  ) {
    target.globalAlpha = opacity;
    target.fillStyle = color;
    const left = Math.round(tile.left * width);
    const top = Math.round(tile.top * height);
    target.fillRect(
      left,
      top,
      Math.max(1, Math.round((tile.left + tile.width) * width) - left),
      Math.max(1, Math.round((tile.top + tile.height) * height) - top),
    );
  }
  resize();
  return {
    resize,
    /** Draws every tile with its look. */
    draw(look: (tile: EmblemTile) => TileLook, colors: EmblemColors) {
      context.clearRect(0, 0, width, height);
      const [source, ...copies] = glowContexts;
      source?.clearRect(0, 0, width, height);
      for (const tile of tiles) {
        const { kind, opacity } = look(tile);
        const color = colors[kind === "lit" ? "lit" : kind];
        fill(context, tile, color, opacity);
        if (source && kind !== "spent" && kind !== "rest")
          fill(source, tile, color, opacity);
      }
      context.globalAlpha = 1;
      // A hidden canvas measures 0×0, and an empty canvas can't be copied.
      if (!source || !width || !height) return;
      source.globalAlpha = 1;
      for (const copy of copies) {
        copy.clearRect(0, 0, width, height);
        copy.drawImage(source.canvas, 0, 0);
      }
    },
  };
}

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

export interface LivingParts {
  logo: HTMLImageElement;
  cores: HTMLCanvasElement;
  bloom: HTMLCanvasElement;
  aura: HTMLCanvasElement;
}

/**
 * Living mode, the landing's renderer (moved here unchanged from
 * frontend/landing.ts). It runs while the page is visible, motion is allowed,
 * it isn't paused and, for the queue overlay, it is active.
 */
export function createLivingEmblem(
  stage: HTMLElement,
  { logo, cores, bloom, aura }: LivingParts,
) {
  const coreContext = cores.getContext("2d")!;
  const bloomContext = bloom.getContext("2d")!;
  const auraContext = aura.getContext("2d")!;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mask = document.createElement("canvas");
  const maskContext = mask.getContext("2d")!;
  let graph: TileGraph, scaleX: number, scaleY: number;
  let ready = false,
    paused = false,
    active = true,
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
  const allowed = () =>
    ready && active && !paused && !motion.matches && !document.hidden;

  function updateActivityCounts() {
    stage.dataset.activeBursts = String(activeEvents.length);
    stage.dataset.pointerBursts = String(
      activeEvents.filter(({ lane }) => lane === null).length,
    );
    stage.dataset.pointerFullBursts = String(
      activeEvents.filter(({ lane, feedback }) => lane === null && !feedback)
        .length,
    );
    stage.dataset.pointerFeedback = String(
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
    for (const canvas of [cores, bloom, aura]) canvas.style.opacity = "0";
  }

  function draw(now: number) {
    const w = cores.width,
      h = cores.height;
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
    bloomContext.drawImage(cores, 0, 0);
    auraContext.clearRect(0, 0, w, h);
    auraContext.drawImage(cores, 0, 0);
    cores.style.opacity = String(SETTINGS.coreOpacity);
    bloom.style.opacity = String(SETTINGS.bloomOpacity);
    aura.style.opacity = String(SETTINGS.auraOpacity);
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
    const rect = logo.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((movement.to.x - rect.left) * logo.naturalWidth) / rect.width;
    const y = ((movement.to.y - rect.top) * logo.naturalHeight) / rect.height;
    if (x < 0 || y < 0 || x >= logo.naturalWidth || y >= logo.naturalHeight) {
      resetPointerPosition();
      return;
    }
    const from =
      now - movement.from.at <= POINTER_SETTINGS.maxInputAgeMs
        ? movement.from
        : movement.to;
    const fromX = ((from.x - rect.left) * logo.naturalWidth) / rect.width;
    const fromY = ((from.y - rect.top) * logo.naturalHeight) / rect.height;
    const tolerance = Math.min(
      (POINTER_SETTINGS.hitTolerancePx * logo.naturalWidth) / rect.width,
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
      for (const canvas of [cores, bloom, aura]) canvas.style.opacity = "0";
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

  async function initialize() {
    try {
      graph = PixelLife.buildGraph((await detectEmblem(logo)).tiles);
      // Render at twice the maximum desktop CSS size, keeping edges crisp.
      const width = Math.min(1024, logo.naturalWidth);
      const height = Math.round(
        (width * logo.naturalHeight) / logo.naturalWidth,
      );
      for (const canvas of [cores, bloom, aura, mask]) {
        canvas.width = width;
        canvas.height = height;
      }
      maskContext.drawImage(logo, 0, 0, width, height);
      scaleX = width / logo.naturalWidth;
      scaleY = height / logo.naturalHeight;
      stage.dataset.tiles = String(graph.tiles.length);
      stage.dataset.ready = "true";
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

  return {
    /** Space on the landing and the queue overlay pauses the bursts. */
    setPaused(value: boolean) {
      paused = value;
      resume();
    },
    /** The queue overlay runs the bursts only while its waiting screen shows. */
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      resume();
    },
  };
}
