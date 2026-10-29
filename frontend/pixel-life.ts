// The landing page's living emblem: pure geometry and event planning, kept
// apart from rendering so it runs (and is tested) without a DOM. Ported
// unchanged from the supplied yaparena-source.zip animation.

export type Range = readonly [number, number];

export interface PixelSettings {
  restOpacity: number;
  concurrentBursts: number;
  overlapStagger: Range;
  eventWindow: Range;
  pause: Range;
  quietTime: number;
  epicenterNeighbors: Range;
  epicenterDelay: Range;
  epicenterBoost: number;
  epicenterLuminosity: number;
  clusterSize: Range;
  radiusInTiles: Range;
  maxHops: Range;
  longPaths: number;
  sideBranchHops: Range;
  propagationDelay: Range;
  handoffProgress: number;
  hesitationChance: number;
  hesitationDelay: Range;
  branchStopChance: number;
  secondBranchChance: number;
  thirdBranchChance: number;
  energyRetention: Range;
  ignition: Range;
  hold: Range;
  fade: Range;
  surgeChance: number;
  hueVariation: number;
  coreOpacity: number;
  bloomOpacity: number;
  auraOpacity: number;
}

// Times are milliseconds.
export const SETTINGS: PixelSettings = {
  restOpacity: 0.13,
  concurrentBursts: 3, // Independent bursts can overlap without replacing one another.
  overlapStagger: [350, 650], // Stagger the initial epicenters, then each runs independently.
  eventWindow: [3500, 5000], // Enough room for long paths and complete individual fades.
  pause: [20, 80], // Short random gap before each independent burst restarts.
  quietTime: 180, // Headroom within each burst's planning window.
  epicenterNeighbors: [4, 6], // A larger core of immediately adjacent tiles.
  epicenterDelay: [25, 70], // The core gathers quickly, then branching proceeds normally.
  epicenterBoost: 1.45,
  epicenterLuminosity: 84,
  clusterSize: [28, 50], // Maximum number of tiles reached by each event.
  radiusInTiles: [6, 9], // Longer reach, still local to one epicenter.
  maxHops: [9, 15],
  longPaths: 2, // A few continuing trails; other branches end sooner.
  sideBranchHops: [2, 4],
  propagationDelay: [20, 65],
  handoffProgress: 0.38, // Pass the signal during the rising glow for fluid motion.
  hesitationChance: 0.15,
  hesitationDelay: [25, 75],
  branchStopChance: 0.13,
  secondBranchChance: 0.18,
  thirdBranchChance: 0,
  energyRetention: [0.93, 0.98],
  ignition: [100, 175],
  hold: [25, 80],
  fade: [470, 900],
  surgeChance: 0.24,
  hueVariation: 9,
  coreOpacity: 1,
  bloomOpacity: 0.82,
  auraOpacity: 0.95,
};

// Mouse input only; the automatic animation settings above stay independent.
export const POINTER_SETTINGS = {
  throttleMs: 32,
  tileCooldownMs: 300,
  ignitionMs: 32, // Only the touched pixel's rise; its original fade timing stays intact.
  hitTolerancePx: 1.5, // CSS pixels, additionally capped relative to tile size.
  maxSamplesPerFrame: 8, // Bounded sampling of the newest movement, current position first.
  maxInputAgeMs: 80, // Discard stale input rather than playing it back later.
} as const;

export interface Tile {
  id: number;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
}

export interface Edge {
  id: number;
  diagonal: boolean;
}

export interface TileGraph {
  tiles: Tile[];
  neighbors: Edge[][];
  pitchX: number;
  pitchY: number;
}

export interface PlannedNode {
  id: number;
  parent: number | null;
  onset: number;
  energy: number;
  depth: number;
  attack: number;
  hold: number;
  decay: number;
  longPath: boolean;
  pathLimit: number;
  epicenter: boolean;
  visualBoost: number;
  end: number;
  hue: number;
  brightness: number;
  surge: number;
  surgeAt: number;
}

export interface PlannedEvent {
  root: number;
  hue: number;
  interval: number;
  radius: number;
  nodes: PlannedNode[];
  duration: number;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);
const integer = (min: number, max: number) => Math.floor(random(min, max + 1));
const pick = (range: Range) => random(range[0], range[1]);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
// An empty list has no median; NaN keeps the source's arithmetic on undefined.
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

