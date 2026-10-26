import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  parseCleanupArguments,
  resolveCleanup,
} from "../dist/features/outline/cleanup.js";
import { containsBlockedTerm } from "../dist/features/outline/moderation.js";
import {
  CLEANUP_ACCEPT_MS,
  ingestHeaders,
  parseOutlineCleanup,
  signIngest,
} from "../dist/features/transcription/protocol.js";
import { createTranscriptionIngestRouter } from "../dist/features/transcription/ingest-router.js";
import { createOutlineRouter } from "../dist/features/outline/router.js";
import {
  CLEANUP_BETA,
  CLEANUP_MODEL,
  CLEANUP_PROMPT,
  CLEANUP_SCHEMA,
  CLEANUP_TIMEOUT_MS,
  createWindowCleaner,
  parseCleanup,
} from "../dist-transcriber/features/transcription/agent/cleanup.js";
import {
  CLEANUP_ATTEMPTS,
  CLEANUP_RETRY_MS,
  createOutlineLoop,
} from "../dist-transcriber/features/transcription/agent/outline-loop.js";
import {
  applyFinal,
  createReplayIndex,
  emptyView,
  parseFinalMessage,
} from "../public/outline-state.js";
import { windowArgumentLabel } from "../public/arena-chart.js";

// Decision 0012, pull request 4: the window cleanup, final outlines, replay
// sync and correlation, without a database.

const span = (startMs, endMs) => ({ startMs, endMs });
const live = {
  turnNumber: 3,
  side: "A",
  language: "fr",
  arguments: [
    {
      id: "t3a1",
      label: "Le nucléaire est pilotable",
      span: span(1000, 9000),
      points: [
        {
          id: "t3a1p2",
          text: "Il produit à la demande",
          span: span(2000, 4000),
        },
      ],
      lastPoint: 2,
      rebuts: null,
    },
    {
      id: "t3a2",
      label: "Coûte cher",
      span: span(10000, 20000),
      points: [],
      lastPoint: 0,
      rebuts: null,
    },
  ],
};
const earlier = [
  { id: "t1a1", turnNumber: 1, side: "B", label: "x" },
  { id: "t2a1", turnNumber: 2, side: "A", label: "y" },
];
const item = (id, label, points = [], links = {}) => ({
  id,
  label,
  points,
  rebuts: null,
  continues: null,
  ...links,
});

