import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { createOutlineLoop } from "../dist-transcriber/features/transcription/agent/outline-loop.js";
import {
  EDIT_SCHEMA,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  SYSTEM_PROMPT,
  createLiveOutliner,
  parseEdits,
} from "../dist-transcriber/features/transcription/agent/claude.js";
import { createTurnTranscriber } from "../dist-transcriber/features/transcription/agent/transcriber.js";

// Decision 0012: the agent's live outline loop and its Claude call, with a
// manual clock and fake model, server and LiveKit.

function clock(start = 1_793_000_000_000) {
  let now = start,
    id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      timers.set(++id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const add = (text) => ({
  op: "add_argument",
  argument: null,
  point: null,
  key: null,
  text,
  target: null,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture({ results = [] } = {}) {
  const time = clock(),
    calls = [],
    submitted = [],
    published = [];
  let version = 0;
  const loop = createOutlineLoop({
    debateId: "d",
    proposition: "Faut-il garder le nucléaire ?",
    async call(request) {
      calls.push(request);
      const next = results.shift();
      if (next instanceof Promise) return next;
      return (
        next ?? {
          kind: "edits",
          edits: [add(request.newText.slice(0, 40))],
          model: "m",
        }
      );
    },
    async submit(turnNumber, proposal) {
      submitted.push({ turnNumber, proposal });
      version++;
      return {
        accepted: true,
        version,
        turnNumber,
        side: "A",
        language: "fr",
        edits: [
          {
            op: "add_argument",
            id: `t${turnNumber}a${version}`,
            label: proposal.edits[0].text,
            span: proposal.span,
          },
        ],
        rejected: 0,
      };
    },
    async publish(message) {
      published.push(message);
    },
    clock: time,
  });
  return { time, loop, calls, submitted, published };
}
const chunk = (time, text, ago = 500) => ({
  text,
  startAt: time.now() - ago - 1000,
  endAt: time.now() - ago,
});

describe("live outline loop", () => {
  it("calls at most once per interval, accumulates text and never queues calls", async () => {
    const pending = deferred();
    const f = fixture({ results: [pending.promise] });
    await f.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: f.time.now(),
    });
    f.loop.addFinal(1, chunk(f.time, "Première phrase."));
    await settle();
    assert.equal(f.calls.length, 1);
    f.loop.addFinal(1, chunk(f.time, "Deuxième phrase."));
    f.loop.addFinal(1, chunk(f.time, "Troisième phrase."));
    await f.time.advance(5000);
    assert.equal(f.calls.length, 1, "one call in flight");
    pending.resolve({ kind: "edits", edits: [add("Un")], model: "m" });
    await f.time.advance(0);
    assert.equal(
      f.calls.length,
      2,
      "the next call starts once the first returns",
    );
    assert.equal(f.calls[1].newText, "Deuxième phrase. Troisième phrase.");
    assert.equal(f.calls[1].context, "Première phrase.");
    f.loop.addFinal(1, chunk(f.time, "Quatrième."));
    await f.time.advance(2999);
    assert.equal(f.calls.length, 2, "at least three seconds between starts");
    await f.time.advance(1);
    assert.equal(f.calls.length, 3);
    assert.equal(f.published.length, 3);
    assert.deepEqual(
      f.published.map((m) => m.version),
      [1, 2, 3],
    );
    assert.equal(f.published[0].type, "edits");
    assert.equal(f.loop.version, 3);
    assert.equal(f.loop.outline.arguments.length, 3);
    assert.deepEqual(f.submitted[0].proposal.span, { startMs: 0, endMs: 0 });
  });

  it("keeps skipped text for the next call and flushes once at turn end", async () => {
    const f = fixture({
      results: [{ kind: "skip", reason: "timeout" }],
    });
    await f.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: f.time.now() - 10_000,
    });
    f.loop.addFinal(1, chunk(f.time, "Texte ignoré."));
    await settle();
    f.loop.addFinal(1, chunk(f.time, "Suite."));
    // The next turn's finals can arrive before this turn is flushed.
    f.loop.addFinal(2, chunk(f.time, "Nouveau tour."));
    await f.loop.startTurn({
      turnNumber: 2,
      side: "B",
      language: "en",
      startedAt: f.time.now(),
    });
    assert.equal(f.calls[1].newText, "Texte ignoré. Suite.", "the flush");
    assert.equal(f.submitted[0].turnNumber, 1);
    assert.ok(f.submitted[0].proposal.span.startMs > 0);
    await f.time.advance(3000);
    assert.equal(f.calls.at(-1).newText, "Nouveau tour.");
    assert.equal(f.calls.at(-1).language, "en");
    assert.deepEqual(
      f.loop.map.map((entry) => [entry.id, entry.turnNumber]),
      [["t1a1", 1]],
      "the finished turn joins the debate map",
    );
    await f.loop.stop();
    f.loop.addFinal(2, chunk(f.time, "Après l'arrêt."));
    await f.time.advance(10_000);
    assert.equal(f.calls.length, 3, "nothing runs after stop");
  });

  it("resynchronizes on a stale answer and resumes a restarted job's turn", async () => {
    const time = clock();
    const stored = {
      turnNumber: 4,
      side: "A",
      language: "fr",
      arguments: [
        {
          id: "t4a1",
          label: "Déjà là",
          span: { startMs: 0, endMs: 1 },
          points: [],
          lastPoint: 0,
          rebuts: null,
        },
      ],
    };
    const answers = [
      { accepted: false, reason: "stale", version: 9, turn: stored },
      null,
    ];
    const loop = createOutlineLoop({
      debateId: "d",
      proposition: "p",
      call: async () => ({ kind: "edits", edits: [add("x")], model: "m" }),
      submit: async () => answers.shift(),
      publish: async () => assert.fail("nothing is published"),
      clock: time,
    });
    loop.resume({ version: 7, turn: stored, map: [] });
    await loop.startTurn({
      turnNumber: 4,
      side: "A",
      language: "fr",
      startedAt: time.now(),
    });
    assert.equal(loop.outline.arguments[0].label, "Déjà là");
    loop.addFinal(4, chunk(time, "a"));
    await time.advance(0);
    assert.equal(loop.version, 9);
    loop.addFinal(4, chunk(time, "b"));
    await time.advance(3000);
    assert.equal(loop.version, 9, "a refused submission changes nothing");
  });
});