function detectTiles(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Tile[] {
  // Flood-fill each actual opaque tile in the original image.
  const count = width * height;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  const tiles: Tile[] = [];
  const solid = (i: number) => data[i * 4 + 3]! >= 160 && data[i * 4]! >= 160;
  for (let seed = 0; seed < count; seed++) {
    if (visited[seed] || !solid(seed)) continue;
    let head = 0,
      tail = 1,
      area = 0;
    let left = width,
      right = 0,
      top = height,
      bottom = 0;
    queue[0] = seed;
    visited[seed] = 1;
    const visit = (index: number) => {
      if (!visited[index] && solid(index)) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width,
        y = Math.floor(index / width);
      area++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y < height - 1) visit(index + width);
    }
    if (area < 20) continue;
    tiles.push({
      id: tiles.length,
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
      area,
    });
  }
  return tiles;
}

function buildGraph(tiles: Tile[]): TileGraph {
  // Infer the grid spacing from the image instead of imposing a new grid.
  const tileWidth = median(tiles.map((t) => t.width));
  const tileHeight = median(tiles.map((t) => t.height));
  const horizontal: number[] = [],
    vertical: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const dx = Math.abs(tiles[i]!.x - tiles[j]!.x);
      const dy = Math.abs(tiles[i]!.y - tiles[j]!.y);
      if (
        dy < tileHeight * 0.25 &&
        dx > tileWidth * 0.8 &&
        dx < tileWidth * 1.65
      )
        horizontal.push(dx);
      if (
        dx < tileWidth * 0.25 &&
        dy > tileHeight * 0.8 &&
        dy < tileHeight * 1.65
      )
        vertical.push(dy);
    }
  }
  const pitchX = horizontal.length ? median(horizontal) : tileWidth * 1.2;
  const pitchY = vertical.length ? median(vertical) : tileHeight * 1.2;
  const neighbors: Edge[][] = tiles.map(() => []);
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const dx = Math.abs(tiles[i]!.x - tiles[j]!.x) / pitchX;
      const dy = Math.abs(tiles[i]!.y - tiles[j]!.y) / pitchY;
      const sameX = dx < 0.18,
        sameY = dy < 0.18;
      const nextX = dx > 0.82 && dx < 1.18,
        nextY = dy > 0.82 && dy < 1.18;
      // Only immediate side/corner neighbors. Never skip a missing tile.
      if ((sameX && nextY) || (sameY && nextX) || (nextX && nextY)) {
        const diagonal = nextX && nextY;
        neighbors[i]!.push({ id: j, diagonal });
        neighbors[j]!.push({ id: i, diagonal });
      }
    }
  }
  return { tiles, neighbors, pitchX, pitchY };
}

function hitTest(
  graph: TileGraph,
  x: number,
  y: number,
  tolerance = 0,
): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let closest: number | null = null,
    bestDistance = Infinity;
  for (const tile of graph.tiles) {
    const dx = Math.max(tile.left - x, 0, x - (tile.left + tile.width));
    const dy = Math.max(tile.top - y, 0, y - (tile.top + tile.height));
    const distance = Math.hypot(dx, dy);
    if (distance <= tolerance && distance < bestDistance) {
      closest = tile.id;
      bestDistance = distance;
    }
  }
  return closest;
}

