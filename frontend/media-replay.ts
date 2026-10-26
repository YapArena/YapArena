import type HlsLibrary from "hls.js";
import type { HlsConfig } from "hls.js";
import type {
  MediaError,
  MediaRequest,
  PlaybackDiagnostics,
  ReplayGrant,
  ReplayLibrary,
} from "./media-types.js";

interface PlaybackSnapshot {
  time: number;
  rate: number;
  paused: boolean;
  captions: TextTrackMode[];
}

export function createReplayPlayer({
  video,
  Hls,
  loadHls = async () => Hls,
  request,
  diagnostics,
  say,
  soundRequired,
  preview = false,
  online = () => navigator.onLine,
  visible = () => globalThis.document?.visibilityState !== "hidden",
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  video: HTMLVideoElement;
  Hls?: ReplayLibrary;
  loadHls?: () => Promise<ReplayLibrary | undefined>;
  request: MediaRequest;
  diagnostics: PlaybackDiagnostics;
  say: (message: string) => void;
  soundRequired: (required: boolean) => void;
  preview?: boolean;
  online?: () => boolean;
  visible?: () => boolean;
  schedule?: (callback: () => void, delay: number) => number;
  cancel?: (timer: number) => void;
}) {
  let player: HlsLibrary | undefined;
  let grant: ReplayGrant | undefined;
  let renewing: Promise<void> | undefined;
  let renewalToken: object | undefined;
  let timer: number | undefined;
  let retryTimer: number | undefined;
  let generation = 0;
  let sourceGeneration = -1;
  let attempts = 0;
  let prepared = false;
  let loading = false;
  let wanted = false;
  let destroyed = false;
  let restore: PlaybackSnapshot | undefined;
  let stableTimer: number | undefined;
  let suspended = false;
  const snapshot = () => ({
    time: video.currentTime || 0,
    rate: video.playbackRate,
    paused: video.paused,
    captions: Array.from(video.textTracks).map((track) => track.mode),
  });
  function clearTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  async function play() {
    if (suspended) return;
    try {
      await video.play();
      soundRequired(false);
    } catch (error) {
      if ((error as MediaError).name === "NotAllowedError") {
        diagnostics.record("sound_activation_required");
        soundRequired(true);
      } else recover();
    }
  }
  function loaded() {
    if (!restore || suspended || sourceGeneration !== generation) return;
    video.currentTime = restore.time;
    video.playbackRate = restore.rate;
    Array.from(video.textTracks).forEach((track, i) => {
      track.mode = restore!.captions[i] || "disabled";
    });
    const resume = !restore.paused;
    restore = undefined;
    loading = false;
    if (resume) void play();
  }
  video.addEventListener("loadedmetadata", loaded);
  const playing = () => {
    diagnostics.record("replay_resumed");
    if (stableTimer !== undefined) cancel(stableTimer);
    let lastPosition = video.currentTime;
    let progressingSeconds = 0;
    const sample = () => {
      stableTimer = undefined;
      if (
        video.paused ||
        video.ended ||
        video.seeking ||
        suspended ||
        !online() ||
        !visible() ||
        video.currentTime <= lastPosition
      )
        return;
      lastPosition = video.currentTime;
      if (++progressingSeconds === 10) {
        attempts = 0;
        diagnostics.record("recovery_stable", { windowMs: 10_000 });
      } else stableTimer = schedule(sample, 1000);
    };
    stableTimer = schedule(sample, 1000);
  };
  const waiting = () => {
    if (stableTimer !== undefined) cancel(stableTimer);
    stableTimer = undefined;
  };
  // Decisions 0012 and 0013: a read-only playback position for the betting
  // panel and the outline's replay sync. Previews, and players outside a
  // debate's media section, send nothing.
  const playbackDebate = preview
    ? undefined
    : video.closest?.<HTMLElement>("[data-media-event]")?.dataset.mediaEvent;
  if (playbackDebate) {
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("yap:playback", {
          detail: {
            debateId: playbackDebate,
            positionSeconds: video.currentTime,
            playing: !video.paused && !video.ended,
          },
        }),
      );
    for (const type of ["timeupdate", "seeked", "play", "pause"])
      video.addEventListener(type, announce);
  }
  video.addEventListener("playing", playing);
  video.addEventListener("waiting", waiting);
  video.addEventListener("pause", waiting);
  video.addEventListener("ended", waiting);
  video.addEventListener("seeking", waiting);
  video.addEventListener("error", recover);
  function renewLater() {
    clearTimer();
    timer = schedule(
      () => {
        timer = undefined;
        if (wanted && online()) void renew().catch(() => {});
      },
      Math.max(1000, (grant!.expiresIn - 30) * 1000),
    );
  }
  async function load(
    access: ReplayGrant,
    previous: PlaybackSnapshot,
    preload: boolean,
    epoch: number,
  ) {
    const PlaybackHls =
      access.type === "hls" &&
      !video.canPlayType("application/vnd.apple.mpegurl")
        ? await loadHls()
        : undefined;
    if (epoch !== generation || destroyed) return;
    if (PlaybackHls && !PlaybackHls.isSupported())
      throw new Error("Adaptive replay is not supported in this browser");
    player?.destroy();
    player = undefined;
    sourceGeneration = epoch;
    loading = true;
    restore = previous;
    grant = access;
    const captions = video.querySelector("track");
    if (captions)
      captions.src = access.captionsUrl || captions.dataset.originalSrc!;
    video.preload = "metadata";
    video.crossOrigin = access.type === "hls" ? "anonymous" : null;
    if (PlaybackHls) {
      const Hls = PlaybackHls;
      // Preserve the existing option even though this SDK type omits it.
      player = new Hls({
        autoStartLoad: false,
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: preload || preview ? 2 : 15,
        maxMaxBufferLength: preload || preview ? 4 : 30,
        maxBufferSize: preload || preview ? 2_000_000 : 20_000_000,
        autoLevelCapping: preview ? 0 : -1,
        enableWorker: true,
      } as Partial<HlsConfig> & { autoLevelCapping: number });
      const activePlayer = player;
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        if (player !== activePlayer || epoch !== generation || suspended)
          return;
        prepared = preload;
        // At most the first low rendition fragment is requested for preparation.
        player!.startLoad(previous.time);
      });
      player.on(Hls.Events.FRAG_BUFFERED, () => {
        if (
          preload &&
          !wanted &&
          !suspended &&
          epoch === generation &&
          player === activePlayer
        )
          player!.stopLoad();
      });
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (
          player === activePlayer &&
          epoch === generation &&
          !suspended &&
          data.fatal
        )
          recover();
      });
      player.attachMedia(video);
      player.loadSource(access.url);
    } else {
      video.src = access.url;
      // Native preload=metadata is a browser hint; no initial-segment byte bound
      // can be guaranteed, so native preparation does not request autoplay.
      video.load();
      prepared = preload;
    }
    renewLater();
  }
  async function renew(preload = false) {
    if (renewing) return renewing;
    const epoch = generation;
    const token = {};
    renewalToken = token;
    renewing = Promise.resolve().then(async () => {
      try {
        const access = await request("/replay");
        if (destroyed || epoch !== generation) return;
        // A source replacement resets the DOM before metadata arrives. Until
        // restoration succeeds, this saved state remains authoritative.
        const previous = restore || snapshot();
        if (wanted && !grant) previous.paused = false;
        diagnostics.record("authorization", { outcome: "allowed" });
        await load(access, previous, preload, epoch);
      } catch (error) {
        if (epoch !== generation || destroyed) return;
        diagnostics.record("authorization", {
          outcome: (
            [401, 403, 404] as readonly (number | undefined)[]
          ).includes((error as MediaError).status)
            ? "denied"
            : "technical_error",
        });
        if (
          ([401, 403, 404] as readonly (number | undefined)[]).includes(
            (error as MediaError).status,
          )
        ) {
          stop();
          diagnostics.finish("authorization_denied");
          say("Replay is no longer available.");
        } else recover();
        throw error;
      } finally {
        if (renewalToken === token) {
          renewing = undefined;
          renewalToken = undefined;
        }
      }
    });
    return renewing;
  }
  function recover() {
    waiting();
    if (
      destroyed ||
      suspended ||
      !wanted ||
      retryTimer !== undefined ||
      !online()
    )
      return;
    if (attempts >= 5) {
      wanted = false;
      diagnostics.finish("technical_failure");
      say("Replay could not recover. Use Play replay to try again.");
      return;
    }
    const epoch = generation;
    diagnostics.record("replay_recovery");
    retryTimer = schedule(
      () => {
        retryTimer = undefined;
        if (epoch === generation && online()) void renew().catch(() => {});
      },
      Math.min(4000, 250 * 2 ** attempts++) * (0.75 + Math.random() * 0.5),
    );
  }
  function stop() {
    wanted = false;
    generation++;
    clearTimer();
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
    waiting();
    player?.destroy();
    player = undefined;
    grant = undefined;
    restore = undefined;
    prepared = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  return {
    async prepare() {
      if (!grant && !destroyed) await renew(true);
    },
    async start() {
      diagnostics.start("replay", prepared);
      wanted = true;
      const epoch = generation;
      attempts = 0;
      video.hidden = false;
      if (!grant) await renew();
      else {
        if (new Date(grant.expiresAt).getTime() <= Date.now() + 30_000)
          await renew();
        if (player) {
          player.config.maxBufferLength = preview ? 2 : 15;
          player.config.maxMaxBufferLength = preview ? 4 : 30;
          player.config.maxBufferSize = preview ? 2_000_000 : 20_000_000;
          player.startLoad(video.currentTime);
        }
        if (loading && restore) restore.paused = false;
      }
      if (wanted && epoch === generation) await play();
    },
    async activateSound() {
      diagnostics.record("sound_activation_tap");
      video.muted = false;
      await play();
    },
    online() {
      if (wanted && !suspended) void renew().catch(() => {});
    },
    offline() {
      waiting();
      clearTimer();
      if (retryTimer !== undefined) cancel(retryTimer);
      retryTimer = undefined;
      diagnostics.record("offline");
    },
    background() {
      waiting();
    },
    suspend() {
      suspended = true;
      generation++;
      renewing = undefined;
      renewalToken = undefined;
      restore ||= snapshot();
      clearTimer();
      waiting();
      if (retryTimer !== undefined) cancel(retryTimer);
      retryTimer = undefined;
      player?.stopLoad();
      video.pause();
    },
    resume() {
      suspended = false;
      if (wanted && online()) void renew().catch(() => {});
    },
    stop,
    destroy() {
      stop();
      destroyed = true;
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("playing", playing);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("pause", waiting);
      video.removeEventListener("ended", waiting);
      video.removeEventListener("seeking", waiting);
      video.removeEventListener("error", recover);
    },
  };
}
