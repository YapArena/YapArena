import type {
  DebaterLanguage,
  Side,
  TranscriptionProvider,
  TranscriptSegment,
  TranscriptUpdate,
  TranscriptWord,
} from "../protocol.ts";
import { SEGMENTS_PER_UPDATE_MAX } from "../protocol.ts";
import type { IngestAnswer } from "./ingest-client.ts";

// Decision 0012: the transcriber's core, independent of LiveKit so it can be
// tested with fakes and move hosts later. It follows the turn (only the active
// speaker's microphone), keeps one speech-to-text channel per provider for the
// active speaker, opens the next speaker's channel shortly before the
// deadline, flushes finals at turn end, publishes captions and sends final
// segments to the server in order, one update at a time.

export interface SpeechWord {
  text: string;
  startTime?: number;
  endTime?: number;
  confidence?: number;
}
/** Times are seconds from the channel's first audio frame. */
export type SpeechUpdate =
  | { kind: "interim"; text: string }
  | {
      kind: "final";
      text: string;
      startTime: number;
      endTime: number;
      words: SpeechWord[];
    };
export interface SpeechChannel<F> {
  push(frame: F): void;
  /** Ends input, waits (bounded) for the last finals, then closes. */
  finish(): Promise<void>;
  close(): void;
  readonly updates: AsyncIterable<SpeechUpdate>;
}
export interface SpeechEngine<F> {
  readonly provider: TranscriptionProvider;
  open(language: DebaterLanguage): SpeechChannel<F>;
}
export interface AudioSource<F> {
  readonly frames: AsyncIterable<F>;
  readonly trackId: string;
  /** The speaker's participant identity: the captions' sender. */
  readonly identity: string;
}
export interface CaptionUpdate {
  speaker: string;
  trackId: string;
  segmentId: string;
  text: string;
  final: boolean;
  language: DebaterLanguage;
}
export interface TurnState {
  turnNumber: number;
  side: Side;
  /** Epoch milliseconds, or null while paused. */
  deadlineAt: number | null;
  running: boolean;
}
export interface Speaker {
  side: Side;
  language: DebaterLanguage | null;
  consented: boolean;
}
interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Opens the next speaker's channels this long before the deadline. */
export const PREOPEN_MS = 1500;
/** Spacing between ingest requests, about one a second at most. */
export const SEND_SPACING_MS = 750;
export const QUEUE_MAX = 200;

interface Channel<F> {
  engine: SpeechEngine<F>;
  role: "primary" | "shadow";
  speech: SpeechChannel<F>;
  /** Wall clock of the first frame pushed: the provider's time zero. */
  audioStartedAt: number | null;
  reading: Promise<void>;
}
interface ActiveTurn<F> {
  /** Unique per opening, so a resumed turn's caption IDs never repeat. */
  id: number;
  turnNumber: number;
  side: Side;
  language: DebaterLanguage;
  channels: Channel<F>[];
  audio: AudioSource<F> | null;
  segment: number;
  finished: boolean;
}
interface Queued {
  turnNumber: number;
  segment: TranscriptSegment;
}

