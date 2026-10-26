import type { LocalTrackPublication } from "livekit-client";
import type {
  DeviceChoices,
  MediaError,
  MediaKind,
  MediaRequest,
  MediaResponse,
  MediaRole,
  MediaState,
  Side,
} from "./media-types.js";

/* global document, window */
import { createReplayLibraryLoader } from "./media-replay-library.js";
import {
  createPlaybackReporter,
  playbackDimensions,
} from "./media-telemetry.js";
import {
  createMediaRecovery,
  mayRecoverDisconnect,
  isMovingSpeakerAccess,
} from "./media-recovery.js";
import {
  createMediaDiagnostics,
  observePlayback,
} from "./media-diagnostics.js";
import { createReplayPlayer } from "./media-replay.js";
import { Room, RoomEvent, Track } from "livekit-client";
import { mediaPresentation } from "./media-presentation.js";
import { speakerButtonState, stopMediaSession } from "./media-session.js";
import { joinSpeaker } from "./media-speaker.js";
import { createMediaTracks } from "./media-tracks.js";
import {
  createDeadlineFollower,
  createSignalRefresh,
  watchRoom,
} from "./community-stream.js";

const root = document.querySelector<HTMLElement>("[data-media-event]");
if (root) {
  // Application pagehide owns cleanup. SDK beforeunload would report a voluntary
  // leave first and erase the saved speaker intent needed after a page refresh.
  const roomOptions = {
    adaptiveStream: true,
    dynacast: true,
    disconnectOnPageLeave: false,
  };
  // The media page template supplies this event ID and the controls below.
  const id = root.dataset.mediaEvent!;
  // Decision 0012: captions and the AI outline follow this page's Room.
  const liveOutline = document.querySelector("[data-live-captions]")
    ? import("./live-outline.js").then((outline) =>
        outline.startLiveOutline(id),
      )
    : undefined;
  const status = root.querySelector<HTMLElement>("[data-media-status]")!;
  const clock = root.querySelector<HTMLElement>("[data-media-clock]")!;
  const microphoneStatus = root.querySelector<HTMLElement>(
    "[data-media-microphone]",
  )!;
  const videos = root.querySelector<HTMLElement>("[data-media-videos]")!;
  const diagnostics = createMediaDiagnostics();
  window.yapMediaDiagnostics = diagnostics;
  const mediaTracks = createMediaTracks(videos, (node, track, identity) => {
    if (identity === room?.localParticipant.identity) return;
    const observedRoom = room;
    let stability:
      | { epoch: number; start: number; last: number; confirmed: boolean }
      | undefined;
    return observePlayback(node, {
      kind: track.kind as MediaKind,
      diagnostics,
      expected: () =>
        !disposed &&
        !document.hidden &&
        navigator.onLine &&
        room === observedRoom &&
        !track.isMuted &&
        eventStatus === "live",
      onProgress(at) {
        if (track.kind !== "video") return;
        const epoch = recovery.connectionGeneration;
        if (
          !stability ||
          stability.epoch !== epoch ||
          at - stability.last > 3000
        )
          stability = { epoch, start: at, last: at, confirmed: false };
        stability.last = at;
        if (
          !stability.confirmed &&
          at - stability.start >= 10000 &&
          recovery.playbackStable(stability.epoch)
        ) {
          stability.confirmed = true;
          diagnostics.record("recovery_stable", {
            kind: "video",
            windowMs: 10000,
          });
        }
      },
      onInterruption() {
        stability = undefined;
      },
    });
  });
  const viewerButton = root.querySelector<HTMLButtonElement>(
    "[data-media-viewer]",
  )!;
  const speakerButton = root.querySelector<HTMLButtonElement>(
    "[data-media-speaker]",
  )!;
  const replay = root.querySelector<HTMLButtonElement>("[data-media-replay]")!;
  const video = root.querySelector<HTMLVideoElement>(
    "[data-media-replay-video]",
  )!;
  const operator = root.querySelector<HTMLElement>("[data-media-operator]")!;
  let speakerMemoryKey: string | undefined;
  let room: Room | undefined;
  let side: Side | undefined;
  let seatSide: Side | undefined;
  let eventStatus: string | undefined;
  let speakerConnected = false;
  let joiningSpeaker = false;
  let preparedRoom: Room | undefined;
  let preparationComplete = false;
  let preparationStarted = false;
  let viewerJoining = false;
  let microphoneWanted = true;
  let deviceChoices: DeviceChoices = {};
  let disposed = false;
  let cachedIntent: MediaRole | undefined;
  let cachedPage = false;
  let pageGeneration = 0;
  const sound = root.querySelector<HTMLButtonElement>("[data-media-sound]")!;
  const leave = root.querySelector<HTMLButtonElement>("[data-media-leave]")!;
  const mute = root.querySelector<HTMLButtonElement>("[data-media-mute]")!;
  let microphoneChange: Promise<LocalTrackPublication | undefined> | undefined;
  let preparedMicrophone: MediaStreamTrack | undefined;
  let serverOffset = 0;
  let currentState: MediaState | null | undefined;
  let watchSession: { id: string; mode: "live" | "replay" } | undefined;
  let watchStarting = false;
  const activeLiveVideo = () =>
    Array.from(videos.querySelectorAll("video")).some(
      (item) => !item.paused && item.readyState >= 2,
    );
  const watchMode = () => {
    if (disposed || document.hidden || !window.yapMeasurement?.consented)
      return null;
    if (!video.hidden && !video.paused && video.readyState >= 2)
      return "replay";
    if (room && !side && eventStatus === "live" && activeLiveVideo())
      return "live";
    return null;
  };
  function endWatch() {
    const previous = watchSession;
    watchSession = undefined;
    if (previous)
      void window.yapMeasurement?.progressWatch(
        id,
        previous.mode,
        previous.id,
        "end",
      );
  }
  async function tickWatch() {
    const mode = watchMode();
    if (!mode) {
      endWatch();
      return;
    }
    if (watchSession?.mode === mode) {
      void window.yapMeasurement!.progressWatch(id, mode, watchSession.id);
      return;
    }
    if (watchStarting) return;
    endWatch();
    watchStarting = true;
    const sessionId = window.crypto.randomUUID();
    try {
      if (
        (await window.yapMeasurement!.startWatch(id, mode, sessionId)) &&
        watchMode() === mode
      )
        watchSession = { id: sessionId, mode };
    } finally {
      watchStarting = false;
    }
  }
  const say = (message: string) => {
    status.textContent = message;
  };
  const showMicrophoneStatus = (message: string) => {
    microphoneStatus.textContent = message;
    microphoneStatus.hidden = !message;
  };
  // Endpoint types describe existing wire responses without adding validation.
  const request: MediaRequest = async <Path extends string>(
    path: Path,
    options: RequestInit = {},
  ): Promise<MediaResponse<Path>> => {
    const response = await fetch(`/api/media/events/${id}${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const result: unknown = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(
        new Error(
          (result as { error?: string }).error || "Media request failed",
        ),
        {
          status: response.status,
          ...(result !== null &&
          typeof result === "object" &&
          "code" in result &&
          typeof result.code === "string"
            ? { code: result.code }
            : {}),
        },
      );
    return result as MediaResponse<Path>;
  };
  const reporter = createPlaybackReporter({
    send: (reports) =>
      request("/playback", {
        method: "POST",
        body: JSON.stringify({ reports }),
        keepalive: true,
      }),
    dimensions: playbackDimensions(navigator.userAgent),
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (timer) => window.clearTimeout(timer),
  });
  diagnostics.subscribe((row) => reporter.record(row));
  const remembersSpeaker = () => {
    if (!speakerMemoryKey) return false;
    try {
      return window.sessionStorage.getItem(speakerMemoryKey) === "1";
    } catch {
      return false;
    }
  };
  const rememberSpeaker = (remember: boolean) => {
    if (!speakerMemoryKey) return;
    try {
      if (remember) window.sessionStorage.setItem(speakerMemoryKey, "1");
      else window.sessionStorage.removeItem(speakerMemoryKey);
    } catch {
      /* storage may be disabled in a private browsing context */
    }
  };
  const canJoinAsSpeaker = () =>
    seatSide &&
    (
      ["scheduled", "ready", "live"] as readonly (string | undefined)[]
    ).includes(eventStatus);
  function updateSpeakerButton() {
    const state = speakerButtonState({
      side: seatSide,
      status: eventStatus,
      connected: speakerConnected,
      joining: joiningSpeaker,
    });
    speakerButton.hidden = state.hidden;
    speakerButton.disabled = state.disabled;
    speakerButton.textContent = state.text;
  }
  const recovery = createMediaRecovery({
    join: (role, isCurrent) =>
      role === "speaker"
        ? connectAsSpeaker(true, isCurrent)
        : connectAsViewer(true, isCurrent),
    available: (role) =>
      role === "speaker" ? canJoinAsSpeaker() : eventStatus === "live",
    online: () => navigator.onLine && !document.hidden && !disposed,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (timer) => window.clearTimeout(timer),
    exhausted: () => {
      diagnostics.finish("technical_failure");
      say("Automatic reconnect failed. Use Join to try again.");
    },
  });
  const loadReplayLibrary = createReplayLibraryLoader({
    document,
    source: root.dataset.mediaReplayPlayer!,
    getLibrary: () => window.yapReplayHls,
  });
  const replayPlayer = createReplayPlayer({
    video,
    loadHls: loadReplayLibrary,
    request,
    diagnostics,
    say,
    soundRequired: (required) => {
      sound.hidden = !required;
    },
  });
  const captionsTrack = video.querySelector("track");
  if (captionsTrack) captionsTrack.dataset.originalSrc = captionsTrack.src;
  const replayObservers = (["video", "audio"] as const).map((kind) =>
    observePlayback(video, {
      kind,
      diagnostics,
      expected: () => !document.hidden && !video.hidden,
    }),
  );
  function cancelReconnect() {
    recovery.stop();
  }
  function scheduleReconnect() {
    recovery.retry();
  }
  function stopPreparedMicrophone() {
    preparedMicrophone?.stop();
    preparedMicrophone = undefined;
  }
  async function disconnectRoom() {
    const previousRoom = room;
    room = undefined;
    side = undefined;
    leave.hidden = true;
    mute.hidden = true;
    speakerConnected = false;
    updateSpeakerButton();
    showMicrophoneStatus("");
    stopPreparedMicrophone();
    await stopMediaSession(previousRoom, mediaTracks);
  }
  async function connect(token: string, url: string) {
    const epoch = recovery.generation;
    const previousRoom = room;
    room = undefined;
    stopPreparedMicrophone();
    await stopMediaSession(previousRoom, mediaTracks);
    if (epoch !== recovery.generation || !recovery.intent || disposed)
      throw Object.assign(new Error("Join cancelled"), { name: "AbortError" });
    const nextRoom = preparedRoom || new Room(roomOptions);
    preparedRoom = undefined;
    room = nextRoom;
    nextRoom.on(
      RoomEvent.TrackSubscribed,
      (track, _publication, participant) =>
        room === nextRoom && mediaTracks.attach(track, participant.identity),
    );
    nextRoom.on(
      RoomEvent.TrackUnsubscribed,
      (track) => room === nextRoom && mediaTracks.detach(track),
    );
    nextRoom.on(
      RoomEvent.ParticipantDisconnected,
      (participant) =>
        room === nextRoom &&
        mediaTracks.removeParticipant(participant.identity),
    );
    nextRoom.on(RoomEvent.Reconnecting, () => {
      if (room === nextRoom) {
        recovery.transportRecovering();
        diagnostics.record("transport_interruption");
        say("Connection interrupted. Reconnecting…");
      }
    });
    nextRoom.on(RoomEvent.Reconnected, () => {
      if (room !== nextRoom) return;
      recovery.connected();
      diagnostics.record("transport_reconnected");
      say("Connection restored.");
      void refresh();
    });
    nextRoom.on(
      RoomEvent.ParticipantPermissionsChanged,
      (_prior, participant) => {
        if (room === nextRoom && participant === nextRoom.localParticipant)
          void refresh();
      },
    );
    nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room === nextRoom) {
        sound.hidden = nextRoom.canPlaybackAudio;
        if (!nextRoom.canPlaybackAudio)
          diagnostics.record("sound_activation_required");
      }
    });
    nextRoom.on(RoomEvent.Disconnected, (reason) => {
      if (room !== nextRoom) return;
      endWatch();
      room = undefined;
      leave.hidden = true;
      mute.hidden = true;
      diagnostics.record("disconnected", { reason });
      mediaTracks.clear();
      stopPreparedMicrophone();
      side = undefined;
      speakerConnected = false;
      updateSpeakerButton();
      const recoverable = mayRecoverDisconnect(reason);
      if (!recoverable) {
        rememberSpeaker(false);
        diagnostics.finish("stopped");
      }
      say(
        recoverable && recovery.intent
          ? "Disconnected. Reconnecting…"
          : "Disconnected. Use Join to reconnect.",
      );
      recovery.disconnected(recoverable);
    });
    await nextRoom.connect(url, token);
    if (
      room !== nextRoom ||
      disposed ||
      !recovery.intent ||
      epoch !== recovery.generation
    ) {
      await nextRoom.disconnect(true);
      throw Object.assign(new Error("Join cancelled"), { name: "AbortError" });
    }
    recovery.connected();
    void liveOutline?.then((attach) => attach(nextRoom));
    leave.hidden = false;
    sound.hidden = nextRoom.canPlaybackAudio;
    for (const participant of nextRoom.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          mediaTracks.attach(publication.track, participant.identity);
    return nextRoom;
  }
  async function connectAsViewer(automatic = false, isCurrent = () => true) {
    if (viewerJoining || joiningSpeaker || disposed) return;
    const epoch = recovery.generation;
    const current = () => isCurrent() && epoch === recovery.generation;
    viewerJoining = true;
    viewerButton.disabled = true;
    try {
      const grant = await request("/viewer-token", { method: "POST" });
      diagnostics.record("authorization", { outcome: "allowed" });
      if (!current() || recovery.intent !== "viewer") return;
      await connect(grant.token, grant.url);
      if (!current()) {
        await disconnectRoom();
        return;
      }
      say("Watching live debate.");
      void tickWatch();
    } catch (error) {
      diagnostics.record("authorization", {
        outcome: ([401, 403, 404] as readonly (number | undefined)[]).includes(
          (error as MediaError).status,
        )
          ? "denied"
          : "technical_error",
      });
      say((error as MediaError).message);
      if (automatic) throw error;
      if (
        ([401, 403, 404] as readonly (number | undefined)[]).includes(
          (error as MediaError).status,
        )
      ) {
        recovery.stop();
        diagnostics.finish("authorization_denied");
      } else recovery.disconnected(true);
    } finally {
      viewerJoining = false;
      viewerButton.disabled = false;
    }
  }
  viewerButton.addEventListener("click", () => {
    if (viewerJoining || joiningSpeaker) return;
    recovery.start("viewer");
    diagnostics.start("live", preparationComplete);
    leave.hidden = false;
    preparedRoom ||= new Room(roomOptions);
    void preparedRoom.startAudio().catch(() => {
      sound.hidden = false;
    });
    void connectAsViewer();
  });
  async function connectAsSpeaker(automatic = false, isCurrent = () => true) {
    if (
      joiningSpeaker ||
      viewerJoining ||
      !canJoinAsSpeaker() ||
      speakerConnected
    )
      return;
    const epoch = recovery.generation;
    const current = () =>
      isCurrent() &&
      epoch === recovery.generation &&
      recovery.intent === "speaker";
    joiningSpeaker = true;
    updateSpeakerButton();
    try {
      const message = await joinSpeaker({
        button: speakerButton,
        mediaDevices: navigator.mediaDevices,
        isCurrent: current,
        devices: deviceChoices,
        microphoneWanted,
        replaceExisting: !automatic,
        rememberDevices(choices) {
          for (const [kind, value] of Object.entries(choices))
            if (value) deviceChoices[kind as keyof DeviceChoices] = value;
          try {
            window.sessionStorage.setItem(
              `${speakerMemoryKey}:devices`,
              JSON.stringify(deviceChoices),
            );
          } catch {
            /* optional storage */
          }
        },
        request,
        connect,
        tracks: mediaTracks,
        setSide(value) {
          side = value;
        },
        setPreparedMicrophone(track) {
          stopPreparedMicrophone();
          preparedMicrophone = track;
        },
        async markReady() {
          const ready = await fetch(`/api/matching/events/${id}/ready`, {
            method: "POST",
            credentials: "same-origin",
          });
          if (!ready.ok) {
            const data: { error?: string } = await ready
              .json()
              .catch(() => ({}));
            throw new Error(data.error || "Could not record speaker readiness");
          }
        },
        refresh,
      });
      if (!canJoinAsSpeaker() || !room)
        throw new Error("Debate is no longer available for speakers");
      speakerConnected = true;
      viewerButton.hidden = true;
      rememberSpeaker(true);
      recovery.connected();
      mute.hidden = false;
      say(message);
    } catch (error) {
      await disconnectRoom();
      say((error as MediaError).message);
      if (
        (!isMovingSpeakerAccess(error) &&
          ([401, 403, 404, 409] as readonly (number | undefined)[]).includes(
            (error as MediaError).status,
          )) ||
        ["NotAllowedError", "SecurityError"].includes(
          (error as MediaError).name,
        )
      ) {
        rememberSpeaker(false);
        recovery.stop();
        diagnostics.finish("authorization_denied");
      }
      if (automatic) throw error;
    } finally {
      joiningSpeaker = false;
      updateSpeakerButton();
      if (!automatic && !speakerConnected) recovery.disconnected(true);
    }
  }
  speakerButton.addEventListener("click", () => {
    if (viewerJoining || joiningSpeaker) return;
    cancelReconnect();
    recovery.start("speaker");
    diagnostics.start("speaker", preparationComplete);
    leave.hidden = false;
    void connectAsSpeaker();
  });
  replay.addEventListener("click", async () => {
    replay.disabled = true;
    try {
      await replayPlayer.start();
      void tickWatch();
    } catch (error) {
      say((error as MediaError).message);
    } finally {
      replay.disabled = false;
    }
  });
  sound.addEventListener("click", async () => {
    diagnostics.record("sound_activation_tap");
    try {
      if (room) {
        await room.startAudio();
        sound.hidden = room.canPlaybackAudio;
      } else await replayPlayer.activateSound();
    } catch {
      say("Sound could not start. Try Enable sound again.");
    }
  });
  leave.addEventListener("click", () => {
    recovery.stop();
    rememberSpeaker(false);
    diagnostics.finish("voluntary_leave");
    endWatch();
    leave.hidden = true;
    mute.hidden = true;
    void disconnectRoom();
    say("You left the live debate.");
  });
  mute.addEventListener("click", () => {
    microphoneWanted = !microphoneWanted;
    mute.setAttribute("aria-pressed", String(!microphoneWanted));
    mute.textContent = microphoneWanted
      ? "Mute microphone"
      : "Allow microphone on my turn";
    try {
      window.sessionStorage.setItem(
        `${speakerMemoryKey}:muted`,
        microphoneWanted ? "0" : "1",
      );
    } catch {
      /* optional storage */
    }
    diagnostics.record("microphone_intent", { enabled: microphoneWanted });
    if (!microphoneWanted) {
      if (preparedMicrophone) preparedMicrophone.enabled = false;
      void room?.localParticipant.setMicrophoneEnabled(false);
    }
    void refresh();
  });
  for (const button of operator.querySelectorAll<HTMLButtonElement>(
    "[data-media-action]",
  )) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const action = button.dataset.mediaAction;
        if (
          action === "end" &&
          !window.confirm("End this debate now? This cannot be undone.")
        )
          return;
        const reason = operator
          .querySelector<HTMLInputElement>("[data-media-reason]")!
          .value.trim();
        const body =
          action === "resume"
            ? { revision: currentState?.revision }
            : { reason };
        await request(`/${action}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        say(`Operator action ${action} recorded.`);
        await refresh();
      } catch (error) {
        say((error as MediaError).message);
      } finally {
        button.disabled = false;
      }
    });
  }
  operator
    .querySelector<HTMLButtonElement>("[data-media-captions-submit]")!
    .addEventListener("click", async (event) => {
      (event.currentTarget as HTMLButtonElement).disabled = true;
      try {
        await request("/captions", {
          method: "PUT",
          body: JSON.stringify({
            vtt: operator.querySelector<HTMLTextAreaElement>(
              "[data-media-captions]",
            )!.value,
          }),
        });
        say("Captions published for replay.");
      } catch (error) {
        say((error as MediaError).message);
      } finally {
        (event.currentTarget as HTMLButtonElement).disabled = false;
      }
    });
  let publicRevision = "0";
  // Room signals wait for the first status read, and stop after the status
  // endpoint refuses this page (401/403/404) until a later read succeeds.
  let firstRead = false,
    heldSignal = 0n,
    mediaUnavailable = false;
  async function refresh() {
    const pageEpoch = pageGeneration;
    try {
      const result = await request("");
      if (disposed || pageEpoch !== pageGeneration) return false;
      if (result.streamRevision !== undefined) {
        if (
          !/^\d{1,20}$/.test(result.streamRevision) ||
          BigInt(result.streamRevision) < BigInt(publicRevision)
        )
          return false;
      }
      if (
        currentState &&
        result.state &&
        result.state.revision < currentState.revision
      )
        return false;
      if (result.streamRevision !== undefined)
        publicRevision = result.streamRevision;
      mediaUnavailable = false;
      currentState = result.state;
      eventStatus = result.eventStatus;
      serverOffset = new Date(result.serverNow).getTime() - Date.now();
      const live = result.eventStatus === "live";
      const presentation = mediaPresentation(
        result.eventStatus,
        result.state,
        result.automaticReplayPublication,
      );
      viewerButton.hidden = !live || speakerConnected || Boolean(room);
      updateSpeakerButton();
      replay.hidden = !presentation.replayVisible;
      if (!room && !recovery.intent && video.hidden) say(presentation.message);
      if (live && !preparationStarted) {
        preparationStarted = true;
        preparedRoom ||= new Room(roomOptions);
        void preparedRoom
          .prepareConnection(result.preparationUrl)
          .then(() => {
            preparationComplete = true;
            diagnostics.record("connection_prepared");
          })
          .catch(() => diagnostics.record("preparation_failed"));
      }
      if (
        presentation.replayVisible &&
        !navigator.connection?.saveData &&
        !document.hidden
      )
        void replayPlayer.prepare().catch(() => {});
      for (const button of operator.querySelectorAll<HTMLButtonElement>(
        "[data-media-action]",
      ))
        button.hidden =
          !presentation.actions[
            button.dataset.mediaAction as keyof typeof presentation.actions
          ];
      if (
        (
          ["ended", "replay", "finalized", "cancelled"] as readonly (
            string | undefined
          )[]
        ).includes(eventStatus)
      ) {
        if (watchSession?.mode === "live") endWatch();
        cancelReconnect();
        rememberSpeaker(false);
        if (room) diagnostics.finish("debate_ended");
        if (room) await disconnectRoom();
        return;
      }
      if (room && side) {
        const shouldSpeak =
          microphoneWanted &&
          recovery.intent === "speaker" &&
          live &&
          result.state?.state === "running" &&
          result.state.activeSide === side;
        if (microphoneChange) await microphoneChange.catch(() => {});
        if (preparedMicrophone?.readyState === "ended")
          stopPreparedMicrophone();
        const mayPublishMicrophone =
          room?.localParticipant.permissions?.canPublishSources?.includes(
            Track.sourceToProto(Track.Source.Microphone),
          );
        if (room && shouldSpeak && !mayPublishMicrophone) {
          showMicrophoneStatus("Waiting for microphone access…");
          return;
        }
        if (room && room.localParticipant.isMicrophoneEnabled !== shouldSpeak) {
          showMicrophoneStatus(
            shouldSpeak ? "Opening microphone…" : "Microphone off",
          );
          if (shouldSpeak && preparedMicrophone) {
            const track = preparedMicrophone;
            preparedMicrophone = undefined;
            microphoneChange = room.localParticipant.publishTrack(track, {
              source: Track.Source.Microphone,
            });
            const publishingRoom = room;
            microphoneChange = microphoneChange.then((publication) => {
              track.enabled =
                room === publishingRoom &&
                microphoneWanted &&
                currentState?.state === "running" &&
                currentState?.activeSide === side &&
                Boolean(
                  publishingRoom.localParticipant.permissions?.canPublishSources?.includes(
                    Track.sourceToProto(Track.Source.Microphone),
                  ),
                );
              return publication;
            });
            microphoneChange.catch(() => track.stop());
          } else {
            microphoneChange = room.localParticipant.setMicrophoneEnabled(
              shouldSpeak,
              deviceChoices.audioinput
                ? { deviceId: { exact: deviceChoices.audioinput } }
                : undefined,
            );
          }
          try {
            const changingRoom = room;
            await microphoneChange;
            if (
              changingRoom &&
              (room !== changingRoom ||
                !microphoneWanted ||
                recovery.intent !== "speaker" ||
                currentState?.state !== "running" ||
                currentState?.activeSide !== side ||
                !changingRoom.localParticipant.permissions?.canPublishSources?.includes(
                  Track.sourceToProto(Track.Source.Microphone),
                ))
            )
              await changingRoom.localParticipant.setMicrophoneEnabled(false);
          } catch (error) {
            showMicrophoneStatus(
              "Microphone could not start. Check permission and reconnect.",
            );
            throw error;
          } finally {
            microphoneChange = undefined;
          }
        }
        if (room)
          showMicrophoneStatus(
            room.localParticipant.isMicrophoneEnabled
              ? "Microphone enabled"
              : shouldSpeak
                ? "Microphone still unavailable. Refresh to retry."
                : preparedMicrophone
                  ? "Microphone ready · muted"
                  : "Microphone off",
          );
      }
      return true;
    } catch (error) {
      if (disposed || pageEpoch !== pageGeneration) return false;
      if (
        ([401, 403, 404] as readonly (number | undefined)[]).includes(
          (error as MediaError).status,
        )
      ) {
        mediaUnavailable = true;
        recovery.stop();
        rememberSpeaker(false);
        replayPlayer.stop();
        video.hidden = true;
        if (room) await disconnectRoom();
        diagnostics.finish("authorization_denied");
      }
      say(
        (error as MediaError).message === "resource not found"
          ? "Live media is not configured for this deployment."
          : (error as MediaError).message,
      );
      return false;
    }
  }
  function paintClock() {
    if (
      !currentState ||
      currentState.state !== "running" ||
      !currentState.turnDeadlineAt
    ) {
      clock.textContent = "";
      return;
    }
    const remaining = Math.max(
      0,
      new Date(currentState.turnDeadlineAt).getTime() -
        Date.now() -
        serverOffset,
    );
    clock.textContent = `${currentState.activeSide} · ${Math.ceil(remaining / 1000)}s`;
  }
  document.addEventListener("visibilitychange", () => {
    void tickWatch();
    diagnostics.record(document.hidden ? "background" : "foreground");
    if (document.hidden) {
      if (!speakerConnected) {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      recovery.offline(); // invalidate stability evidence without ending intent
      replayPlayer.background();
    }
    if (!document.hidden) {
      replayPlayer.online();
      void refresh();
      pollStatus();
      if (!speakerConnected) scheduleReconnect();
    }
  });
  window.addEventListener("offline", () => {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
    recovery.offline();
    replayPlayer.offline();
    diagnostics.record("offline");
  });
  window.addEventListener("online", () => {
    diagnostics.record("network_restored");
    replayPlayer.online();
    void refresh();
    pollStatus();
    if (!speakerConnected) scheduleReconnect();
  });
  window.addEventListener("yap-measurement-changed", () => void tickWatch());
  video.addEventListener("playing", () => void tickWatch());
  video.addEventListener("pause", endWatch);
  video.addEventListener("ended", () => {
    endWatch();
    diagnostics.finish("completed");
  });
  const watchTimer = window.setInterval(() => void tickWatch(), 10_000);
  fetch("/api/me/roles", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data: { roles?: string[] } | null) => {
      if (data?.roles?.includes("operator")) operator.hidden = false;
    })
    .catch(() => {});
  void (async () => {
    try {
      const seat = await request("/speaker-seat");
      seatSide = seat.side;
      speakerMemoryKey = `media-speaker:${id}:${seat.userId}`;
      try {
        microphoneWanted =
          window.sessionStorage.getItem(`${speakerMemoryKey}:muted`) !== "1";
        deviceChoices = JSON.parse(
          window.sessionStorage.getItem(`${speakerMemoryKey}:devices`) || "{}",
        );
      } catch {
        /* optional storage */
      }
      mute.setAttribute("aria-pressed", String(!microphoneWanted));
      mute.textContent = microphoneWanted
        ? "Mute microphone"
        : "Allow microphone on my turn";
    } catch {
      seatSide = undefined;
    }
    await refresh();
    releaseHeldSignal();
    if (remembersSpeaker() && canJoinAsSpeaker()) {
      recovery.start("speaker");
      diagnostics.start("speaker", preparationComplete);
      scheduleReconnect();
    }
  })();
  let pollTimer: number | undefined;
  let streamLive = false;
  const followDeadline = createDeadlineFollower();
  // Room signals replace status polling while the stream is live; a slow read
  // remains as a safety net. The turn deadline is read shortly after it
  // passes, and polling is the slower fallback while the stream is down.
  function pollDelay() {
    const running = currentState?.state === "running";
    const deadline = running ? currentState!.turnDeadlineAt : null;
    const follow = followDeadline(
      [deadline],
      `${currentState?.revision}:${deadline}`,
      Date.now() + serverOffset,
    );
    const fallback = streamLive ? 60000 : speakerConnected ? 2000 : 6000;
    return follow === null ? fallback : Math.min(follow, fallback);
  }
  function pollStatus() {
    if (
      disposed ||
      pollTimer !== undefined ||
      navigator.onLine === false ||
      (document.hidden && !speakerConnected)
    )
      return;
    const delay = pollDelay();
    if (delay === null) return;
    pollTimer = window.setTimeout(async () => {
      pollTimer = undefined;
      await refresh();
      pollStatus();
    }, delay);
  }
  function reschedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
    pollStatus();
  }
  pollStatus();
  const signalRefresh = createSignalRefresh({
    async read() {
      await refresh();
      reschedulePoll();
      return publicRevision;
    },
    // A read that already reported this room cursor covers the signal.
    current: () => publicRevision,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => window.clearTimeout(timer),
  });
  function releaseHeldSignal() {
    firstRead = true;
    if (heldSignal && !disposed && !mediaUnavailable)
      signalRefresh.request(heldSignal);
  }
  const stopWatching = watchRoom({
    room: id,
    topics: ["media"],
    events: window,
    signal(_topic, cursor) {
      if (disposed || mediaUnavailable) return;
      if (!firstRead) {
        if (cursor > heldSignal) heldSignal = cursor;
        return;
      }
      signalRefresh.request(cursor);
    },
    health(live) {
      streamLive = live;
      // A dropped stream may have missed a signal: read once, then poll.
      if (!live && !disposed && !document.hidden && !mediaUnavailable)
        void refresh();
      reschedulePoll();
    },
  });
  const clockTimer = window.setInterval(paintClock, 250);
  const statsTimer = window.setInterval(async () => {
    if (!room || document.hidden) return;
    const activeRoom = room;
    for (const person of activeRoom.remoteParticipants.values())
      for (const publication of person.trackPublications.values()) {
        const track = publication.track;
        if (!track || track.isMuted) continue;
        try {
          const report = await track.getRTCStatsReport();
          if (room !== activeRoom) return;
          report?.forEach((row: RTCInboundRtpStreamStats) => {
            if (row.type === "inbound-rtp")
              diagnostics.record("webrtc_stats", {
                kind: track.kind as MediaKind,
                packetsLost: row.packetsLost,
                packetsReceived: row.packetsReceived,
                framesDecoded: row.framesDecoded,
                freezeCount: row.freezeCount,
                totalFreezesDuration: row.totalFreezesDuration,
                concealedSamples: row.concealedSamples,
                totalSamplesReceived: row.totalSamplesReceived,
                jitterBufferDelay: row.jitterBufferDelay,
                jitterBufferEmittedCount: row.jitterBufferEmittedCount,
              });
          });
        } catch {
          diagnostics.record("stats_unavailable");
        }
      }
  }, 5000);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !cachedPage) return;
    cachedPage = false;
    disposed = false;
    const pageEpoch = ++pageGeneration;
    const role = cachedIntent;
    cachedIntent = undefined;
    diagnostics.record("foreground");
    replayPlayer.resume();
    pollStatus();
    void refresh().then((eligible) => {
      if (!eligible || disposed || pageEpoch !== pageGeneration) return;
      if (
        (role === "speaker" && canJoinAsSpeaker()) ||
        (role === "viewer" && eventStatus === "live")
      ) {
        recovery.start(role);
        diagnostics.start(role === "viewer" ? "live" : "speaker", false);
        scheduleReconnect();
      }
    });
  });
  window.addEventListener(
    "pagehide",
    (event: Partial<PageTransitionEvent> = {}) => {
      pageGeneration++;
      cachedPage = Boolean(event.persisted);
      cachedIntent = cachedPage ? recovery.intent : undefined;
      disposed = true;
      recovery.stop();
      diagnostics.finish("abandoned");
      endWatch();
      window.clearTimeout(pollTimer);
      void disconnectRoom();
      pollTimer = undefined;
      void preparedRoom?.disconnect(true);
      preparedRoom = undefined;
      if (cachedPage) {
        // Keep DOM, drafts, scroll and listeners in the browser's frozen page.
        // Capture/transport is released; fresh authorization is required on return.
        void reporter.flush();
        replayPlayer.suspend();
        return;
      }
      reporter.stop();
      replayPlayer.destroy();
      replayObservers.forEach((stop) => stop());
      stopWatching();
      signalRefresh.stop();
      window.clearInterval(watchTimer);
      window.clearInterval(clockTimer);
      window.clearInterval(statsTimer);
    },
  );
}