describe("live outline call", () => {
  function fakeClient(answer) {
    const requests = [];
    return {
      requests,
      client: {
        messages: {
          async create(body, options) {
            requests.push({ body, options });
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      },
    };
  }
  const request = {
    proposition: "Faut-il garder le nucléaire ?",
    map: [{ id: "t1a1", turnNumber: 1, side: "B", label: "Les renouvelables" }],
    outline: {
      turnNumber: 2,
      side: "A",
      language: "fr",
      arguments: [
        {
          id: "t2a1",
          label: "Le nucléaire",
          span: { startMs: 0, endMs: 1 },
          points: [
            { id: "t2a1p1", text: "Stable", span: { startMs: 0, endMs: 1 } },
          ],
          lastPoint: 1,
          rebuts: "t1a1",
        },
      ],
    },
    newText: "Et il est bas carbone.",
    context: "Le nucléaire est stable.",
    language: "fr",
  };
  const message = (stopReason, text) => ({
    stop_reason: stopReason,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      cache_read_input_tokens: 1400,
      cache_creation_input_tokens: 0,
    },
  });

  it("asks Claude Haiku 5.5 for strict JSON edits at the lowest latency", async () => {
    const logs = [];
    const fake = fakeClient(
      message("end_turn", JSON.stringify({ edits: [add("Bas carbone")] })),
    );
    const result = await createLiveOutliner({
      client: fake.client,
      log: (m, d) => logs.push([m, d]),
    })(request);
    assert.deepEqual(result, {
      kind: "edits",
      edits: [add("Bas carbone")],
      model: LIVE_MODEL,
    });
    const { body, options } = fake.requests[0];
    assert.equal(body.model, "claude-haiku-5-5");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.output_config.effort, "low");
    assert.deepEqual(body.output_config.format, {
      type: "json_schema",
      schema: EDIT_SCHEMA,
    });
    assert.ok(body.max_tokens <= 1000);
    assert.equal("temperature" in body, false);
    assert.deepEqual(options, { timeout: LIVE_TIMEOUT_MS, maxRetries: 0 });
    // Stable instructions, then the debate prefix, both cached; then the
    // volatile part with no cache marker.
    assert.equal(body.system[0].text, SYSTEM_PROMPT);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    const [prefix, volatile] = body.messages[0].content;
    assert.match(prefix.text, /Faut-il garder le nucléaire/);
    assert.match(prefix.text, /t1a1 \(turn 1, side B\): Les renouvelables/);
    assert.deepEqual(prefix.cache_control, { type: "ephemeral" });
    assert.equal(volatile.cache_control, undefined);
    assert.match(volatile.text, /t2a1 "Le nucléaire" \(rebuts t1a1\)/);
    assert.match(volatile.text, /t2a1p1 "Stable"/);
    assert.match(volatile.text, /in French/);
    assert.match(volatile.text, /Et il est bas carbone/);
    assert.equal(logs[0][1].cacheReadTokens, 1400);
    // The instructions are long enough for Claude Haiku 5.5 to cache (512
    // tokens); about four characters per token is a conservative estimate.
    assert.ok(SYSTEM_PROMPT.length / 4 > 600);
    assert.match(SYSTEM_PROMPT, /French/);
    assert.match(SYSTEM_PROMPT, /Exemple|Example 3 \(French\)/);
  });

  it("skips refusals, truncation, invalid JSON, timeouts and errors", async () => {
    const cases = [
      [message("refusal", ""), "refusal"],
      [message("max_tokens", '{"edits":['), "invalid"],
      [message("end_turn", "not json"), "invalid"],
      [new Anthropic.APIConnectionTimeoutError(), "timeout"],
      [new Error("boom"), "error"],
    ];
    for (const [answer, reason] of cases) {
      const fake = fakeClient(answer);
      assert.deepEqual(
        await createLiveOutliner({ client: fake.client })(request),
        {
          kind: "skip",
          reason,
        },
      );
    }
  });

  it("validates the model's edits", () => {
    assert.deepEqual(parseEdits('{"edits":[]}'), []);
    assert.equal(parseEdits('{"edits":[{"op":"explode"}]}'), null);
    assert.equal(parseEdits('{"edits":"x"}'), null);
    assert.equal(parseEdits("[1]"), null);
    assert.equal(parseEdits('{"edits":[null]}'), null);
    assert.equal(
      parseEdits(
        JSON.stringify({ edits: Array.from({ length: 12 }, () => add("x")) }),
      ).length,
      8,
    );
    assert.deepEqual(
      parseEdits('{"edits":[{"op":"remove_point","point":7}]}'),
      [
        {
          op: "remove_point",
          argument: null,
          point: null,
          key: null,
          text: null,
          target: null,
        },
      ],
    );
  });
});

