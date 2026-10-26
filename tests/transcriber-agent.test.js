import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTurnTranscriber,
  PREOPEN_MS,
} from "../dist-transcriber/features/transcription/agent/transcriber.js";
import { loadAgentConfig } from "../dist-transcriber/features/transcription/agent/config.js";
import { createIngestClient } from "../dist-transcriber/features/transcription/agent/ingest-client.js";
import {
  hintFromSession,
  parseTurnHint,
  turnFromHint,
} from "../dist-transcriber/features/transcription/agent/turns.js";
import { verifyIngest } from "../dist/features/transcription/protocol.js";

// Decision 0012: the transcriber agent's core, with fake speech engines,
// audio and a manual clock. No LiveKit server or provider is involved.

function queue() {
  const items = [],
    waiters = [];
  let ended = false;
  return {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else items.push(item);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0))
        waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          items.length
            ? Promise.resolve({ value: items.shift(), done: false })
            : ended
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => waiters.push(resolve)),
      };
    },
  };
}
function engine(provider) {
  const opened = [];
  return {
    provider,
    opened,
    open(language) {
      const updates = queue();
      const channel = {
        language,
        frames: [],
        finished: false,
        closed: false,
        updates,
        push(frame) {
          channel.frames.push(frame);
        },
        async finish() {
          channel.finished = true;
          updates.end();
        },
        close() {
          channel.closed = true;
          updates.end();
        },
        emit(update) {
          updates.push(update);
        },
      };
      opened.push(channel);
      return channel;
    },
  };
}
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
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function audio(identity = "speaker-7", trackId = "TR_mic") {
  const frames = queue();
  return { frames, trackId, identity };
}
const speakers = [
  { side: "A", language: "fr", consented: true },
  { side: "B", language: "en", consented: true },
];
function fixture({ shadow = false, answers = [], list = speakers } = {}) {
  const time = clock(),
    primary = engine("deepgram"),
    second = shadow ? engine("elevenlabs") : undefined,
    sent = [],
    captions = [],
    follows = [];
  const transcriber = createTurnTranscriber({
    primary,
    shadow: second,
    jobId: "AJ_test",
    nextSequence: 3,
    async send(update) {
      sent.push(structuredClone(update));
      const answer = answers.shift() ?? { status: 200, body: {} };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async captions(update) {
      captions.push(update);
    },
    follow: (side) => follows.push(side),
    captionsPerSecond: 4,
    clock: time,
  });
  transcriber.setSpeakers(list);
  return { time, primary, second, sent, captions, follows, transcriber };
}
const turn = (turnNumber, side, time, running = true) => ({
  turnNumber,
  side,
  deadlineAt: time.now() + 60_000,
  running,
});
const final = (text, startTime, endTime, words = []) => ({
  kind: "final",
  text,
  startTime,
  endTime,
  words,
});

describe("transcriber agent core", () => {
  it("follows only the active speaker and sends their finals with word timings", async () => {
    const f = fixture();
    f.transcriber.setTurn(turn(1, "A", f.time));
    assert.deepEqual(f.follows, ["A"]);
    assert.equal(f.primary.opened.length, 1);
    const channel = f.primary.opened[0];
    assert.equal(channel.language, "fr");
    const mic = audio();
    f.transcriber.setAudio("B", audio("speaker-8"));
    f.transcriber.setAudio("A", mic);
    mic.frames.push("frame-1");
    await settle();
    assert.deepEqual(channel.frames, ["frame-1"]);
    await f.time.advance(2000);
    channel.emit(
      final(" Le nucléaire reste indispensable. ", 0.2, 1.8, [
        { text: "Le", startTime: 0.2, endTime: 0.35, confidence: 0.98 },
        { text: " ", startTime: 0.35, endTime: 0.4 },
        { text: "nucléaire", startTime: 0.4, endTime: 0.9 },
      ]),
    );
    await settle();
    await f.time.advance(1000);
    assert.equal(f.sent.length, 1);
    const [update] = f.sent;
    assert.equal(update.jobId, "AJ_test");
    assert.equal(update.sequence, 3);
    assert.equal(update.turnNumber, 1);
    const [segment] = update.segments;
    assert.equal(segment.text, "Le nucléaire reste indispensable.");
    assert.equal(segment.side, "A");
    assert.equal(segment.role, "primary");
    assert.equal(segment.language, "fr");
    const started = 1_793_000_000_000;
    assert.equal(segment.startAt, started + 200);
    assert.equal(segment.endAt, started + 1800);
    assert.deepEqual(segment.words, [
      { w: "Le", s: 0, e: 150, c: 0.98 },
      { w: "nucléaire", s: 200, e: 700 },
    ]);
    assert.equal(segment.audioMs, 1600);
    assert.equal(segment.latencyMs, 200);
    assert.equal(f.transcriber.sequence, 4);
    assert.deepEqual(
      f.captions.map((c) => [c.speaker, c.trackId, c.final, c.text]),
      [["speaker-7", "TR_mic", true, "Le nucléaire reste indispensable."]],
    );
  });

  it("throttles interim captions and lets the final replace them", async () => {
    const f = fixture();
    f.transcriber.setTurn(turn(1, "A", f.time));
    const mic = audio();
    f.transcriber.setAudio("A", mic);
    mic.frames.push("frame");
    await settle();
    const channel = f.primary.opened[0];
    for (const text of ["Le", "Le nu", "Le nucl", "Le nucléaire"])
      channel.emit({ kind: "interim", text });
    await settle();
    assert.deepEqual(
      f.captions.map((c) => c.text),
      ["Le"],
      "one interim per 250 ms",
    );
    await f.time.advance(250);
    assert.deepEqual(
      f.captions.map((c) => c.text),
      ["Le", "Le nucléaire"],
      "the latest pending interim wins",
    );
    channel.emit({ kind: "interim", text: "Le nucléaire est" });
    channel.emit(final("Le nucléaire est indispensable.", 0, 1));
    await settle();
    assert.deepEqual(f.captions.map((c) => [c.text, c.final]).slice(2), [
      ["Le nucléaire est indispensable.", true],
    ]);
    const ids = new Set(f.captions.map((c) => c.segmentId));
    assert.equal(ids.size, 1, "a segment's interims and final share an ID");
  });

  it("pre-opens the next speaker before the deadline and flushes the ending turn", async () => {
    const f = fixture();
    const first = turn(1, "A", f.time);
    f.transcriber.setTurn(first);
    await f.time.advance(60_000 - PREOPEN_MS - 1);
    assert.equal(f.primary.opened.length, 1);
    await f.time.advance(1);
    assert.equal(f.primary.opened.length, 2, "next speaker opened early");
    const [a, b] = f.primary.opened;
    assert.equal(b.language, "en");
    f.transcriber.setTurn(turn(2, "B", f.time));
    assert.equal(f.primary.opened.length, 2, "the prepared channel is used");
    assert.equal(a.finished, true);
    assert.equal(b.finished, false);
    assert.deepEqual(f.follows, ["A", "B"]);
    // A late final of the ended turn keeps its own turn number.
    const late = fixture();
    late.transcriber.setTurn(turn(1, "A", late.time));
    const mic = audio();
    late.transcriber.setAudio("A", mic);
    mic.frames.push("frame");
    await settle();
    const channel = late.primary.opened[0];
    channel.emit(final("Dernière phrase.", 0, 1));
    late.transcriber.setTurn(turn(2, "B", late.time));
    await settle();
    await late.time.advance(1000);
    assert.deepEqual(
      late.sent.map((u) => u.turnNumber),
      [1],
    );
  });

  it("transcribes nobody without consent and pauses with the turn", async () => {
    const f = fixture({
      list: [
        { side: "A", language: "fr", consented: false },
        { side: "B", language: null, consented: true },
      ],
    });
    f.transcriber.setTurn(turn(1, "A", f.time));
    f.transcriber.setTurn(turn(2, "B", f.time));
    assert.equal(f.primary.opened.length, 0);
    assert.deepEqual(f.follows, [null, null]);
    const g = fixture();
    g.transcriber.setTurn(turn(1, "A", g.time));
    g.transcriber.setTurn(turn(1, "A", g.time, false));
    assert.equal(g.primary.opened[0].finished, true);
    g.transcriber.setTurn(turn(1, "A", g.time));
    assert.equal(g.primary.opened.length, 2, "a resumed turn reopens");
    assert.deepEqual(g.follows, ["A", null, "A"]);
  });

  it("stores shadow-provider segments without captions", async () => {
    const f = fixture({ shadow: true });
    f.transcriber.setTurn(turn(1, "A", f.time));
    const mic = audio();
    f.transcriber.setAudio("A", mic);
    mic.frames.push("frame");
    await settle();
    assert.deepEqual(f.second.opened[0].frames, ["frame"], "same audio");
    f.second.opened[0].emit({ kind: "interim", text: "Le" });
    f.second.opened[0].emit(final("Le nucléaire.", 0, 1));
    await settle();
    await f.time.advance(1000);
    assert.equal(f.captions.length, 0);
    assert.deepEqual(
      f.sent[0].segments.map((s) => [s.provider, s.role]),
      [["elevenlabs", "shadow"]],
    );
  });

  it("retries failures with the same sequence and acts on refusals", async () => {
    const f = fixture({
      answers: [
        new Error("network down"),
        { status: 429, body: {} },
        { status: 200, body: {} },
        { status: 403, body: { code: "consent_required" } },
      ],
    });
    f.transcriber.setTurn(turn(1, "A", f.time));
    const mic = audio();
    f.transcriber.setAudio("A", mic);
    mic.frames.push("frame");
    await settle();
    const channel = f.primary.opened[0];
    channel.emit(final("Première.", 0, 1));
    await settle();
    await f.time.advance(10_000);
    assert.deepEqual(
      f.sent.map((u) => u.sequence),
      [3, 3, 3],
      "the identical update is retried",
    );
    channel.emit(final("Deuxième.", 1, 2));
    await settle();
    await f.time.advance(2000);
    assert.equal(f.sent.at(-1).sequence, 4);
    assert.equal(channel.finished, true, "consent refused: stop the side");
    assert.equal(f.follows.at(-1), null);
    assert.equal(f.transcriber.queued, 0);
  });

  it("flushes and sends what is left when stopped", async () => {
    const f = fixture();
    f.transcriber.setTurn(turn(1, "A", f.time));
    const mic = audio();
    f.transcriber.setAudio("A", mic);
    mic.frames.push("frame");
    await settle();
    f.primary.opened[0].emit(final("Fin.", 0, 1));
    await settle();
    const stopping = f.transcriber.stop();
    await f.time.advance(1000);
    await stopping;
    assert.equal(f.sent.length, 1);
    assert.equal(f.primary.opened[0].finished, true);
    f.transcriber.setTurn(turn(2, "B", f.time));
    assert.equal(f.primary.opened.length, 1, "nothing opens after stop");
  });
});

describe("transcriber agent settings and protocol", () => {
  const environment = {
    YAPARENA_INGEST_URL: "https://staging.example.test",
    TRANSCRIPTION_INGEST_SECRET: "synthetic-transcription-ingest-secret-32b",
  };
  it("defaults to Deepgram and validates every setting", () => {
    const config = loadAgentConfig(environment);
    assert.equal(config.provider, "deepgram");
    assert.equal(config.shadowProvider, null);
    assert.equal(config.agentName, "yaparena-transcriber");
    assert.equal(config.captionsPerSecond, 4);
    assert.equal(
      loadAgentConfig({
        ...environment,
        YAPARENA_INGEST_URL: "http://localhost:3000",
        TRANSCRIPTION_SHADOW_PROVIDER: "elevenlabs",
        ELEVEN_API_KEY: "synthetic",
      }).shadowProvider,
      "elevenlabs",
    );
    for (const [change, message] of [
      [{ YAPARENA_INGEST_URL: "http://staging.example.test" }, /HTTPS origin/],
      [
        { YAPARENA_INGEST_URL: "https://staging.example.test/api" },
        /HTTPS origin/,
      ],
      [{ YAPARENA_INGEST_URL: "nope" }, /YapArena origin/],
      [{ TRANSCRIPTION_INGEST_SECRET: "short" }, /32 bytes/],
      [{ TRANSCRIPTION_PROVIDER: "whisper" }, /deepgram or elevenlabs/],
      [{ TRANSCRIPTION_SHADOW_PROVIDER: "deepgram" }, /must differ/],
      [{ TRANSCRIPTION_PROVIDER: "elevenlabs" }, /ELEVEN_API_KEY/],
      [{ CAPTION_UPDATES_PER_SECOND: "0" }, /from 1 to 10/],
      [{ TRANSCRIBER_AGENT_NAME: "Bad" }, /TRANSCRIBER_AGENT_NAME/],
    ])
      assert.throws(
        () => loadAgentConfig({ ...environment, ...change }),
        message,
      );
  });

  it("signs every ingest call and retries server errors with the same body", async () => {
    const calls = [];
    const answers = [
      new Response("busy", { status: 503 }),
      new Response(JSON.stringify({ accepted: true }), { status: 200 }),
      new Response(JSON.stringify({ debateId: "d" }), { status: 200 }),
      new Response("{}", { status: 404 }),
      new Response("not json", { status: 409 }),
    ];
    const client = createIngestClient({
      origin: new URL("https://staging.example.test"),
      secret: environment.TRANSCRIPTION_INGEST_SECRET,
      debateId: "33333333-3333-4333-8333-333333333333",
      now: () => 1_793_000_000_000,
      wait: async () => {},
      async fetch(url, init) {
        calls.push({ url: String(url), init });
        return answers.shift();
      },
    });
    const update = {
      jobId: "AJ",
      sequence: 0,
      turnNumber: 1,
      sentAt: 1,
      segments: [],
    };
    assert.deepEqual(await client.update(update), {
      status: 200,
      body: { accepted: true },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(
      calls[0].url,
      "https://staging.example.test/api/internal/transcription/debates/33333333-3333-4333-8333-333333333333/updates",
    );
    const headers = calls[0].init.headers;
    assert.equal(
      verifyIngest(
        environment.TRANSCRIPTION_INGEST_SECRET,
        headers["X-Yap-Timestamp"],
        headers["X-Yap-Signature"],
        calls[0].init.body,
        1_793_000_000_000,
      ),
      true,
    );
    assert.deepEqual(await client.session("AJ"), { debateId: "d" });
    assert.equal(await client.session("AJ"), null);
    assert.deepEqual(await client.update(update), { status: 409, body: {} });
    const failing = createIngestClient({
      origin: new URL("https://staging.example.test"),
      secret: environment.TRANSCRIPTION_INGEST_SECRET,
      debateId: "d",
      attempts: 2,
      wait: async () => {},
      async fetch() {
        throw new Error("offline");
      },
    });
    await assert.rejects(failing.update(update), /offline/);
  });

  it("reads the server's turn hint", () => {
    const hint = {
      v: 1,
      debateStatus: "live",
      mediaState: "running",
      turnNumber: 2,
      activeSide: "B",
      turnDeadlineAt: "2026-10-25T00:01:00.000Z",
    };
    assert.deepEqual(parseTurnHint(JSON.stringify(hint)), hint);
    for (const value of [undefined, "", "{", '{"v":2}', "null"])
      assert.equal(parseTurnHint(value), null);
    assert.deepEqual(turnFromHint(hint), {
      turnNumber: 2,
      side: "B",
      deadlineAt: Date.parse(hint.turnDeadlineAt),
      running: true,
    });
    assert.equal(
      turnFromHint({ ...hint, mediaState: "paused", turnDeadlineAt: null })
        .running,
      false,
    );
    assert.equal(turnFromHint({ ...hint, mediaState: "ended" }), null);
    assert.equal(turnFromHint({ ...hint, activeSide: null }), null);
    assert.deepEqual(
      hintFromSession({
        debateId: "d",
        debateStatus: "ready",
        media: null,
        serverNow: "",
        nextSequence: 0,
        speakers: [],
      }),
      {
        v: 1,
        debateStatus: "ready",
        mediaState: null,
        turnNumber: null,
        activeSide: null,
        turnDeadlineAt: null,
      },
    );
  });
});
