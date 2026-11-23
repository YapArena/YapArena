import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createMicTurns } from "../dist/features/mic/turns.js";
import { createMicFunds } from "../dist/features/mic/funds.js";
import { MicError } from "../dist/features/mic/rules.js";
import { CoinOperationError } from "../dist/features/account-wallet/external-operations.js";

// Decision 0018, PR 2b: the mic in the media clock, against an in-memory
// database that answers the clock's and the engine's statements.
const id = "33333333-3333-4333-8333-333333333333";
const micA = "44444444-4444-4444-8444-444444444444";
const micB = "55555555-5555-4555-8555-555555555555";
const asker = "71",
  stranger = "72";
const TURN = 60_000;

function fake({ mic = true, maximum = 3600, turn = 1, activeMs = 0 } = {}) {
  const seen = [];
  let now = Date.parse("2026-11-23T12:00:00Z");
  const event = {
    status: "live",
    rulesSnapshot: {
      initial_speaking_time_seconds: TURN / 1000,
      maximum_duration_seconds: maximum,
      ...(mic ? { mic_enabled: true } : {}),
    },
  };
  const media = {
    debateId: id,
    state: "running",
    activeSide: turn % 2 ? "A" : "B",
    turnNumber: turn,
    turnDeadlineAt: new Date(now + TURN),
    remainingMs: TURN,
    activeMs,
    lastResumedAt: new Date(now),
    revision: 0,
    incident: null,
    egressId: "egress",
    recordingStatus: "recording",
    recordingKey: "key",
    hasCaptions: false,
    compositeLayout: "livekit-grid",
  };
  const lists = [],
    mics = [],
    runs = [],
    turns = [],
    history = [],
    funds = [],
    ends = [];
  const rows = (list = []) => ({ rows: list, rowCount: list.length });
  const micTurnRow = (t) => {
    const m = mics.find((x) => x.id === t.micId);
    return {
      kind: t.kind,
      micId: t.micId,
      camp: m.camp,
      target: m.target,
      holderId: m.holder,
      allottedMs: t.allottedMs,
      ended: t.endedAt !== null,
    };
  };
  async function query(sql, values = []) {
    seen.push({ sql, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return rows();
    if (sql.startsWith("SELECT status, rules_snapshot")) return rows([event]);
    if (sql.includes("FROM debate_media WHERE debate_id = $1 FOR UPDATE"))
      return rows([{ ...media, databaseNow: new Date(now) }]);
    if (sql.startsWith("SELECT debate_id AS") && sql.includes("debate_media"))
      return rows(
        media.state === "running" && media.turnDeadlineAt.getTime() <= now
          ? [{ debateId: id }]
          : [],
      );
    if (sql.startsWith("SELECT state, active_side"))
      return rows([{ ...media, databaseNow: new Date(now) }]);
    if (sql.startsWith("SELECT state, turn_number"))
      return rows([{ state: media.state, turnNumber: media.turnNumber }]);
    if (sql.startsWith("UPDATE debates SET status = 'ended'")) {
      event.status = "ended";
      return rows();
    }
    if (sql.startsWith("UPDATE debates SET rules_snapshot")) {
      event.rulesSnapshot = { ...event.rulesSnapshot, mic_enabled: true };
      return rows();
    }
    if (sql.startsWith("UPDATE event_participants")) return rows();
    if (sql.startsWith("UPDATE debate_media SET state = 'ended'")) {
      Object.assign(media, {
        state: "ended",
        activeSide: null,
        turnDeadlineAt: null,
        activeMs: values[1],
      });
      return rows();
    }
    if (sql.startsWith("UPDATE debate_media SET active_side = $2")) {
      Object.assign(media, {
        activeSide: values[1],
        turnNumber: media.turnNumber + 1,
        activeMs: values[2],
        remainingMs: values[3],
        lastResumedAt: new Date(now),
        turnDeadlineAt: new Date(now + values[3]),
        revision: media.revision + 1,
      });
      return rows();
    }
    if (sql.startsWith("UPDATE debate_media SET active_side=$2")) {
      Object.assign(media, {
        activeSide: values[1],
        turnNumber: media.turnNumber + 1,
        activeMs: media.activeMs + values[2],
        remainingMs: values[3],
        lastResumedAt: new Date(now),
        turnDeadlineAt: new Date(now + values[3]),
        revision: media.revision + 1,
      });
      return rows();
    }
    if (sql.startsWith("UPDATE debate_media SET revision=revision+1")) {
      media.revision++;
      return rows();
    }
    if (sql.startsWith("INSERT INTO event_history")) {
      history.push(values[1]);
      return rows();
    }
    if (sql.startsWith("SELECT t.kind")) {
      const t = turns.find((x) => x.turnNumber === values[1]);
      return rows(t ? [micTurnRow(t)] : []);
    }
    if (sql.startsWith("UPDATE mic_turns SET ended_at")) {
      const t = turns.find((x) => x.turnNumber === values[1]);
      Object.assign(t, { endedAt: new Date(now), usedMs: values[2] });
      return rows();
    }
    if (sql.startsWith("UPDATE mic_turns SET text")) {
      turns.find((x) => x.turnNumber === values[1]).text = values[2];
      return rows();
    }
    if (sql.startsWith("INSERT INTO mic_turns")) {
      assert.ok(!turns.some((t) => t.turnNumber === values[1]));
      turns.push({
        turnNumber: values[1],
        micId: values[2],
        kind: values[3],
        side: values[4],
        allottedMs: values[5],
        text: null,
        endedAt: null,
        usedMs: null,
      });
      return rows();
    }
    // PR 3: keep-the-asker-on funds (funds.ts).
    if (sql.startsWith("SELECT price::text FROM mic_mics"))
      return rows([{ price: mics.find((m) => m.id === values[0]).price }]);
    if (sql.startsWith("INSERT INTO mic_funds")) {
      assert.ok(
        !funds.some((x) => x.micId === values[1] && x.state === "open"),
        "one open fund per mic",
      );
      funds.push({
        id: values[0],
        micId: values[1],
        turnNumber: values[3],
        closesAfter: values[4],
        price: values[5],
        state: "open",
      });
      return rows();
    }
    if (sql.startsWith("UPDATE mic_funds SET state='closing'")) {
      const closing = funds.filter(
        (x) =>
          x.micId === values[0] &&
          x.state === "open" &&
          x.closesAfter === values[1],
      );
      for (const fund of closing) fund.state = "closing";
      return { rows: [], rowCount: closing.length };
    }
    if (sql.startsWith("SELECT state FROM mic_funds"))
      return rows(
        funds
          .filter((x) => x.micId === values[0])
          .sort((a, b) => b.turnNumber - a.turnNumber)
          .slice(0, 1),
      );
    if (sql.startsWith("SELECT count(*)::int AS n FROM mic_turns"))
      return rows([
        { n: turns.filter((t) => t.turnNumber <= values[1]).length },
      ]);
    if (sql.startsWith("SELECT COALESCE(sum(used_ms)"))
      return rows([
        { ms: String(turns.reduce((sum, t) => sum + (t.usedMs ?? 0), 0)) },
      ]);
    if (sql.startsWith("SELECT 1 FROM mic_lists")) return rows(lists);
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return rows();
    if (sql.startsWith("SELECT id,n FROM mic_lists"))
      return rows(lists.filter((l) => l.state === "open"));
    if (sql.startsWith("INSERT INTO mic_lists")) {
      lists.push({ id: values[0], n: lists.length + 1, state: "open" });
      lists.at(-1).openedRound = values[3];
      return rows([{ n: lists.length }]);
    }
    if (sql.startsWith("UPDATE mic_mics SET state='done'")) {
      const m = mics.find((x) => x.id === values[0] && x.state === "live");
      if (m) m.state = "done";
      return rows();
    }
    if (sql.startsWith("UPDATE mic_mics SET state='live'")) {
      assert.ok(!mics.some((m) => m.state === "live"), "one live mic");
      mics.find((x) => x.id === values[0]).state = "live";
      return rows();
    }
    const started = (m) => runs.some((r) => r.micId === m.id);
    if (sql.startsWith("SELECT m.id, m.state, m.camp")) {
      const waiting = mics
        .filter((m) => ["live", "queued"].includes(m.state) && !started(m))
        .sort((a, b) => (b.state === "live") - (a.state === "live"));
      return rows(waiting.slice(0, 1));
    }
    if (sql.startsWith("SELECT 1 FROM mic_mics"))
      return rows(mics.filter((m) => m.state === "live" && m.id !== values[1]));
    if (sql.startsWith("SELECT m.id, m.camp, m.target"))
      return rows(mics.filter((m) => m.state === "live" && !started(m)));
    if (sql.startsWith("SELECT m.debate_id AS"))
      return rows(
        mics
          .filter(
            (m) =>
              m.state === "live" &&
              !started(m) &&
              media.state === "running" &&
              media.turnDeadlineAt.getTime() > now,
          )
          .map(() => ({ debateId: id })),
      );
    if (sql.startsWith("INSERT INTO mic_runs(mic_id,debate_id)")) {
      runs.push({ micId: values[0], cut: null });
      return rows();
    }
    if (
      sql.startsWith("INSERT INTO mic_runs(mic_id,debate_id,cut_turn_number")
    ) {
      runs.push({
        micId: values[0],
        cut: { turnNumber: values[2], side: values[3], lostMs: values[4] },
        void: "pending",
      });
      return rows();
    }
    if (sql.startsWith("(SELECT mic_id::text AS key"))
      return rows([
        ...runs
          .filter((r) => r.void === "pending")
          .map((r) => ({
            key: r.micId,
            source: "run",
            debateId: id,
            turnNumber: r.cut.turnNumber,
          })),
        ...ends
          .filter((e) => e.void === "pending")
          .map((e) => ({
            key: id,
            source: "end",
            debateId: id,
            turnNumber: e.turnNumber,
          })),
      ]);
    if (sql.startsWith("UPDATE mic_debate_ends SET cut_void")) {
      const end = ends.find((e) => e.void === "pending");
      if (end) end.void = values[1];
      return rows();
    }
    if (sql.startsWith("UPDATE mic_runs SET cut_void")) {
      const run = runs.find(
        (r) => r.micId === values[0] && r.void === "pending",
      );
      if (run) run.void = values[1];
      return rows();
    }
    if (sql.startsWith("SELECT s.id"))
      return rows(
        [asker, stranger].includes(values[0])
          ? [{ id: "9", userId: values[0] }]
          : [],
      );
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const database = {
    query,
    connect: async () => ({ query, release() {} }),
  };
  const mediaRepository = createMediaRepository(database);
  const voids = [],
    applied = [],
    logged = [];
  let voidFailure = null;
  // The money side of keeping the asker on runs on PostgreSQL
  // (mic-keep-postgres); here the engine only calls it.
  const settled = [];
  const engine = createMicTurns({
    funds: {
      async settleClosing(debateId = null) {
        settled.push(["closing", debateId]);
        const closing = funds.filter((x) => x.state === "closing");
        for (const fund of closing) fund.state = "failed";
        return closing.length;
      },
      async settleEnded() {
        settled.push(["ended"]);
        if (event.status === "live" || ends.length) return 0;
        ends.push({ turnNumber: media.turnNumber, void: "pending" });
        return 1;
      },
    },
    database,
    media: mediaRepository,
    voidTurnWindow: async (...args) => {
      voids.push(args);
      if (voidFailure) throw voidFailure;
      return { roundId: "round", created: true };
    },
    onTurn: async (debateId) => applied.push(debateId),
    logger: {
      warn: (details, message) => logged.push(["warn", message]),
      error: (details, message) => logged.push(["error", message]),
    },
  });
  return {
    media: mediaRepository,
    engine,
    state: media,
    event,
    lists,
    mics,
    runs,
    turns,
    history,
    funds,
    ends,
    settled,
    seen,
    voids,
    applied,
    logged,
    failVoids(error) {
      voidFailure = error;
    },
    // A camp's #1 fires (the list's own transaction, PR 2a).
    fire(micId, camp, state = "live") {
      mics.push({
        id: micId,
        camp,
        target: camp === "A" ? "B" : "A",
        holder: asker,
        state,
        price: "30000",
      });
    },
    later(ms) {
      now += ms;
    },
    // The worker's pass once the running turn's deadline has passed.
    async deadline() {
      now = media.turnDeadlineAt.getTime();
      return mediaRepository.tick();
    },
    current() {
      return turns.find((t) => t.turnNumber === media.turnNumber) ?? null;
    },
  };
}
const context = (userId) => ({
  userId,
  sessionTokenHash: "hash",
  expectedSessionId: "9",
});
const refused = (status, message) => (error) =>
  error instanceof MicError &&
  error.status === status &&
  message.test(error.message);

describe("borrow the microphone in the turn engine", () => {
  it("leaves a debate that started with the switch off as it was", async () => {
    const f = fake({ mic: false });
    for (let turn = 1; turn <= 8; turn++) await f.deadline();
    assert.equal(f.state.turnNumber, 9);
    assert.equal(f.state.activeSide, "A");
    assert.equal(f.lists.length, 0);
    assert.ok(!f.seen.some(({ sql }) => /mic_/.test(sql)));
    // A fired mic (impossible without a list) is never started for it.
    f.fire(micA, "B");
    assert.equal(await f.engine.start(id), null);
    assert.equal(f.state.turnNumber, 9);
    // The start copies the switch into the snapshot only when it is on.
    const start = (micEnabled) => {
      const seen = [];
      const db = {
        async query(sql, values) {
          seen.push(sql);
          if (sql.startsWith("SELECT status, rules_snapshot"))
            return {
              rows: [
                {
                  status: "ready",
                  rulesSnapshot: { ...f.event.rulesSnapshot },
                },
              ],
            };
          if (sql.startsWith("INSERT INTO debate_media"))
            return { rows: [{ debateId: values[0] }] };
          return { rows: [] };
        },
      };
      db.connect = async () => ({ query: db.query, release() {} });
      return createMediaRepository(db, undefined, { micEnabled })
        .start(id, "egress", "key")
        .then(() => seen);
    };
    assert.ok(
      !(await start(false)).some((sql) => /rules_snapshot =/.test(sql)),
    );
    assert.ok(
      (await start(true)).some((sql) =>
        sql.startsWith("UPDATE debates SET rules_snapshot"),
      ),
    );
  });

  it("opens the list once, when both debaters have spoken three times (L2)", async () => {
    const f = fake();
    for (let turn = 1; turn <= 5; turn++) await f.deadline();
    assert.equal(f.lists.length, 0);
    await f.deadline();
    assert.equal(f.lists.length, 1);
    assert.equal(f.lists[0].openedRound, 4);
    for (let turn = 7; turn <= 12; turn++) await f.deadline();
    assert.equal(f.lists.length, 1);
    assert.equal(
      f.seen.filter(({ sql }) => sql.startsWith("INSERT INTO mic_lists"))
        .length,
      1,
    );
    // Without a mic the debate alternates as before.
    assert.equal(f.state.turnNumber, 13);
    assert.equal(f.state.activeSide, "A");
  });

  it("cuts the running turn and starts the question with its own number (F2, E5, E6, E10)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.later(20_000);
    f.fire(micA, "B"); // camp B asks debater A
    const started = await f.engine.start(id);
    assert.deepEqual(started, {
      micId: micA,
      cutTurnNumber: 7,
      lostMs: 40_000,
    });
    assert.equal(f.state.turnNumber, 8);
    assert.equal(f.state.activeSide, "B", "the asker's turn is its camp's");
    assert.equal(f.state.remainingMs, TURN, "a full turn for the question");
    assert.equal(f.state.activeMs, 6 * TURN + 20_000);
    assert.deepEqual(f.runs[0].cut, {
      turnNumber: 7,
      side: "A",
      lostMs: 40_000,
    });
    assert.equal(f.runs[0].void, "done");
    assert.deepEqual(f.voids, [[id, 7, "turn_cut"]]);
    assert.deepEqual(f.applied, [id]);
    assert.equal(f.current().kind, "question");
    assert.equal(f.current().side, "B");
    // Starting again changes nothing.
    assert.equal(await f.engine.start(id), null);
    assert.equal(f.state.turnNumber, 8);
    assert.equal(f.voids.length, 1);
  });

  it("runs question, answer, follow-up, answer, then resumes with the other debater (E1, E4, E8)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    f.later(1_000);
    await f.engine.start(id);
    const sequence = [];
    for (let step = 0; step < 4; step++) {
      const { turns } = await f.deadline();
      sequence.push([
        f.state.turnNumber,
        f.current().kind,
        f.state.activeSide,
        turns[0].side,
      ]);
    }
    assert.deepEqual(sequence, [
      [9, "answer", "A", "A"],
      [10, "followup", "B", null],
      [11, "answer2", "A", "A"],
      [12, "resume", "B", "B"],
    ]);
    assert.equal(f.mics[0].state, "live", "live until the resume ends");
    const { turns } = await f.deadline();
    assert.equal(f.mics[0].state, "done");
    assert.equal(f.current(), null);
    assert.equal(f.state.turnNumber, 13);
    assert.equal(f.state.activeSide, "A");
    assert.deepEqual(turns, [{ debateId: id, side: "A" }]);
    assert.deepEqual(
      f.turns.map((t) => [t.turnNumber, t.usedMs]),
      [
        [8, TURN],
        [9, TURN],
        [10, TURN],
        [11, TURN],
        [12, TURN],
      ],
    );
    assert.match(f.history.at(-2), /mic resume turn, side B/);
  });

  it("starts a queued mic only after the resume turn (F12, F14)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    f.fire(micB, "A", "queued"); // camp A asks debater B
    assert.equal(await f.engine.start(id), null, "a queued mic waits");
    for (let step = 0; step < 4; step++) await f.deadline();
    assert.equal(f.current().kind, "resume");
    assert.equal(f.mics[1].state, "queued");
    const { turns } = await f.deadline();
    assert.equal(f.mics[0].state, "done");
    assert.equal(f.mics[1].state, "live");
    assert.equal(f.current().kind, "question");
    assert.equal(f.current().micId, micB);
    assert.equal(f.state.activeSide, "A");
    assert.deepEqual(turns, [{ debateId: id, side: null }]);
    // Started at a boundary: nothing was cut, nothing to refund.
    assert.equal(f.runs[1].cut, null);
    assert.equal(f.voids.length, 1);
    for (let step = 0; step < 4; step++) await f.deadline();
    assert.equal(f.current().kind, "resume");
    assert.equal(f.state.activeSide, "A", "debater A was not asked");
    await f.deadline();
    assert.equal(f.mics[1].state, "done");
    assert.equal(f.state.activeSide, "B");
  });

  it("starts a mic fired just as a turn ended at the boundary, without a cut", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.deadline();
    assert.equal(f.current().kind, "question");
    assert.equal(f.runs[0].cut, null);
    assert.equal(f.state.turnNumber, 8);
  });

  it("does not count mic turns toward the maximum length", async () => {
    // Eight turns of a minute: the seventh is cut after 20 seconds.
    const f = fake({ turn: 7, activeMs: 6 * TURN, maximum: 480 });
    f.lists.push({ id: "list", state: "open" });
    f.later(20_000);
    f.fire(micA, "B");
    await f.engine.start(id);
    for (let step = 0; step < 5; step++) await f.deadline();
    assert.equal(f.event.status, "live");
    assert.equal(f.state.activeMs, 11 * TURN + 20_000);
    // 6:20 of debate time used: the next turn is a full minute, then 40 s.
    assert.equal(f.state.turnNumber, 13);
    assert.equal(f.state.remainingMs, TURN);
    await f.deadline();
    assert.equal(f.state.remainingMs, 40_000);
    const { ended } = await f.deadline();
    assert.deepEqual(ended, [id]);
    assert.equal(f.event.status, "ended");
    // Switched off, the same time would have ended the debate long before.
    const off = fake({ mic: false, turn: 7, activeMs: 7 * TURN, maximum: 480 });
    assert.deepEqual((await off.deadline()).ended, [id]);
  });

  it("retries a failed start and refund on the worker's next pass", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    f.later(5_000);
    // The fire committed but its start never ran: the worker starts it.
    f.failVoids(new CoinOperationError("busy", 503, "busy"));
    const pass = (started, voided) => ({
      started,
      voided,
      refunded: 0,
      ended: 0,
    });
    assert.deepEqual(await f.engine.recover(), pass(1, 0));
    assert.equal(f.state.turnNumber, 8);
    assert.equal(f.runs[0].void, "pending");
    assert.ok(f.logged.some(([level]) => level === "error"));
    f.failVoids(null);
    assert.deepEqual(await f.engine.recover(), pass(0, 1));
    assert.equal(f.runs[0].void, "done");
    assert.deepEqual(await f.engine.recover(), pass(0, 0));
    assert.equal(f.voids.length, 3);
    assert.equal(f.state.turnNumber, 8);
  });

  it("records a cut window whose settlement had started as refused", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    f.failVoids(
      new CoinOperationError(
        "this round's settlement has started; it can't be voided",
      ),
    );
    await f.engine.start(id);
    assert.equal(f.runs[0].void, "refused");
    assert.deepEqual(await f.engine.recover(), {
      started: 0,
      voided: 0,
      refunded: 0,
      ended: 0,
    });
  });

  it("lets only the asker end their own turn early (E1)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    f.later(15_000);
    await assert.rejects(
      f.engine.endAskerTurn(context(stranger), id),
      refused(403, /only the asker/),
    );
    assert.deepEqual(await f.engine.endAskerTurn(context(asker), id), {
      ended: false,
      side: "A",
    });
    assert.equal(f.turns[0].usedMs, 15_000);
    assert.equal(f.current().kind, "answer");
    assert.equal(f.state.remainingMs, TURN);
    await assert.rejects(
      f.engine.endAskerTurn(context(asker), id),
      refused(409, /isn't an asker's turn/),
    );
    await f.deadline();
    assert.equal(f.current().kind, "followup");
    assert.deepEqual(await f.engine.endAskerTurn(context(asker), id), {
      ended: false,
      side: "A",
    });
    assert.equal(f.current().kind, "answer2");
    await assert.rejects(
      f.engine.endAskerTurn({ ...context(asker), expectedSessionId: "8" }, id),
      (error) => error instanceof CoinOperationError && error.status === 409,
    );
  });

  it("puts only the asker's text on screen, only in their turn (E9)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    const revision = f.state.revision;
    assert.deepEqual(
      await f.engine.setAskerText(context(asker), id, "  Why now?  "),
      { turnNumber: 8, text: "Why now?" },
    );
    assert.equal(f.current().text, "Why now?");
    assert.equal(f.state.revision, revision + 1, "the page refreshes");
    await assert.rejects(
      f.engine.setAskerText(context(stranger), id, "Mine"),
      refused(403, /only the asker/),
    );
    await assert.rejects(
      f.engine.setAskerText(context(asker), id, "x".repeat(201)),
      refused(400, /at most 200/),
    );
    await assert.rejects(
      f.engine.setAskerText(context(asker), id, "   "),
      refused(400, /write your question/),
    );
    await f.deadline();
    await assert.rejects(
      f.engine.setAskerText(context(asker), id, "Too late"),
      refused(409, /isn't an asker's turn/),
    );
    assert.equal(f.turns[1].text, null);
  });

  // PR 3: keep the asker on (X).
  it("opens a fund with the question and closes it unfunded after the follow-up (X1, X2, X7)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    assert.deepEqual(f.funds, [
      {
        id: f.funds[0].id,
        micId: micA,
        turnNumber: 8,
        closesAfter: "followup",
        price: "30000",
        state: "open",
      },
    ]);
    await f.deadline(); // question ends: still open through the answer
    assert.equal(f.funds[0].state, "open");
    await f.deadline(); // answer ends
    assert.equal(f.current().kind, "followup");
    assert.equal(f.funds[0].state, "open");
    // The asker ends their follow-up: the fund closes and is refunded after.
    await f.engine.endAskerTurn(context(asker), id);
    assert.equal(f.current().kind, "answer2");
    assert.deepEqual(f.settled, [["closing", id]]);
    assert.equal(f.funds[0].state, "failed");
    await f.deadline();
    assert.equal(f.current().kind, "resume");
    assert.equal(f.funds.length, 1, "no extension, no new fund");
  });

  it("runs funded extensions with their own turns and funds, without a cap (X4, X8, X10, X11)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B"); // camp B asks debater A
    await f.engine.start(id);
    // A pledge reaches the price during the answer (the fund row's own
    // transaction, repository.ts keep).
    await f.deadline();
    f.funds[0].state = "funded";
    const sequence = [];
    const step = async () => {
      const { turns } = await f.deadline();
      sequence.push([
        f.state.turnNumber,
        f.current()?.kind ?? null,
        f.state.activeSide,
        turns[0].side,
      ]);
    };
    await step(); // follow-up: a funded fund stays funded at its close
    assert.equal(f.funds[0].state, "funded");
    await step(); // answer2
    await step(); // extension question, its own fund
    assert.deepEqual(
      f.funds.map((x) => [x.turnNumber, x.closesAfter, x.state]),
      [
        [8, "followup", "funded"],
        [12, "extq", "open"],
      ],
    );
    f.funds.at(-1).state = "funded";
    await step(); // extension answer
    await step(); // a second extension question
    await step(); // its answer; its fund was never funded
    await step(); // the resume turn
    await step(); // debater A's own turn
    assert.deepEqual(sequence, [
      [10, "followup", "B", null],
      [11, "answer2", "A", "A"],
      [12, "extq", "B", null],
      [13, "exta", "A", "A"],
      [14, "extq", "B", null],
      [15, "exta", "A", "A"],
      [16, "resume", "B", "B"],
      [17, null, "A", "A"],
    ]);
    assert.deepEqual(
      f.funds.map((x) => [x.turnNumber, x.closesAfter, x.state]),
      [
        [8, "followup", "funded"],
        [12, "extq", "funded"],
        [14, "extq", "closing"],
      ],
    );
    assert.equal(f.mics[0].state, "done");
    // Every extension turn is a full mic turn, off the debate's maximum.
    assert.deepEqual(
      f.turns.map((t) => [t.turnNumber, t.kind, t.usedMs]),
      [
        [8, "question", TURN],
        [9, "answer", TURN],
        [10, "followup", TURN],
        [11, "answer2", TURN],
        [12, "extq", TURN],
        [13, "exta", TURN],
        [14, "extq", TURN],
        [15, "exta", TURN],
        [16, "resume", TURN],
      ],
    );
    assert.ok(f.history.some((line) => /mic extq turn, side B/.test(line)));
  });

  it("lets the asker show text in and end an extension question", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    f.funds[0].state = "funded";
    for (let step = 0; step < 4; step++) await f.deadline();
    assert.equal(f.current().kind, "extq");
    assert.deepEqual(
      await f.engine.setAskerText(context(asker), id, "One more?"),
      { turnNumber: 12, text: "One more?" },
    );
    assert.deepEqual(await f.engine.endAskerTurn(context(asker), id), {
      ended: false,
      side: "A",
    });
    assert.equal(f.current().kind, "exta");
    assert.equal(f.funds[1].state, "failed", "closed, then refunded");
    await f.deadline();
    assert.equal(f.current().kind, "resume");
  });

  it("settles the mic's money once the debate ends and refunds the cut mic turn's window (D7, D9)", async () => {
    const f = fake({ turn: 7, activeMs: 6 * TURN });
    f.lists.push({ id: "list", state: "open" });
    f.fire(micA, "B");
    await f.engine.start(id);
    const pass = { started: 0, voided: 0, refunded: 0, ended: 0 };
    assert.deepEqual(await f.engine.recover(), pass);
    // An operator ends the debate in the middle of the question turn.
    f.event.status = "ended";
    f.failVoids(new CoinOperationError("busy", 503, "busy"));
    assert.deepEqual(await f.engine.recover(), { ...pass, ended: 1 });
    assert.deepEqual(f.ends, [{ turnNumber: 8, void: "pending" }]);
    f.failVoids(null);
    assert.deepEqual(await f.engine.recover(), { ...pass, voided: 1 });
    assert.deepEqual(f.ends, [{ turnNumber: 8, void: "done" }]);
    assert.deepEqual(f.voids.at(-1), [id, 8, "turn_cut"]);
    assert.deepEqual(await f.engine.recover(), pass);
    assert.ok(f.settled.filter(([kind]) => kind === "ended").length >= 4);
  });

  it("logs and retries keep-the-asker-on refunds and end settlements that fail", async () => {
    const logged = [];
    const logger = { error: (details, message) => logged.push(message) };
    const down = createMicFunds({
      database: {
        query: async () => {
          throw new Error("database unavailable");
        },
      },
      rail: "simulation",
      logger,
    });
    assert.equal(await down.settleClosing(), 0);
    assert.equal(await down.settleEnded(), 0);
    // The list of due work loads, but each transaction fails: each is
    // logged and left for the next pass.
    const busy = createMicFunds({
      database: {
        query: async (sql) => ({
          rows: sql.includes("mic_lists l")
            ? [{ debateId: id }]
            : [{ id: micA }],
        }),
        connect: async () => {
          throw new Error("timeout exceeded when trying to connect");
        },
      },
      rail: "simulation",
      logger,
    });
    assert.equal(await busy.settleClosing(id), 0);
    assert.equal(await busy.settleEnded(), 0);
    assert.deepEqual(logged, [
      "keep-the-asker-on refunds failed; retrying",
      "mic refunds at the end failed; retrying",
      "keep-the-asker-on refund failed; retrying",
      "mic refunds at the debate's end failed; retrying",
    ]);
  });
});