describe("outline proposals in the transcript sender", () => {
  function engine() {
    const opened = [];
    return {
      provider: "deepgram",
      opened,
      open() {
        const items = [],
          waiters = [];
        let ended = false;
        const channel = {
          push() {},
          async finish() {
            ended = true;
            for (const w of waiters.splice(0))
              w({ value: undefined, done: true });
          },
          close() {},
          emit(item) {
            const w = waiters.shift();
            if (w) w({ value: item, done: false });
            else items.push(item);
          },
          updates: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                items.length
                  ? Promise.resolve({ value: items.shift(), done: false })
                  : ended
                    ? Promise.resolve({ value: undefined, done: true })
                    : new Promise((r) => waiters.push(r)),
            }),
          },
        };
        opened.push(channel);
        return channel;
      },
    };
  }

  it("sends a proposal with the segments before it, and retries the exact batch", async () => {
    const time = clock(),
      sent = [],
      hooks = { finals: [], turns: [], flushes: 0 };
    const answers = [
      new Error("offline"),
      {
        status: 200,
        body: { accepted: true, outline: { accepted: true, version: 1 } },
      },
    ];
    const primary = engine();
    const transcriber = createTurnTranscriber({
      primary,
      jobId: "AJ",
      nextSequence: 0,
      async send(update) {
        sent.push(structuredClone(update));
        const answer = answers.shift() ?? { status: 200, body: {} };
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async captions() {},
      follow() {},
      clock: time,
      outline: {
        async startTurn(turn) {
          hooks.turns.push(turn.turnNumber);
        },
        addFinal(turnNumber, piece) {
          hooks.finals.push([turnNumber, piece.text]);
        },
        async flush() {
          hooks.flushes++;
        },
        async stop() {
          hooks.stops = (hooks.stops ?? 0) + 1;
        },
      },
    });
    transcriber.setSpeakers([
      { side: "A", language: "fr", consented: true },
      { side: "B", language: "en", consented: true },
    ]);
    transcriber.setTurn({
      turnNumber: 1,
      side: "A",
      deadlineAt: time.now() + 60_000,
      running: true,
    });
    await settle();
    assert.deepEqual(hooks.turns, [1]);
    const frames = {
      [Symbol.asyncIterator]: () => {
        let sentFrame = false;
        return {
          next: () =>
            sentFrame
              ? new Promise(() => {})
              : ((sentFrame = true),
                Promise.resolve({ value: "f", done: false })),
        };
      },
    };
    transcriber.setAudio("A", { frames, trackId: "TR", identity: "speaker-1" });
    await settle();
    primary.opened[0].emit({
      kind: "final",
      text: "Phrase.",
      startTime: 0,
      endTime: 1,
      words: [],
    });
    await settle();
    assert.deepEqual(hooks.finals, [[1, "Phrase."]]);
    const answered = transcriber.proposeOutline(1, {
      baseVersion: 0,
      span: { startMs: 0, endMs: 1000 },
      edits: [add("x")],
      model: "m",
    });
    await time.advance(5000);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].segments, sent[1].segments, "the same batch");
    assert.equal(sent[0].sequence, sent[1].sequence);
    assert.equal(sent[1].segments.length, 1);
    assert.equal(sent[1].outline.baseVersion, 0);
    assert.deepEqual(await answered, { accepted: true, version: 1 });
    transcriber.setTurn({
      turnNumber: 2,
      side: "B",
      deadlineAt: time.now() + 60_000,
      running: true,
    });
    await time.advance(100);
    assert.deepEqual(hooks.turns, [1, 2], "after the ending turn's finals");
    await transcriber.stop();
    assert.ok(hooks.flushes >= 1);
    assert.equal(hooks.stops, 1, "the outline's last turn is finished");
    assert.equal(
      await transcriber.proposeOutline(2, {
        baseVersion: 1,
        span: { startMs: 0, endMs: 1 },
        edits: [],
        model: "m",
      }),
      null,
      "nothing is accepted after stop",
    );
  });

  it("cleans the debate's last turn when the transcriber stops", async () => {
    const time = clock(),
      cleaned = [],
      submitted = [],
      published = [];
    const loop = createOutlineLoop({
      debateId: "d",
      proposition: "P",
      call: async () => ({ kind: "skip", reason: "invalid" }),
      submit: async () => null,
      publish: async (message) => published.push(message.type),
      clock: time,
      clean: async (request) => {
        cleaned.push(request.outline.turnNumber);
        return { kind: "cleanup", arguments: [], model: "claude-sonnet-5-5" };
      },
      submitCleanup: async (turnNumber) => {
        submitted.push(turnNumber);
        return {
          status: 201,
          body: {
            accepted: true,
            turn: { turnNumber, side: "B", arguments: [] },
          },
        };
      },
    });
    const primary = engine();
    const transcriber = createTurnTranscriber({
      primary,
      jobId: "AJ",
      nextSequence: 0,
      send: async () => ({ status: 200, body: {} }),
      async captions() {},
      follow() {},
      clock: time,
      outline: loop,
    });
    transcriber.setSpeakers([{ side: "B", language: "en", consented: true }]);
    transcriber.setTurn({
      turnNumber: 10,
      side: "B",
      deadlineAt: time.now() + 60_000,
      running: true,
    });
    await settle();
    let fed = false;
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          fed
            ? new Promise(() => {})
            : ((fed = true), Promise.resolve({ value: "f", done: false })),
      }),
    };
    transcriber.setAudio("B", { frames, trackId: "TR", identity: "speaker-2" });
    await settle();
    primary.opened[0].emit({
      kind: "final",
      text: "Last words.",
      startTime: 0,
      endTime: 1,
      words: [],
    });
    await settle();
    assert.deepEqual(cleaned, [], "no next turn has finished it");
    const stopping = transcriber.stop();
    await time.advance(10_000);
    await stopping;
    assert.deepEqual(cleaned, [10]);
    assert.deepEqual(submitted, [10]);
    assert.deepEqual(published, ["final"]);
  });
});
