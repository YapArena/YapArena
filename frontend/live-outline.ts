import type { Room } from "livekit-client";
import { createCaptions } from "./live-captions.js";

// Decision 0012: the debate page's live captions (and, later, the AI outline)
// follow the page's LiveKit Room. media-entry.ts loads this module as a split
// chunk only when the page has these containers, and hands it each Room it
// connects.
export function startLiveOutline(debateId: string) {
  void debateId;
  const captions = createCaptions();
  return (room: Room) => {
    captions?.attach(room);
  };
}