export function createTurnTranscriber<F>({
  primary,
  shadow,
  jobId,
  nextSequence,
  send,
  captions,
  follow,
  captionsPerSecond = 4,
  clock = realClock,
  log = () => {},
}: {
  primary: SpeechEngine<F>;
  shadow?: SpeechEngine<F> | undefined;
  jobId: string;
  nextSequence: number;
  send: (update: TranscriptUpdate) => Promise<IngestAnswer>;
  captions: (update: CaptionUpdate) => Promise<void>;
  /** Asks the host to subscribe to this side's microphone only (or none). */
  follow: (side: Side | null) => void;
  captionsPerSecond?: number;
  clock?: Clock;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}) {
  const speakers = new Map<Side, Speaker>();
  let turn: TurnState | null = null;
  let active: ActiveTurn<F> | null = null;
  let prepared: ActiveTurn<F> | null = null;
  let preopenTimer: unknown;
  let sequence = nextSequence;
  const queue: Queued[] = [];
  let sending: Promise<void> | null = null;
  let lastSent = -Infinity;
  let stopped = false;
  const finishing = new Set<Promise<void>>();
  let opened = 0;

  const consenting = (side: Side) => {
    const speaker = speakers.get(side);
    return speaker?.consented && speaker.language ? speaker.language : null;
  };

  function open(turnNumber: number, side: Side): ActiveTurn<F> | null {
    const language = consenting(side);
    if (!language) return null;
    const result: ActiveTurn<F> = {
      id: opened++,
      turnNumber,
      side,
      language,
      channels: [],
      audio: null,
      segment: 0,
      finished: false,
    };
    for (const [engine, role] of [
      [primary, "primary"],
      ...(shadow ? [[shadow, "shadow"]] : []),
    ] as [SpeechEngine<F>, "primary" | "shadow"][]) {
      try {
        const speech = engine.open(language);
        const channel: Channel<F> = {
          engine,
          role,
          speech,
          audioStartedAt: null,
          reading: Promise.resolve(),
        };
        channel.reading = read(result, channel);
        result.channels.push(channel);
      } catch (error) {
        log("speech channel failed to open", {
          provider: engine.provider,
          role,
          error,
        });
      }
    }
    return result;
  }

  // Interim captions are throttled per turn; the latest text wins, and a
  // final caption cancels any pending interim.
  const captionTimers = new Map<ActiveTurn<F>, unknown>();
  const lastCaption = new Map<ActiveTurn<F>, number>();
  function caption(owner: ActiveTurn<F>, text: string, final: boolean) {
    const audio = owner.audio;
    if (!audio) return;
    const update: CaptionUpdate = {
      speaker: audio.identity,
      trackId: audio.trackId,
      segmentId: `SG_${owner.turnNumber}_${owner.id}_${owner.segment}`,
      text,
      final,
      language: owner.language,
    };
    const pending = captionTimers.get(owner);
    if (pending !== undefined) clock.clearTimeout(pending);
    captionTimers.delete(owner);
    const publish = () => {
      lastCaption.set(owner, clock.now());
      void captions(update).catch((error) =>
        log("caption publish failed", { error }),
      );
    };
    const spacing = 1000 / captionsPerSecond,
      since = clock.now() - (lastCaption.get(owner) ?? -Infinity);
    if (final || since >= spacing) publish();
    else captionTimers.set(owner, clock.setTimeout(publish, spacing - since));
  }

  async function read(owner: ActiveTurn<F>, channel: Channel<F>) {
    try {
      for await (const update of channel.speech.updates) {
        if (update.kind === "interim") {
          if (channel.role === "primary" && update.text.trim())
            caption(owner, update.text, false);
          continue;
        }
        const text = update.text.trim();
        if (!text || channel.audioStartedAt === null) continue;
        const startAt = Math.round(
            channel.audioStartedAt + update.startTime * 1000,
          ),
          endAt = Math.max(
            startAt,
            Math.round(channel.audioStartedAt + update.endTime * 1000),
          );
        const words: TranscriptWord[] = [];
        for (const word of update.words) {
          const value = word.text.trim();
          if (
            !value ||
            word.startTime === undefined ||
            word.endTime === undefined
          )
            continue;
          const s = Math.max(
            0,
            Math.round((word.startTime - update.startTime) * 1000),
          );
          words.push({
            w: value.slice(0, 100),
            s,
            e: Math.max(
              s,
              Math.round((word.endTime - update.startTime) * 1000),
            ),
            ...(word.confidence === undefined
              ? {}
              : { c: Math.min(1, Math.max(0, word.confidence)) }),
          });
        }
        enqueue(owner.turnNumber, {
          provider: channel.engine.provider,
          role: channel.role,
          language: owner.language,
          side: owner.side,
          startAt,
          endAt,
          text: text.slice(0, 1000),
          words: words.slice(0, 300),
          latencyMs: Math.min(600_000, Math.max(0, clock.now() - endAt)),
          audioMs: Math.min(600_000, endAt - startAt),
        });
        if (channel.role === "primary") {
          caption(owner, text, true);
          owner.segment++;
        }
      }
    } catch (error) {
      log("speech channel failed", {
        provider: channel.engine.provider,
        error,
      });
    }
  }

  async function pump(owner: ActiveTurn<F>, audio: AudioSource<F>) {
    try {
      for await (const frame of audio.frames) {
        if (owner.finished || owner.audio !== audio) break;
        for (const channel of owner.channels) {
          channel.audioStartedAt ??= clock.now();
          channel.speech.push(frame);
        }
      }
    } catch (error) {
      log("audio stream failed", { error });
    }
  }

  function finish(owner: ActiveTurn<F> | null) {
    if (!owner || owner.finished) return;
    owner.finished = true;
    const work = (async () => {
      await Promise.allSettled(owner.channels.map((c) => c.speech.finish()));
      await Promise.allSettled(owner.channels.map((c) => c.reading));
      const timer = captionTimers.get(owner);
      if (timer !== undefined) clock.clearTimeout(timer);
      captionTimers.delete(owner);
      lastCaption.delete(owner);
      kick();
    })().finally(() => finishing.delete(work));
    finishing.add(work);
  }

  function schedulePreopen() {
    if (preopenTimer !== undefined) clock.clearTimeout(preopenTimer);
    preopenTimer = undefined;
    if (!turn?.running || turn.deadlineAt === null) return;
    const next = {
      turnNumber: turn.turnNumber + 1,
      side: (turn.side === "A" ? "B" : "A") as Side,
    };
    preopenTimer = clock.setTimeout(
      () => {
        preopenTimer = undefined;
        if (stopped || prepared || active?.turnNumber === next.turnNumber)
          return;
        prepared = open(next.turnNumber, next.side);
      },
      Math.max(0, turn.deadlineAt - PREOPEN_MS - clock.now()),
    );
  }

  function enqueue(turnNumber: number, segment: TranscriptSegment) {
    queue.push({ turnNumber, segment });
    if (queue.length > QUEUE_MAX) {
      queue.splice(0, queue.length - QUEUE_MAX);
      log("transcript queue full; oldest segments dropped");
    }
    kick();
  }

  function kick() {
    if (sending || !queue.length) return;
    const wait = Math.max(0, lastSent + SEND_SPACING_MS - clock.now());
    sending = new Promise<void>((resolve) => {
      clock.setTimeout(() => void flushOnce().finally(resolve), wait);
    }).finally(() => {
      sending = null;
      if (queue.length && !stopped) kick();
    });
  }

  async function flushOnce() {
    const first = queue[0];
    if (!first) return;
    let count = 0;
    while (
      count < queue.length &&
      count < SEGMENTS_PER_UPDATE_MAX &&
      queue[count]!.turnNumber === first.turnNumber
    )
      count++;
    const batch = queue.slice(0, count);
    const update: TranscriptUpdate = {
      jobId,
      sequence,
      turnNumber: first.turnNumber,
      sentAt: clock.now(),
      segments: batch.map((item) => item.segment),
    };
    lastSent = clock.now();
    let answer: IngestAnswer;
    try {
      answer = await send(update);
    } catch (error) {
      // Network failure after retries: keep the batch and the sequence, so
      // the identical update is retried next time.
      log("transcript update failed; retrying", { error });
      lastSent = clock.now() + 2000;
      return;
    }
    if (answer.status === 429) {
      lastSent = clock.now() + 1000;
      return;
    }
    sequence++;
    queue.splice(0, count);
    if (answer.status === 403) {
      const side = first.segment.side;
      const speaker = speakers.get(side);
      if (speaker) speakers.set(side, { ...speaker, consented: false });
      for (let index = queue.length - 1; index >= 0; index--)
        if (queue[index]!.segment.side === side) queue.splice(index, 1);
      if (active?.side === side) {
        finish(active);
        active = null;
        follow(null);
      }
    }
    if (answer.status !== 200)
      log("transcript update refused", {
        status: answer.status,
        body: answer.body,
      });
  }

  return Object.freeze({
    setSpeakers(list: readonly Speaker[]) {
      for (const speaker of list) speakers.set(speaker.side, speaker);
    },
    /** Applies the latest turn (from room metadata or the server's state). */
    setTurn(next: TurnState | null) {
      if (stopped) return;
      const previous = turn;
      turn = next;
      const changed =
        !next ||
        !previous ||
        next.turnNumber !== previous.turnNumber ||
        next.running !== previous.running;
      if (changed) {
        if (
          active &&
          (!next || !next.running || active.turnNumber !== next.turnNumber)
        ) {
          finish(active);
          active = null;
        }
        if (next?.running && !active) {
          if (
            prepared?.turnNumber === next.turnNumber &&
            prepared.side === next.side
          ) {
            active = prepared;
            prepared = null;
          } else {
            finish(prepared);
            prepared = null;
            active = open(next.turnNumber, next.side);
          }
        }
        follow(active ? active.side : null);
      }
      schedulePreopen();
    },
    /** The host's subscription to a side's microphone started or ended. */
    setAudio(side: Side, audio: AudioSource<F> | null) {
      if (!active || active.side !== side) return;
      if (active.audio === audio) return;
      active.audio = audio;
      if (audio) void pump(active, audio);
    },
    /** Flushes the turn in progress and sends what is queued (bounded). */
    async stop(timeoutMs = 10_000) {
      if (stopped) return;
      finish(active);
      finish(prepared);
      active = null;
      prepared = null;
      if (preopenTimer !== undefined) clock.clearTimeout(preopenTimer);
      follow(null);
      const deadline = clock.now() + timeoutMs;
      await Promise.allSettled([...finishing]);
      while (queue.length && clock.now() < deadline) {
        kick();
        await sending;
      }
      stopped = true;
    },
    get sequence() {
      return sequence;
    },
    get queued() {
      return queue.length;
    },
  });
}
