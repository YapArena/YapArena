// A person's avatar slot on server-rendered pages (Decision 0014). Without a
// person, for example a debate still waiting for its speaker, the slot shows
// "?" as before.
import type { AvatarId } from "../identity/avatars.ts";
import { avatarAsset } from "./assets.ts";
import { avatarSlot } from "./kit-web.ts";

export const personSlot = (
  person: { displayName: string; avatarId: AvatarId } | null | undefined,
  size?: number,
) =>
  avatarSlot(
    person?.displayName,
    size,
    person ? avatarAsset(person.avatarId) : undefined,
  );