function planEvent(
  graph: TileGraph,
  settings: PixelSettings = SETTINGS,
  epicenterId: number | null = null,
): PlannedEvent {
  const { tiles, neighbors, pitchX, pitchY } = graph;
  const root = epicenterId ?? integer(0, tiles.length - 1);
  const origin = tiles[root]!;
  const deadline = pick(settings.eventWindow) - settings.quietTime;
  const radius = pick(settings.radiusInTiles);
  const maxCount = integer(...settings.clusterSize);
  const maxHops = integer(...settings.maxHops);
  const speed = random(0.82, 1.18);
  const hue = random(0, 360);
  const nodes: PlannedNode[] = [],
    frontier: PlannedNode[] = [],
    used = new Set<number>();

  function activate(
    id: number,
    parent: number | null,
    onset: number,
    energy: number,
    depth: number,
    longPath = false,
    pathLimit = maxHops,
  ) {
    const attack = pick(settings.ignition) * speed;
    const hold = pick(settings.hold);
    const decay = pick(settings.fade) * speed;
    if (onset + attack + hold + decay > deadline) return null;
    const node: PlannedNode = {
      id,
      parent,
      onset,
      energy,
      depth,
      attack,
      hold,
      decay,
      longPath,
      pathLimit,
      epicenter: depth <= 1,
      visualBoost: depth <= 1 ? settings.epicenterBoost : 1,
      end: onset + attack + hold + decay,
      hue: hue + random(-settings.hueVariation, settings.hueVariation),
      brightness: random(0.9, 1.08),
      surge: Math.random() < settings.surgeChance ? random(0.22, 0.42) : 0,
      surgeAt: random(0.28, 0.52),
    };
    used.add(id);
    nodes.push(node);
    frontier.push(node);
    return node;
  }
  activate(root, null, 0, 1, 0);

  while (frontier.length && nodes.length < maxCount) {
    frontier.sort((a, b) => a.onset - b.onset);
    const parent = frontier.shift()!;
    if (parent.depth >= parent.pathLimit) continue;
    const source = tiles[parent.id]!;
    const distance = Math.hypot(
      (source.x - origin.x) / pitchX,
      (source.y - origin.y) / pitchY,
    );
    // Keep the main trails alive until they have explored well beyond the core.
    const canStop =
      !parent.longPath || (parent.depth >= 8 && distance > radius * 0.75);
    if (
      parent.depth > 1 &&
      canStop &&
      Math.random() < settings.branchStopChance
    )
      continue;
    const candidates = neighbors[parent.id]!.filter((edge) => {
      if (used.has(edge.id)) return false;
      const tile = tiles[edge.id]!;
      return (
        Math.hypot(
          (tile.x - origin.x) / pitchX,
          (tile.y - origin.y) / pitchY,
        ) <= radius
      );
    })
      .map((edge) => {
        const tile = tiles[edge.id]!;
        const outward =
          Math.hypot(tile.x - origin.x, tile.y - origin.y) >=
          Math.hypot(source.x - origin.x, source.y - origin.y);
        let alignment = 0;
        if (parent.parent !== null) {
          const previous = tiles[parent.parent]!;
          const ax = source.x - previous.x,
            ay = source.y - previous.y;
          const bx = tile.x - source.x,
            by = tile.y - source.y;
          alignment =
            (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
        }
        const crowding = neighbors[edge.id]!.filter(
          (n) => n.id !== parent.id && used.has(n.id),
        ).length;
        // Momentum with random turns creates narrow trails instead of a filled patch.
        const weight =
          (edge.diagonal ? 0.72 : 1) *
          (outward ? 1.65 : 0.65) *
          Math.exp(alignment * 1.15) *
          0.67 ** crowding;
        return { ...edge, priority: Math.random() ** (1 / weight) };
      })
      .sort((a, b) => b.priority - a.priority);

    let count =
      parent.depth === 0 ? integer(...settings.epicenterNeighbors) : 1;
    if (parent.depth > 0 && Math.random() < settings.secondBranchChance)
      count++;
    if (parent.depth > 0 && Math.random() < settings.thirdBranchChance) count++;
    count = Math.min(count, candidates.length, maxCount - nodes.length);
    for (const [branchIndex, edge] of candidates.slice(0, count).entries()) {
      let delay =
        pick(
          parent.depth === 0
            ? settings.epicenterDelay
            : settings.propagationDelay,
        ) * speed;
      if (parent.depth > 0 && Math.random() < settings.hesitationChance)
        delay += pick(settings.hesitationDelay);
      // A child lights only once its parent has visibly ignited.
      const handoff = parent.depth === 0 ? 0.65 : settings.handoffProgress;
      const onset = parent.onset + parent.attack * handoff + delay;
      const energy = parent.energy * pick(settings.energyRetention);
      const longPath =
        parent.depth === 0
          ? branchIndex < settings.longPaths
          : parent.longPath && branchIndex === 0;
      const pathLimit = longPath
        ? maxHops
        : branchIndex === 0 && parent.depth > 0
          ? parent.pathLimit
          : Math.min(
              maxHops,
              parent.depth + 1 + integer(...settings.sideBranchHops),
            );
      activate(
        edge.id,
        parent.id,
        onset,
        energy,
        parent.depth + 1,
        longPath,
        pathLimit,
      );
    }
  }
  const duration = Math.max(...nodes.map((n) => n.end));
  return {
    root,
    hue,
    interval: duration + pick(settings.pause),
    radius,
    nodes,
    duration,
  };
}

function brightnessAt(
  node: PlannedNode,
  elapsed: number,
  ignition = node.attack,
) {
  const age = elapsed - node.onset;
  if (age <= 0 || elapsed >= node.end) return 0;
  let intensity;
  if (age < node.attack) intensity = smooth(age / ignition);
  else if (age < node.attack + node.hold) intensity = 1;
  else {
    const t = (age - node.attack - node.hold) / node.decay;
    // A fast initial release and a long, smooth afterglow.
    intensity = (1 - smooth(t)) ** 1.65;
    const swell = Math.exp(-0.5 * ((t - node.surgeAt) / 0.085) ** 2);
    intensity += node.surge * swell * Math.sin(Math.PI * t) ** 2;
  }
  return clamp(intensity * node.energy * node.brightness * node.visualBoost);
}

export const PixelLife = {
  detectTiles,
  buildGraph,
  hitTest,
  planEvent,
  brightnessAt,
  random,
};
