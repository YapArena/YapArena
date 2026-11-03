import { randomUUID } from "node:crypto";
import type { AvatarId } from "../identity/avatars.ts";

// Deploys on Render pin the revision to the commit. Elsewhere each process
// picks a random revision, so a restart never reuses a cached asset URL.
export const assetRevision = /^[0-9a-f]{40}$/i.test(
  process.env.RENDER_GIT_COMMIT ?? "",
)
  ? process.env.RENDER_GIT_COMMIT!.slice(0, 12)
  : randomUUID().replaceAll("-", "").slice(0, 12);
export const asset = (name: string) => `/assets/${name}?v=${assetRevision}`;
export const avatarAsset = (id: AvatarId) => asset(`avatars/${id}.svg`);
// Browser code puts an avatar id in place of {id} (frontend/avatar-picker.ts).
export const avatarTemplate = asset("avatars/{id}.svg");
