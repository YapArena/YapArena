// The 30 Pixel Yappers people choose from (founder, 2026-11-02; Decision 0014).
// Browser-safe: the server validates choices with it and the picker lists it.
// The files are public/avatars/<id>.svg.

export const AVATARS = [
  ["yap-blob", "Blob"],
  ["yap-cyclops", "Cyclops"],
  ["yap-critter", "Critter"],
  ["yap-spike", "Spike"],
  ["yap-drift", "Drift"],
  ["yap-bunny", "Bunny"],
  ["yap-bear", "Bear"],
  ["yap-frog", "Frog"],
  ["yap-octo", "Octo"],
  ["yap-mushroom", "Mushroom"],
  ["yap-sprout", "Sprout"],
  ["yap-flame", "Flame"],
  ["yap-spout", "Spout"],
  ["yap-antlers", "Antlers"],
  ["yap-owl", "Owl"],
  ["yap-crab", "Crab"],
  ["yap-cactus", "Cactus"],
  ["yap-bug", "Bug"],
  ["yap-sleepy", "Sleepy"],
  ["yap-pear", "Pear"],
  ["yap-hatchling", "Hatchling"],
  ["yap-star", "Star"],
  ["yap-gem", "Gem"],
  ["yap-bat", "Bat"],
  ["yap-koala", "Koala"],
  ["yap-chomp", "Chomp"],
  ["yap-ring", "Ring"],
  ["yap-axolotl", "Axolotl"],
  ["yap-saturn", "Saturn"],
  ["yap-slime", "Slime"],
] as const;

export type AvatarId = (typeof AVATARS)[number][0];

export const AVATAR_IDS: readonly AvatarId[] = AVATARS.map(([id]) => id);

const names = new Map<string, string>(AVATARS);

// Matches the database's format check on public_profiles.avatar_id.
export const avatarIdPattern = /^yap-[a-z]+(?:-[a-z]+)*$/;

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && names.has(value);
}

export const avatarName = (id: AvatarId) => names.get(id)!;

// Defaults come from these 30 in this order. Avatars added later go after
// them, so no one's default changes.
const defaultPool: readonly AvatarId[] = Object.freeze(AVATAR_IDS.slice(0, 30));

/** The avatar shown for a handle until its owner picks one. */
export function defaultAvatarId(handle: string): AvatarId {
  // FNV-1a, 32-bit, over the handle's UTF-8 bytes. Handles never change, so
  // neither does the default.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(handle)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return defaultPool[hash % defaultPool.length]!;
}

/** The stored choice when it is one of the set, otherwise the handle's default. */
export function resolveAvatarId(
  stored: string | null | undefined,
  handle: string,
): AvatarId {
  return isAvatarId(stored) ? stored : defaultAvatarId(handle);
}
