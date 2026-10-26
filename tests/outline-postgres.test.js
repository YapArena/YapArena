import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { createDebaterSettings } from "../dist/features/transcription/debater-settings.js";
import { createTranscriptionRepository } from "../dist/features/transcription/repository.js";
import {
  CATCH_UP_MAX,
  createOutlineRepository,
} from "../dist/features/outline/repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { applyEdits, emptyTurn } from "../dist/features/outline/reducer.js";

// Decision 0012, pull request 3: the server's live outline. Fixtures are this
// suite's own debates; window opening and freezing stay scoped to them.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe("live AI outline storage", { skip: !ownerUrl || !runtimeUrl }, () => {
  let owner, runtime, transcripts, outlines, windows, settings, topicId;
  before(async () => {
    for (const value of [ownerUrl, runtimeUrl]) {
      const url = new URL(value);
      assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
      assert.match(url.pathname, /^\/revocation_test_(ci|a4_(fresh|upgrade))$/);
    }
    const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
    owner = new pg.Pool({ ...options, connectionString: ownerUrl });
    runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
    transcripts = createTranscriptionRepository(runtime);
    outlines = createOutlineRepository(runtime);
    windows = createCoinDebateSandbox(runtime, "simulation", {
      turnWindows: true,
    });
    settings = createDebaterSettings(runtime);
    topicId = (
      await owner.query(
        "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Outlines','Synthetic outline fixture','Support','Oppose','published') RETURNING id",
        [`outlines-${randomUUID()}`],
      )
    ).rows[0].id;
  });
  after(async () => {
    await Promise.all([owner?.end(), runtime?.end()]);
  });
  const user = async () =>
    (await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]
      .id;
  async function liveDebate() {
    const a = await user(),
      b = await user();
    await settings.save(a, { language: "fr", consent: true });
    await settings.save(b, { language: "en", consent: true });
    const debateId = (
      await owner.query(
        `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,
          rules_snapshot,live_started_at,is_demo)
        VALUES($1,$2,'Faut-il garder le nucléaire ?','live','published','preview-1',
          '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":600}',
          clock_timestamp()-INTERVAL '1 minute',true) RETURNING id`,
        [`outlines-${randomUUID()}`, topicId],
      )
    ).rows[0].id;
    await owner.query(
      "INSERT INTO event_participants(debate_id,user_id,side) VALUES($1,$2,'A'),($1,$3,'B')",
      [debateId, a, b],
    );
    await owner.query(
      `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
        remaining_ms,active_ms,last_resumed_at,recording_status)
      VALUES($1,'running','A',1,clock_timestamp()+INTERVAL '59 seconds',60000,0,
        clock_timestamp()-INTERVAL '1 second','recording')`,
      [debateId],
    );
    await windows.openTurnWindows(20, [debateId]);
    return { debateId, a, b };
  }
  async function nextTurn(debateId) {
    await owner.query(
      `UPDATE debate_media SET active_side='B',turn_number=2,last_resumed_at=clock_timestamp(),
        turn_deadline_at=clock_timestamp()+INTERVAL '59 seconds' WHERE debate_id=$1`,
      [debateId],
    );
    await windows.openTurnWindows(20, [debateId]);
  }
  const proposal = (op, fields = {}) => ({
    op,
    argument: null,
    point: null,
    key: null,
    text: null,
    target: null,
    ...fields,
  });
  let sequence = 0;
  const update = ({
    turnNumber = 1,
    baseVersion = 0,
    edits = [],
    side = turnNumber === 1 ? "A" : "B",
  } = {}) => ({
    jobId: "AJ_outline",
    sequence: sequence++,
    turnNumber,
    sentAt: Date.now(),
    segments: [
      {
        provider: "deepgram",
        role: "primary",
        language: side === "A" ? "fr" : "en",
        side,
        startAt: Date.now() - 1500,
        endAt: Date.now() - 300,
        text: "Le nucléaire est pilotable.",
        words: [],
        latencyMs: 300,
        audioMs: 1200,
      },
    ],
    outline: {
      baseVersion,
      span: { startMs: 1000, endMs: 2500 },
      edits,
      model: "claude-haiku-5-5",
    },
  });
  const signals = async (debateId) =>
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM community_room_events WHERE room_id=$1 AND refresh='outline'",
        [debateId],
      )
    ).rows[0].n;

  it("stores each accepted proposal as the next version and answers with canonical edits", async () => {
    const { debateId } = await liveDebate();
    const first = await transcripts.ingest(
      debateId,
      update({
        edits: [
          proposal("add_argument", {
            key: "k",
            text: "Le nucléaire est pilotable",
          }),
          proposal("add_point", { argument: "k", text: "Production stable" }),
          proposal("add_point", {
            argument: "k",
            text: "Quel connard ce type",
          }),
        ],
      }),
    );
    assert.equal(first.status, 200);
    const answer = first.body.outline;
    assert.equal(answer.accepted, true);
    assert.equal(answer.version, 1);
    assert.equal(answer.side, "A");
    assert.equal(answer.language, "fr");
    assert.equal(answer.rejected, 1, "the insult never enters the outline");
    assert.deepEqual(
      answer.edits.map((e) => [e.op, e.id]),
      [
        ["add_argument", "t1a1"],
        ["add_point", "t1a1p1"],
      ],
    );
    const stored = (
      await owner.query(
        "SELECT outline, in_window, window_id IS NOT NULL AS has_window FROM outline_versions WHERE debate_id=$1",
        [debateId],
      )
    ).rows[0];
    assert.deepEqual(
      stored.outline,
      applyEdits(emptyTurn(1, "A", "fr"), answer.edits),
      "the stored outline is the one every client computes",
    );
    assert.equal(stored.in_window, true);
    assert.equal(stored.has_window, true);

    const stale = await transcripts.ingest(
      debateId,
      update({
        baseVersion: 0,
        edits: [proposal("add_point", { argument: "t1a1", text: "Late" })],
      }),
    );
    assert.equal(stale.body.outline.accepted, false);
    assert.equal(stale.body.outline.reason, "stale");
    assert.equal(stale.body.outline.version, 1);
    assert.equal(stale.body.outline.turn.arguments[0].id, "t1a1");
    assert.equal(stale.body.stored, 1, "its segments are still stored");

    const unchanged = await transcripts.ingest(
      debateId,
      update({
        baseVersion: 1,
        edits: [proposal("update_point", { point: "t1a1p9", text: "x" })],
      }),
    );
    assert.equal(unchanged.body.outline.reason, "unchanged");

    const next = await transcripts.ingest(
      debateId,
      update({
        baseVersion: 1,
        edits: [
          proposal("update_argument", {
            argument: "t1a1",
            text: "Le nucléaire est pilotable et bas carbone",
          }),
        ],
      }),
    );
    assert.equal(next.body.outline.version, 2);
    const state = await outlines.agentState(debateId, 1);
    assert.equal(state.version, 2);
    assert.equal(
      state.turn.arguments[0].label,
      "Le nucléaire est pilotable et bas carbone",
    );
    const session = await transcripts.session(debateId, "AJ_outline");
    assert.equal(session.proposition, "Faut-il garder le nucléaire ?");
    assert.equal(session.outline.version, 2);
    await assert.rejects(
      owner.query("UPDATE outline_versions SET model='x' WHERE debate_id=$1", [
        debateId,
      ]),
      /append-only/,
    );
  });

  it("lets a later turn rebut an earlier argument, and catches viewers up", async () => {
    const { debateId } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({
        edits: [proposal("add_argument", { text: "Le nucléaire est sûr" })],
      }),
    );
    await nextTurn(debateId);
    const rebuttal = await transcripts.ingest(
      debateId,
      update({
        turnNumber: 2,
        baseVersion: 1,
        edits: [
          proposal("add_argument", {
            key: "r",
            text: "Accidents still happen",
          }),
          proposal("link_rebuttal", { argument: "r", target: "t1a1" }),
          proposal("link_rebuttal", { argument: "r", target: "t9a9" }),
        ],
      }),
    );
    const answer = rebuttal.body.outline;
    assert.equal(answer.version, 2);
    assert.equal(answer.language, "en");
    assert.equal(answer.rejected, 1, "an unknown target is dropped");
    assert.deepEqual(answer.edits.at(-1), {
      op: "link_rebuttal",
      id: "t2a1",
      target: "t1a1",
    });
    const caughtUp = await outlines.since(debateId, 0);
    assert.equal(caughtUp.kind, "edits");
    assert.deepEqual(
      caughtUp.versions.map((v) => [v.version, v.turnNumber, v.side]),
      [
        [1, 1, "A"],
        [2, 2, "B"],
      ],
    );
    assert.deepEqual((await outlines.since(debateId, 2)).versions, []);
    const snapshot = await outlines.snapshot(debateId);
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.current.turnNumber, 2);
    assert.deepEqual(
      snapshot.turns.map((t) => [t.turnNumber, t.arguments[0].label, t.final]),
      [[1, "Le nucléaire est sûr", false]],
    );
    assert.equal(await outlines.isPublic(debateId), true);
    assert.equal(await outlines.isPublic(randomUUID()), false);
    assert.equal((await outlines.snapshot(randomUUID())).version, 0);
  });

  it("answers a viewer far behind with a snapshot", async () => {
    const { debateId } = await liveDebate();
    let version = 0;
    for (let i = 0; i <= CATCH_UP_MAX; i++) {
      const edits =
        i === 0
          ? [proposal("add_argument", { text: "Argument" })]
          : [
              proposal("update_argument", {
                argument: "t1a1",
                text: `Argument ${i}`,
              }),
            ];
      const result = await transcripts.ingest(
        debateId,
        update({ baseVersion: version, edits }),
      );
      version = result.body.outline.version;
    }
    assert.equal(version, CATCH_UP_MAX + 1);
    assert.equal((await outlines.since(debateId, 0)).kind, "snapshot");
    assert.equal((await outlines.since(debateId, 1)).kind, "edits");
  });

  it("freezes each window at its cutoff with the version traders saw", async () => {
    const { debateId } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({
        edits: [proposal("add_argument", { text: "Avant la clôture" })],
      }),
    );
    // Move the cutoff into the past, then add a version after it.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
      );
      // The cutoff falls just after version 1.
      await client.query(
        `UPDATE coin_debate_rounds r SET opens_at=v.created_at-INTERVAL '30 seconds',
          closes_at=v.created_at+INTERVAL '1 millisecond'
        FROM outline_versions v WHERE r.debate_id=$1 AND v.debate_id=$1 AND v.version=1`,
        [debateId],
      );
      await client.query(
        "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const late = await transcripts.ingest(
      debateId,
      update({
        baseVersion: 1,
        edits: [
          proposal("update_argument", {
            argument: "t1a1",
            text: "Après la clôture",
          }),
        ],
      }),
    );
    assert.equal(late.body.outline.version, 2);
    assert.equal(
      (
        await owner.query(
          "SELECT in_window FROM outline_versions WHERE debate_id=$1 AND version=2",
          [debateId],
        )
      ).rows[0].in_window,
      false,
    );
    const before = await signals(debateId);
    // Global freezing touches only windows with outlines, all past cutoff.
    await outlines.freezeDue(500);
    await outlines.freezeDue(500);
    const window = (
      await owner.query(
        "SELECT frozen_version, frozen_outline, final_outline FROM outline_windows WHERE debate_id=$1",
        [debateId],
      )
    ).rows;
    assert.equal(window.length, 1, "frozen once");
    assert.equal(window[0].frozen_version, 1);
    assert.equal(
      window[0].frozen_outline.arguments[0].label,
      "Avant la clôture",
    );
    assert.equal(window[0].final_outline, null);
    assert.equal(await signals(debateId), before + 1);
    await assert.rejects(
      owner.query("DELETE FROM outline_windows WHERE debate_id=$1", [debateId]),
      /append-only/,
    );
  });

  it("accepts flags only from the debater who spoke the turn", async () => {
    const { debateId, a, b } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({
        edits: [
          proposal("add_argument", { key: "k", text: "Le nucléaire est sûr" }),
          proposal("add_point", { argument: "k", text: "Peu d'accidents" }),
        ],
      }),
    );
    const before = await signals(debateId);
    assert.equal(
      await outlines.flag({
        debateId,
        userId: b,
        turnNumber: 1,
        itemId: "t1a1",
        note: null,
      }),
      null,
      "the other debater cannot flag",
    );
    assert.equal(
      await outlines.flag({
        debateId,
        userId: a,
        turnNumber: 1,
        itemId: "t1a9",
        note: null,
      }),
      null,
      "an unknown item cannot be flagged",
    );
    assert.deepEqual(
      await outlines.flag({
        debateId,
        userId: a,
        turnNumber: 1,
        itemId: "t1a1p1",
        note: "Ce n'est pas ce que j'ai dit",
      }),
      { side: "A" },
    );
    await outlines.flag({
      debateId,
      userId: a,
      turnNumber: 1,
      itemId: "t1a1p1",
      note: null,
    });
    assert.deepEqual((await outlines.snapshot(debateId)).flags, [
      { turnNumber: 1, itemId: "t1a1p1", side: "A" },
    ]);
    assert.equal(await signals(debateId), before + 1);
  });
});