describe("window cleanup resolution", () => {
  it("keeps live IDs and spans, numbers new items above them and links only backwards", () => {
    const resolved = resolveCleanup(
      live,
      [
        item(
          "t3a1",
          "  Le nucléaire est   pilotable et sûr ",
          ["Il produit à la demande", "Peu d'accidents"],
          { rebuts: "t1a1", continues: "t2a1" },
        ),
        item("t3a1", "Duplicate keeps a new ID"),
        item(null, "Les renouvelables ne suffisent pas", ["Pas l'hiver"], {
          rebuts: "t3a2",
          continues: "t1a1",
        }),
      ],
      earlier,
      (text) => !containsBlockedTerm(text),
    );
    assert.equal(resolved.dropped, 0);
    const [first, second, third] = resolved.outline.arguments;
    assert.equal(first.id, "t3a1");
    assert.equal(first.label, "Le nucléaire est pilotable et sûr");
    assert.deepEqual(first.span, span(1000, 9000));
    assert.deepEqual(
      first.points.map((point) => [point.id, point.text]),
      [
        ["t3a1p2", "Il produit à la demande"],
        ["t3a1p3", "Peu d'accidents"],
      ],
    );
    assert.equal(first.lastPoint, 3);
    assert.equal(first.rebuts, "t1a1");
    assert.equal(first.continues, "t2a1");
    assert.equal(second.id, "t3a3", "an ID is never used twice");
    assert.equal(third.id, "t3a4");
    assert.deepEqual(
      third.span,
      span(1000, 20000),
      "a new item spans the turn",
    );
    assert.equal(third.points[0].id, "t3a4p1");
    assert.equal(third.rebuts, null, "only earlier turns can be rebutted");
    assert.equal(third.continues, null, "continues needs the same side");
  });

  it("drops refused text, applies limits and gives up when nothing remains", () => {
    const accept = (text) => !containsBlockedTerm(text);
    const resolved = resolveCleanup(
      live,
      [
        item("t3a1", "Espèce d'idiot"),
        item("t3a2", "Coûte trop cher", ["idiot", "x".repeat(200), ""]),
        ...Array.from({ length: 6 }, (_, i) => item(null, `Argument ${i}`)),
      ],
      earlier,
      accept,
    );
    assert.equal(resolved.outline.arguments.length, 3, "four at most");
    assert.equal(resolved.dropped, 3);
    assert.equal(resolved.outline.arguments[0].points.length, 1);
    assert.ok(resolved.outline.arguments[0].points[0].text.length <= 120);
    assert.equal(resolveCleanup(live, [item(null, "idiot")], [], accept), null);
    assert.equal(
      resolveCleanup({ ...live, arguments: [] }, [item(null, "Seul")], [])
        .outline.arguments[0].span.endMs,
      0,
    );
  });

  it("validates the rewrite's shape in the protocol", () => {
    const valid = [item("t3a1", "Label", ["p"])];
    assert.deepEqual(parseCleanupArguments(valid), valid);
    for (const bad of [
      null,
      "x",
      Array.from({ length: 5 }, () => item(null, "l")),
      [null],
      [[]],
      [{ ...item(null, "l"), id: 3 }],
      [{ ...item(null, "l"), label: 1 }],
      [{ ...item(null, "x".repeat(1001)) }],
      [{ ...item(null, "l"), points: "p" }],
      [{ ...item(null, "l"), points: Array(7).fill("p") }],
      [{ ...item(null, "l"), points: [1] }],
      [{ ...item(null, "l"), rebuts: 1 }],
    ])
      assert.equal(parseCleanupArguments(bad), null, JSON.stringify(bad));
    const body = {
      jobId: "AJ_1",
      turnNumber: 3,
      model: "claude-sonnet-5-5",
      arguments: valid,
    };
    assert.deepEqual(parseOutlineCleanup(body), body);
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, jobId: "bad id" },
      { ...body, turnNumber: 0 },
      { ...body, model: "Sonnet!" },
      { ...body, arguments: [null] },
    ])
      assert.equal(parseOutlineCleanup(bad), null);
    assert.equal(CLEANUP_ACCEPT_MS, 60_000);
  });
});

