import {
  applyEdits,
  emptyTurn,
  type OutlineLanguage,
  type OutlineSide,
  type ProposedEdit,
  type TurnOutline,
} from "../../outline/reducer.ts";
import type {
  OutlineAnswer,
  OutlineMessage,
  OutlineProposal,
} from "../protocol.ts";
import type { CleanupArgument } from "../../outline/cleanup.ts";
import type { FinalMessage, TurnSummary } from "../../outline/public-types.ts";
import type { CleanupRequest, CleanupResult } from "./cleanup.ts";

// Decision 0012: the live outline loop, independent of LiveKit and of where it
// runs, so it can move to the server later. Inputs: final transcript chunks,
// the stored outline and a clock. Outputs: one model call at a time, the
// server-accepted edits, and the message viewers apply.
//
// Scheduling: a final chunk triggers a call when none is in flight and at
// least `minIntervalMs` passed since the last call started; otherwise one call
// is scheduled for when both hold. New text accumulates meanwhile; there is
// never a backlog of calls. A turn's end triggers one last call (the flush).

export interface MapEntry {
  id: string;
  turnNumber: number;
  side: OutlineSide;
  label: string;
}
export interface OutlineRequest {
  proposition: string;
  map: readonly MapEntry[];
  outline: TurnOutline;
  /** Text not yet summarized. */
  newText: string;
  /** Recently summarized text, for context (about the last 20 s). */
  context: string;
  language: OutlineLanguage;
}
export type CallResult =
  | { kind: "edits"; edits: ProposedEdit[]; model: string }
  | { kind: "skip"; reason: "refusal" | "timeout" | "invalid" | "error" };
