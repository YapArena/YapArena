// Decision 0016 (engineering notes, "Replays"): the page LiveKit room-composite
// egress opens in headless Chrome and records. Side A's camera fills the left
// half and side B's the right half, edge to edge with `object-fit: cover`,
// for the whole recording; a half with no camera is black. Every speaker's
// sound plays from its own audio element, as on LiveKit's own page.
//
// Egress passes `url`, `token` and `layout` in the query string, starts
// recording on the console message START_RECORDING and stops on
// END_RECORDING (the contract of LiveKit's @livekit/egress-sdk, reproduced
// here without the dependency). The server page is
// src/features/media/recording-template.ts.
import {
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import {
  SIDES,
  assignSides,
  hasDecodedFrame,
  shouldStartRecording,
  templateParams,
  type Side,
} from "./recording-template-model.js";

const START_RECORDING = "START_RECORDING";
const END_RECORDING = "END_RECORDING";

/** Egress reads the first `div.error` as the reason the page failed. */
function fail(message: string) {
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  document.body.append(box);
}

/** A participant's camera while it is subscribed and on. */
function cameraOf(participant: RemoteParticipant) {
  for (const publication of participant.videoTrackPublications.values())
    if (
      publication.source === Track.Source.Camera &&
      publication.isSubscribed &&
      !publication.isMuted &&
      publication.track instanceof RemoteVideoTrack
    )
      return publication.track;
  return undefined;
}

interface Slot {
  element: HTMLVideoElement;
  track: RemoteVideoTrack | undefined;
}

async function record(url: string, token: string) {
  const slots = new Map<Side, Slot>();
  for (const side of SIDES) {
    const element = document.querySelector<HTMLVideoElement>(
      `[data-recording-side="${side}"] video`,
    );
    if (element) slots.set(side, { element, track: undefined });
  }
  const audioBox = document.querySelector<HTMLElement>(
    "[data-recording-audio]",
  );
  const sounds = new Map<RemoteTrack, HTMLMediaElement>();
  // The recorder takes every camera at full quality; nothing it shows is
  // small enough for adaptive streams to save anything.
  const room = new Room({ adaptiveStream: false, dynacast: false });

  function render() {
    const seats = assignSides(
      [...room.remoteParticipants.values()].map((participant) => ({
        identity: participant.identity,
        metadata: participant.metadata,
        joinedAt: participant.joinedAt?.getTime() ?? 0,
        camera: Boolean(cameraOf(participant)),
      })),
    );
    for (const [side, slot] of slots) {
      const identity = seats[side];
      const participant = identity
        ? room.remoteParticipants.get(identity)
        : undefined;
      const track = participant ? cameraOf(participant) : undefined;
      if (slot.track !== track) {
        slot.track?.detach(slot.element);
        track?.attach(slot.element);
        slot.track = track;
      }
      slot.element.hidden = !track;
    }
  }

  function hear(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio || sounds.has(track)) return;
    const element = track.attach();
    audioBox?.append(element);
    sounds.set(track, element);
  }

  function silence(track: RemoteTrack) {
    const element = sounds.get(track);
    if (!element) return;
    track.detach(element);
    element.remove();
    sounds.delete(track);
  }

  room
    .on(RoomEvent.TrackSubscribed, (track) => {
      hear(track);
      render();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      silence(track);
      render();
    })
    .on(RoomEvent.TrackMuted, render)
    .on(RoomEvent.TrackUnmuted, render)
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, render)
    .on(RoomEvent.ParticipantMetadataChanged, render)
    .on(RoomEvent.Reconnected, render)
    .on(RoomEvent.Disconnected, () => console.log(END_RECORDING));

  try {
    await room.connect(url, token);
  } catch (error) {
    fail(error instanceof Error ? error.message : "could not join the room");
    return;
  }
  render();
  startWhenReady(room);
}

async function probe(room: Room, elapsedMs: number) {
  let hasVideoTracks = false;
  let hasSubscribedTracks = false;
  let hasDecodedFrames = false;
  for (const participant of room.remoteParticipants.values())
    for (const publication of participant.trackPublications.values()) {
      if (publication.isSubscribed) hasSubscribedTracks = true;
      if (publication.kind !== Track.Kind.Video) continue;
      hasVideoTracks = true;
      const report = await publication.videoTrack?.getRTCStatsReport();
      if (report && [...report.values()].some(hasDecodedFrame))
        hasDecodedFrames = true;
    }
  return shouldStartRecording({
    elapsedMs,
    hasVideoTracks,
    hasSubscribedTracks,
    hasDecodedFrames,
  });
}

// Like LiveKit's page, checks every 100 ms and starts once.
function startWhenReady(room: Room) {
  const started = Date.now();
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void probe(room, Date.now() - started)
      .then((ready) => {
        if (!ready) return;
        clearInterval(timer);
        console.log(START_RECORDING);
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 100);
}

const params = templateParams(location.search);
if ("error" in params) fail(params.error);
else void record(params.url, params.token);