describe("window cleanup call", () => {
  function client(answer) {
    const requests = [];
    return {
      requests,
      beta: {
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
  const message = (text, stop_reason = "end_turn", extra = []) => ({
    model: "claude-sonnet-5-5",
    stop_reason,
    content: [...extra, { type: "text", text }],
    usage: {
      input_tokens: 900,
      output_tokens: 80,
      cache_read_input_tokens: 700,
    },
  });
  const cleanupRequest = {
    proposition: "Faut-il garder le nucléaire ?",
    map: [{ id: "t1a1", turnNumber: 1, side: "B", label: "Trop cher" }],
    outline: live,
    transcript: "Le nucléaire est pilotable.",
  };

  it("asks Claude Sonnet 5.5 with the default refusal fallback and a strict schema", async () => {
    const answer = JSON.stringify({ arguments: [item("t3a1", "Pilotable")] });
    const fake = client(
      message(answer, "end_turn", [{ type: "fallback", from: {}, to: {} }]),
    );
    const logs = [];
    const clean = createWindowCleaner({
      client: fake,
      log: (text, detail) => logs.push([text, detail]),
      now: () => 0,
    });
    assert.deepEqual(await clean(cleanupRequest), {
      kind: "cleanup",
      arguments: [item("t3a1", "Pilotable")],
      model: "claude-sonnet-5-5",
    });
    const { body, options } = fake.requests[0];
    assert.equal(body.model, CLEANUP_MODEL);
    assert.deepEqual(body.betas, [CLEANUP_BETA]);
    assert.equal(body.fallbacks, "default");
    assert.equal(body.thinking, undefined, "adaptive thinking, never disabled");
    assert.equal(body.output_config.effort, "low");
    assert.deepEqual(body.output_config.format.schema, CLEANUP_SCHEMA);
    assert.equal(body.system[0].text, CLEANUP_PROMPT);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.match(body.messages[0].content[0].text, /t1a1 \(turn 1, side B\)/);
    assert.match(body.messages[0].content[1].text, /Write in French/);
    assert.match(body.messages[0].content[1].text, /t3a1p2 "Il produit/);
    assert.deepEqual(options, { timeout: CLEANUP_TIMEOUT_MS, maxRetries: 1 });
    assert.equal(logs[0][1].fallback, true);
    assert.equal(logs[0][1].cacheReadTokens, 700);
    const english = await createWindowCleaner({
      client: client(message(answer)),
    })({
      ...cleanupRequest,
      map: [],
      transcript: "",
      outline: { ...live, language: "en", arguments: [] },
    });
    assert.equal(english.kind, "cleanup");
  });

  it("skips refusals, truncation, invalid answers, timeouts and errors", async () => {
    const run = async (answer) =>
      (await createWindowCleaner({ client: client(answer) })(cleanupRequest))
        .reason;
    assert.equal(await run(message("{}", "refusal")), "refusal");
    assert.equal(await run(message("{}", "max_tokens")), "invalid");
    assert.equal(await run(message("not json")), "invalid");
    assert.equal(
      await run({ ...message("{}"), content: [{ type: "thinking" }] }),
      "invalid",
    );
    assert.equal(
      await run(new Anthropic.APIConnectionTimeoutError()),
      "timeout",
    );
    assert.equal(await run(new Error("network")), "error");
    assert.equal(parseCleanup('{"arguments":[]}').length, 0);
    assert.equal(parseCleanup("{"), null);
  });
});

describe("cleanup in the agent's outline loop", () => {
  function clock() {
    let now = 1_793_000_000_000;
    const timers = [];
    return {
      timers,
      now: () => now,
      setTimeout(callback, ms) {
        timers.push({ at: now + ms, callback });
        return timers.length;
      },
      clearTimeout() {},
      async run() {
        await settle();
        const next = timers.shift();
        if (!next) return false;
        now = Math.max(now, next.at);
        next.callback();
        await settle();
        return true;
      },
    };
  }
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const final = {
    turnNumber: 1,
    side: "A",
    language: "fr",
    arguments: [{ id: "t1a1", label: "Final", rebuts: null, continues: null }],
    final: true,
  };
  function fixture({ answers = [], cleanResult } = {}) {
    const time = clock(),
      cleaned = [],
      submitted = [],
      published = [],
      logs = [];
    const loop = createOutlineLoop({
      debateId: "d",
      proposition: "P",
      call: async () => ({ kind: "skip", reason: "invalid" }),
      submit: async () => null,
      publish: async (value) => published.push(value),
      clock: time,
      log: (text, detail) => logs.push([text, detail]),
      clean: async (input) => {
        cleaned.push(input);
        if (cleanResult instanceof Error) throw cleanResult;
        return (
          cleanResult ?? {
            kind: "cleanup",
            arguments: [item("t1a1", "Final")],
            model: "claude-sonnet-5-5",
          }
        );
      },
      submitCleanup: async (turnNumber, model, items) => {
        submitted.push({ turnNumber, model, items });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? { status: 201, body: { accepted: true, turn: final } };
      },
    });
    return { time, loop, cleaned, submitted, published, logs };
  }
  const chunk = (time, text) => ({
    text,
    startAt: time.now() - 1000,
    endAt: time.now(),
  });

  it("cleans each finished turn once it ends and publishes the accepted final outline", async () => {
    const f = fixture({
      answers: [
        { status: 409, body: { accepted: false, reason: "not_frozen" } },
      ],
    });
    f.loop.resume({
      version: 0,
      turn: null,
      map: [{ id: "t0a1", turnNumber: 0, side: "B", label: "Avant" }],
    });
    await f.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: f.time.now(),
    });
    f.loop.addFinal(1, chunk(f.time, "Le nucléaire est pilotable."));
    f.loop.addFinal(1, chunk(f.time, "Il produit à la demande."));
    await f.loop.startTurn({
      turnNumber: 2,
      side: "B",
      language: "en",
      startedAt: f.time.now(),
    });
    await settle();
    assert.equal(f.cleaned.length, 1);
    assert.equal(
      f.cleaned[0].transcript,
      "Le nucléaire est pilotable. Il produit à la demande.",
    );
    assert.deepEqual(
      f.cleaned[0].map.map((entry) => entry.id),
      ["t0a1"],
      "only earlier turns",
    );
    // Not frozen yet: retried after a pause.
    assert.equal(f.submitted.length, 1);
    while (await f.time.run());
    assert.equal(f.submitted.length, 2);
    assert.deepEqual(f.published.at(-1), {
      v: 1,
      type: "final",
      debateId: "d",
      turn: final,
    });
    assert.ok(f.loop.map.some((entry) => entry.label === "Final"));
    // The last turn is cleaned when the job stops; stop waits for it.
    f.loop.addFinal(2, chunk(f.time, "Too expensive."));
    const stopping = f.loop.stop();
    await settle();
    assert.equal(f.cleaned.length, 2);
    await stopping;
    assert.equal(f.submitted.at(-1).turnNumber, 2);
  });

  it("gives up on refusals and skips, and never cleans an empty turn", async () => {
    const refused = fixture({
      answers: [{ status: 409, body: { accepted: false, reason: "late" } }],
    });
    await refused.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    refused.loop.addFinal(1, chunk(refused.time, "Texte"));
    await refused.loop.stop();
    assert.equal(refused.submitted.length, 1);
    assert.equal(refused.published.length, 0);
    assert.equal(refused.logs.at(-1)[0], "window cleanup refused");

    const skipped = fixture({
      cleanResult: { kind: "skip", reason: "refusal" },
    });
    await skipped.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    skipped.loop.addFinal(1, chunk(skipped.time, "Texte"));
    await skipped.loop.stop();
    assert.equal(skipped.submitted.length, 0);

    const failing = fixture({ cleanResult: new Error("boom") });
    await failing.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    failing.loop.addFinal(1, chunk(failing.time, "Texte"));
    await failing.loop.stop();
    assert.equal(failing.submitted.length, 0);

    const silent = fixture();
    await silent.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    await silent.loop.stop();
    assert.equal(silent.cleaned.length, 0);

    const offline = fixture({ answers: [new Error("offline")] });
    await offline.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    offline.loop.addFinal(1, chunk(offline.time, "Texte"));
    await offline.loop.stop();
    assert.equal(offline.published.length, 0);

    const malformed = fixture({
      answers: [{ status: 201, body: { accepted: true, turn: { nope: 1 } } }],
    });
    await malformed.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    malformed.loop.addFinal(1, chunk(malformed.time, "Texte"));
    await malformed.loop.stop();
    assert.equal(malformed.published.length, 0);

    const waiting = fixture({
      answers: Array.from({ length: CLEANUP_ATTEMPTS }, () => ({
        status: 409,
        body: { accepted: false, reason: "not_frozen" },
      })),
    });
    await waiting.loop.startTurn({
      turnNumber: 1,
      side: "A",
      language: "fr",
      startedAt: 0,
    });
    waiting.loop.addFinal(1, chunk(waiting.time, "Texte"));
    const stopped = waiting.loop.stop();
    while (await waiting.time.run());
    await stopped;
    assert.equal(waiting.submitted.length, CLEANUP_ATTEMPTS);
    assert.equal(waiting.logs.at(-1)[0], "window cleanup gave up");
    assert.equal(CLEANUP_RETRY_MS, 3000);
  });
});

describe("final outlines and replay sync on the page", () => {
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const summary = (turnNumber, label, final = false) => ({
    turnNumber,
    side: turnNumber % 2 ? "A" : "B",
    language: "fr",
    arguments: [
      { id: `t${turnNumber}a1`, label, rebuts: null, continues: null },
    ],
    final,
  });

  it("accepts only this debate's well-formed final messages", () => {
    const message = {
      v: 1,
      type: "final",
      debateId: "d",
      turn: summary(1, "F", true),
    };
    assert.deepEqual(
      parseFinalMessage(encode(message), "d"),
      summary(1, "F", true),
    );
    const bad = (turn) => ({ ...message, turn });
    for (const value of [
      { ...message, debateId: "e" },
      { ...message, type: "edits" },
      bad(null),
      bad({ ...summary(1, "F"), side: "C" }),
      bad({ ...summary(1, "F"), language: "de" }),
      bad({ ...summary(1, "F"), arguments: "x" }),
      bad({ ...summary(1, "F"), arguments: [null] }),
      bad({ ...summary(1, "F"), arguments: [{ id: "bad", label: "x" }] }),
      bad({
        ...summary(1, "F"),
        arguments: [{ id: "t1a1", label: "x".repeat(81) }],
      }),
      bad({
        ...summary(1, "F"),
        arguments: [{ id: "t1a1", label: "x", rebuts: "nope" }],
      }),
    ])
      assert.equal(parseFinalMessage(encode(value), "d"), null);
    assert.equal(parseFinalMessage(new TextEncoder().encode("{"), "d"), null);
  });

  it("replaces an earlier turn's summary with its final outline", () => {
    const view = {
      ...emptyView,
      turns: [summary(1, "Live")],
      flags: new Set(),
    };
    const next = applyFinal(view, summary(1, "Final", true));
    assert.equal(next.turns[0].arguments[0].label, "Final");
    assert.equal(next.turns[0].final, true);
    assert.equal(applyFinal(view, summary(2, "Unknown", true)), view);
  });

  it("shows the outline as it was at the replay position", () => {
    const add = (turnNumber, index, label) => ({
      op: "add_argument",
      id: `t${turnNumber}a${index}`,
      label,
      span: { startMs: 0, endMs: 1000 },
    });
    const version = (n, at, turnNumber, edits) => ({
      version: n,
      at,
      turnNumber,
      side: turnNumber % 2 ? "A" : "B",
      language: "fr",
      edits,
    });
    const timeline = {
      debateId: "d",
      complete: true,
      timed: true,
      versions: [
        version(1, 1000, 1, [add(1, 1, "Un")]),
        version(2, 5000, 1, [add(1, 2, "Deux")]),
        version(3, 61000, 2, [add(2, 1, "Two")]),
        version(4, null, 2, [add(2, 2, "Untimed")]),
      ],
      turns: [summary(1, "Un, final", true), summary(2, "Two", true)],
    };
    const index = createReplayIndex(timeline);
    assert.equal(index.timed, true);
    assert.equal(index.at(500).current, null);
    assert.deepEqual(
      index.at(2000).current.arguments.map((a) => a.label),
      ["Un"],
    );
    assert.deepEqual(
      index.at(6000).current.arguments.map((a) => a.label),
      ["Un", "Deux"],
    );
    const later = index.at(62000);
    assert.equal(later.current.turnNumber, 2);
    assert.deepEqual(
      later.turns.map((turn) => turn.arguments[0].label),
      ["Un, final"],
      "earlier turns show their final outline",
    );
    // Seeking back replays from the start.
    assert.deepEqual(
      index.at(1500).current.arguments.map((a) => a.label),
      ["Un"],
    );
    assert.equal(createReplayIndex({ ...timeline, timed: false }).timed, false);
  });

  it("formats a window's final argument labels for the chart heading", () => {
    assert.equal(
      windowArgumentLabel([" Pilotable ", "", "Sûr"]),
      "Pilotable · Sûr",
    );
    assert.equal(windowArgumentLabel([]), null);
  });
});

describe("cleanup, timeline and correlation routes", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const secret = "s".repeat(32);

  it("accepts a signed cleanup and answers with the server's decision", async () => {
    const calls = [];
    const server = express();
    server.use(
      "/api/internal/transcription",
      express.raw({ type: "application/json" }),
      createTranscriptionIngestRouter({
        repository: { ingest: async () => ({}), session: async () => null },
        outlines: {
          async applyCleanup(debateId, cleanup) {
            calls.push([debateId, cleanup]);
            return { status: 201, body: { accepted: true } };
          },
        },
        secret,
      }),
    );
    const post = (value) => {
      const body = JSON.stringify(value);
      const timestamp = String(Date.now());
      return request(server)
        .post(`/api/internal/transcription/debates/${id}/cleanup`)
        .set("Content-Type", "application/json")
        .set(ingestHeaders.timestamp, timestamp)
        .set(ingestHeaders.signature, signIngest(secret, timestamp, body))
        .send(body);
    };
    const cleanup = {
      jobId: "AJ_1",
      turnNumber: 1,
      model: "claude-sonnet-5-5",
      arguments: [item(null, "Label")],
    };
    const accepted = await post(cleanup);
    assert.equal(accepted.status, 201);
    assert.equal(calls[0][0], id);
    assert.equal((await post({ ...cleanup, turnNumber: 0 })).status, 400);
    const without = express();
    without.use(
      "/x",
      express.raw({ type: "application/json" }),
      createTranscriptionIngestRouter({
        repository: { ingest: async () => ({}), session: async () => null },
        secret,
      }),
    );
    const body = JSON.stringify(cleanup);
    const timestamp = String(Date.now());
    assert.equal(
      (
        await request(without)
          .post(`/x/debates/${id}/cleanup`)
          .set("Content-Type", "application/json")
          .set(ingestHeaders.timestamp, timestamp)
          .set(ingestHeaders.signature, signIngest(secret, timestamp, body))
          .send(body)
      ).status,
      400,
      "refused when the outline is off",
    );
  });

  it("serves the timeline, cached once complete, and the correlation", async () => {
    let complete = false;
    let isPublic = true;
    const outlines = {
      isPublic: async () => isPublic,
      snapshot: async () => ({
        kind: "snapshot",
        debateId: id,
        version: 2,
        finals: 1,
        current: null,
        turns: [],
        flags: [],
      }),
      since: async () => null,
      flag: async () => null,
      timeline: async (debateId) => ({
        debateId,
        complete,
        timed: true,
        versions: [],
        turns: [],
      }),
      correlation: async (debateId) => ({
        debateId,
        minimumCount: 5,
        windows: [],
        arguments: [],
      }),
    };
    const server = express();
    server.use(createOutlineRouter(outlines));
    const snapshot = await request(server).get(
      `/api/public/debates/${id}/outline`,
    );
    assert.equal(snapshot.headers.etag, '"o2.1-snapshot"');
    const path = `/api/public/debates/${id}/outline/timeline`;
    let timeline = await request(server).get(path);
    assert.equal(timeline.status, 200);
    assert.equal(timeline.headers["cache-control"], "no-cache");
    complete = true;
    timeline = await request(server).get(path);
    assert.equal(
      timeline.headers["cache-control"],
      "public, max-age=86400, immutable",
    );
    const correlation = await request(server).get(
      `/api/public/debates/${id}/outline/correlation`,
    );
    assert.equal(correlation.body.minimumCount, 5);
    assert.equal(correlation.headers["cache-control"], "public, max-age=30");
    for (const bad of [
      "/api/public/debates/nope/outline/timeline",
      "/api/public/debates/nope/outline/correlation",
    ])
      assert.equal((await request(server).get(bad)).status, 404);
    isPublic = false;
    const hidden = express();
    hidden.use(createOutlineRouter(outlines));
    assert.equal((await request(hidden).get(path)).status, 404);
    assert.equal(
      (
        await request(hidden).get(
          `/api/public/debates/${id}/outline/correlation`,
        )
      ).status,
      404,
    );
    const bare = express();
    bare.use(
      createOutlineRouter({
        ...outlines,
        timeline: undefined,
        correlation: undefined,
      }),
    );
    assert.equal((await request(bare).get(path)).status, 404);
    assert.equal(
      (await request(bare).get(`/api/public/debates/${id}/outline/correlation`))
        .status,
      404,
    );
  });
});