interface Chunk {
  text: string;
  startAt: number;
  endAt: number;
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
const isTurnSummary = (value: unknown): value is TurnSummary => {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<TurnSummary>;
  return (
    Number.isSafeInteger(turn.turnNumber) &&
    (turn.side === "A" || turn.side === "B") &&
    Array.isArray(turn.arguments) &&
    turn.arguments.every(
      (item) => typeof item?.id === "string" && typeof item.label === "string",
    )
  );
};
/** Unsummarized text beyond this many characters keeps only its end. */
export const PENDING_MAX_CHARS = 4000;
/** The cleanup reads at most this much of the turn's transcript (its end). */
export const TRANSCRIPT_MAX_CHARS = 8000;
/** A window not frozen yet is retried this often, this many times. */
export const CLEANUP_RETRY_MS = 3000;
export const CLEANUP_ATTEMPTS = 8;

export function createOutlineLoop({
  debateId,
  proposition,
  call,
  submit,
  publish,
  minIntervalMs = 3000,
  contextMs = 20_000,
  clock = realClock,
  log = () => {},
  resync,
  clean,
  submitCleanup,
}: {
  debateId: string;
  proposition: string;
  call: (request: OutlineRequest) => Promise<CallResult>;
  /** Sends the proposal in order with the transcript; null when refused. */
  submit: (
    turnNumber: number,
    proposal: OutlineProposal,
  ) => Promise<OutlineAnswer | null>;
  publish: (message: OutlineMessage | FinalMessage) => Promise<void>;
  minIntervalMs?: number;
  contextMs?: number;
  clock?: Clock;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Reloads the server's state when the local outline disagrees with it. */
  resync?: () => Promise<{
    version: number;
    turn: TurnOutline | null;
    map: readonly MapEntry[];
  } | null>;
  /** The window cleanup (Claude Sonnet 5.5), once each turn has ended. */
  clean?: (request: CleanupRequest) => Promise<CleanupResult>;
  submitCleanup?: (
    turnNumber: number,
    model: string,
    items: CleanupArgument[],
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}) {
  let version = 0;
  let resumedTurn: TurnOutline | null = null;
  let map: MapEntry[] = [];
  let turn: {
    number: number;
    side: OutlineSide;
    language: OutlineLanguage;
    startedAt: number;
    outline: TurnOutline;
    pending: Chunk[];
    context: Chunk[];
    transcript: Chunk[];
  } | null = null;
  const cleanups = new Set<Promise<void>>();
  let running: Promise<void> | null = null;
  let lastStarted = -Infinity;
  let timer: unknown;
  // Finals of a turn that starts before the previous one finished flushing.
  const early = new Map<number, Chunk[]>();
  let stopped = false;

  function schedule() {
    if (stopped || !turn?.pending.length || running) return;
    const wait = lastStarted + minIntervalMs - clock.now();
    if (wait <= 0) {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      running = run().finally(() => {
        running = null;
        schedule();
      });
    } else if (timer === undefined)
      timer = clock.setTimeout(() => {
        timer = undefined;
        schedule();
      }, wait);
  }

  async function run() {
    const current = turn;
    if (!current?.pending.length) return;
    lastStarted = clock.now();
    const chunks = current.pending.splice(0);
    const cutoff = clock.now() - contextMs;
    current.context = current.context.filter((chunk) => chunk.endAt >= cutoff);
    const result = await call({
      proposition,
      map,
      outline: current.outline,
      newText: chunks.map((chunk) => chunk.text).join(" "),
      context: current.context.map((chunk) => chunk.text).join(" "),
      language: current.language,
    }).catch((error: unknown): CallResult => {
      log("outline call failed", { error });
      return { kind: "skip", reason: "error" };
    });
    if (result.kind === "skip") {
      // Skipped text is summarized with the next text, not lost.
      current.pending.unshift(...chunks);
      trim(current.pending);
      log("outline call skipped", { reason: result.reason });
      return;
    }
    current.context.push(...chunks);
    if (!result.edits.length || turn !== current) return;
    const span = {
      startMs: Math.max(
        0,
        Math.min(...chunks.map((c) => c.startAt)) - current.startedAt,
      ),
      endMs: Math.max(
        0,
        Math.max(...chunks.map((c) => c.endAt)) - current.startedAt,
      ),
    };
    const answer = await submit(current.number, {
      baseVersion: version,
      span: {
        startMs: span.startMs,
        endMs: Math.max(span.startMs, span.endMs),
      },
      edits: result.edits,
      model: result.model,
    }).catch((error: unknown) => {
      log("outline submit failed", { error });
      return null;
    });
    if (!answer) return;
    if (!answer.accepted) {
      // Stale: another version won; resynchronize and summarize anew next time.
      version = answer.version;
      if (answer.turn && answer.turn.turnNumber === current.number)
        current.outline = answer.turn;
      return;
    }
    version = answer.version;
    try {
      current.outline = applyEdits(current.outline, answer.edits);
    } catch {
      // The local copy disagrees with the server's: reload it.
      const state = await resync?.().catch(() => null);
      if (state) adopt(state);
    }
    await publish({
      v: 1,
      type: "edits",
      debateId,
      version: answer.version,
      turnNumber: answer.turnNumber,
      side: answer.side,
      language: answer.language,
      edits: answer.edits,
    }).catch((error: unknown) => log("outline publish failed", { error }));
  }

  function adopt(state: {
    version: number;
    turn: TurnOutline | null;
    map: readonly MapEntry[];
  }) {
    version = state.version;
    map = [...state.map];
    resumedTurn = state.turn;
    if (turn && state.turn?.turnNumber === turn.number)
      turn.outline = state.turn;
  }

  function trim(chunks: Chunk[], max = PENDING_MAX_CHARS) {
    let total = chunks.reduce((sum, chunk) => sum + chunk.text.length + 1, 0);
    while (total > max && chunks.length > 1)
      total -= chunks.shift()!.text.length + 1;
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => clock.setTimeout(resolve, ms));

  // After a turn's last live call: the cleanup rewrites it and, once the
  // server accepts it as the window's final outline, viewers get it too.
  async function cleanUp(finished: NonNullable<typeof turn>) {
    if (!clean || !submitCleanup || !finished.transcript.length) return;
    const result = await clean({
      proposition,
      map: map.filter((entry) => entry.turnNumber < finished.number),
      outline: finished.outline,
      transcript: finished.transcript.map((chunk) => chunk.text).join(" "),
    }).catch((error: unknown): CleanupResult => {
      log("window cleanup failed", { error });
      return { kind: "skip", reason: "error" };
    });
    if (result.kind === "skip") {
      log("window cleanup skipped", { reason: result.reason });
      return;
    }
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      const answer = await submitCleanup(
        finished.number,
        result.model,
        result.arguments,
      ).catch((error: unknown) => {
        log("window cleanup submit failed", { error });
        return null;
      });
      if (!answer) return;
      if (answer.status === 201) {
        const final = answer.body.turn;
        if (!isTurnSummary(final)) return;
        map = [
          ...map.filter((entry) => entry.turnNumber !== final.turnNumber),
          ...final.arguments.map((item) => ({
            id: item.id,
            turnNumber: final.turnNumber,
            side: final.side,
            label: item.label,
          })),
        ];
        await publish({ v: 1, type: "final", debateId, turn: final }).catch(
          (error: unknown) => log("final outline publish failed", { error }),
        );
        return;
      }
      // The jobs loop freezes the window within a second of its cutoff; a
      // turn that ended early waits for its window's own cutoff.
      if (answer.status !== 409 || answer.body.reason !== "not_frozen") {
        log("window cleanup refused", {
          status: answer.status,
          reason: answer.body.reason,
        });
        return;
      }
      await sleep(CLEANUP_RETRY_MS);
    }
    log("window cleanup gave up", { turnNumber: finished.number });
  }
  function finish(finished: NonNullable<typeof turn>) {
    const task = cleanUp(finished).finally(() => cleanups.delete(task));
    cleanups.add(task);
  }

  function remember(outline: TurnOutline) {
    map = [
      ...map.filter((entry) => entry.turnNumber !== outline.turnNumber),
      ...outline.arguments.map((item) => ({
        id: item.id,
        turnNumber: outline.turnNumber,
        side: outline.side,
        label: item.label,
      })),
    ];
  }

  /** Waits for the call in flight, then makes the turn's last call. */
  async function flush() {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    while (running) await running;
    if (turn?.pending.length) {
      running = run().finally(() => {
        running = null;
      });
      await running;
    }
  }

  return Object.freeze({
    /** A (re)starting job adopts the server's state. */
    resume: adopt,
    /** A new turn begins: the previous one is flushed first. */
    async startTurn(next: {
      turnNumber: number;
      side: OutlineSide;
      language: OutlineLanguage;
      startedAt: number;
      outline?: TurnOutline | null;
    }) {
      if (turn?.number === next.turnNumber) return;
      await flush();
      if (turn) {
        remember(turn.outline);
        finish(turn);
      }
      turn = {
        number: next.turnNumber,
        side: next.side,
        language: next.language,
        startedAt: next.startedAt,
        outline:
          next.outline ??
          (resumedTurn?.turnNumber === next.turnNumber
            ? resumedTurn
            : emptyTurn(next.turnNumber, next.side, next.language)),
        pending: early.get(next.turnNumber) ?? [],
        context: [],
        transcript: [...(early.get(next.turnNumber) ?? [])],
      };
      for (const number of [...early.keys()])
        if (number <= next.turnNumber) early.delete(number);
      schedule();
    },
    /** A final transcript chunk of the current turn. */
    addFinal(turnNumber: number, chunk: Chunk) {
      if (!chunk.text.trim()) return;
      if (!turn || turnNumber > turn.number) {
        const chunks = early.get(turnNumber) ?? [];
        chunks.push(chunk);
        trim(chunks);
        early.set(turnNumber, chunks);
        return;
      }
      if (turn.number !== turnNumber) return;
      turn.pending.push(chunk);
      trim(turn.pending);
      turn.transcript.push(chunk);
      trim(turn.transcript, TRANSCRIPT_MAX_CHARS);
      schedule();
    },
    flush,
    /** Flushes the last turn and waits for every cleanup still running. */
    async stop() {
      await flush();
      stopped = true;
      if (turn) {
        remember(turn.outline);
        finish(turn);
        turn = null;
      }
      while (cleanups.size) await Promise.all([...cleanups]);
    },
    get version() {
      return version;
    },
    get outline() {
      return turn?.outline ?? null;
    },
    get map() {
      return map;
    },
  });
}
export type OutlineLoop = ReturnType<typeof createOutlineLoop>;
