import type { Track } from "livekit-client";

type AttachedTrack = Track;
type Observer = (
  node: HTMLMediaElement,
  track: AttachedTrack,
  identity: string,
) => void | (() => void);

export type TrackSide = "A" | "B";

/** A speaker token's side, from its participant metadata `{"side":"A"}`. */
export function sideFromMetadata(metadata: string | undefined) {
  if (!metadata) return null;
  try {
    const value: unknown = JSON.parse(metadata);
    if (
      value &&
      typeof value === "object" &&
      "side" in value &&
      (value.side === "A" || value.side === "B")
    )
      return value.side;
  } catch {
    // Viewers and agents carry no side.
  }
  return null;
}

// Side A's video sits left of side B's, whatever order the tracks arrive in;
// videos without a side follow.
const sideRank = (side: string | null) =>
  side === "A" ? 0 : side === "B" ? 1 : 2;

export function createMediaTracks(
  container: HTMLElement,
  observe: Observer = () => {},
) {
  const attached = new Map<
    AttachedTrack,
    { node: HTMLMediaElement; identity: string; cleanup: void | (() => void) }
  >();

  function detach(track: AttachedTrack) {
    const entry = attached.get(track);
    if (!entry) return;
    entry.cleanup?.();
    track.detach(entry.node);
    entry.node.remove();
    attached.delete(track);
  }

  return {
    attach(
      track: AttachedTrack,
      identity: string,
      side: TrackSide | null = null,
    ) {
      if (
        (track.kind !== "video" && track.kind !== "audio") ||
        attached.has(track)
      )
        return;
      for (const [previous, entry] of attached)
        if (entry.identity === identity && previous.kind === track.kind)
          detach(previous);
      const node = track.attach();
      node.dataset.participant = identity;
      if (side) node.dataset.side = side;
      node.autoplay = true;
      if (track.kind === "video") node.setAttribute("playsinline", "");
      attached.set(track, {
        node,
        identity,
        cleanup: observe(node, track, identity),
      });
      const after =
        track.kind === "video"
          ? [...container.children].find(
              (child) =>
                child.tagName === "VIDEO" &&
                sideRank(child.getAttribute("data-side")) > sideRank(side),
            )
          : undefined;
      if (after) container.insertBefore(node, after);
      else container.append(node);
    },
    detach,
    removeParticipant(identity: string) {
      for (const [track, entry] of attached)
        if (entry.identity === identity) detach(track);
    },
    clear() {
      for (const track of attached.keys()) detach(track);
      container.replaceChildren();
    },
  };
}
