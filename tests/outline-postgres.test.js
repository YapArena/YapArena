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
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { attachSubject, openSandbox } from "./helpers/confirmations.js";

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

  // Pull request 4: cleanup, final outlines, replay timeline, correlation.
  async function withoutTrigger(table, trigger, work) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await work(client);
      // Run the deferred room-signal triggers before re-enabling.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  // Every window of the debate closed a moment ago.
  const closeWindows = (debateId) =>
    withoutTrigger("coin_debate_rounds", "coin_debate_round_guard", (c) =>
      c.query(
        `UPDATE coin_debate_rounds SET closes_at=clock_timestamp()-INTERVAL '1 millisecond',
          opens_at=least(opens_at, clock_timestamp()-INTERVAL '2 seconds')
        WHERE debate_id=$1`,
        [debateId],
      ),
    );
  // Every window of the debate closed this many seconds ago.
  const closedAgo = (debateId, seconds) =>
    withoutTrigger("coin_debate_rounds", "coin_debate_round_guard", (c) =>
      c.query(
        `UPDATE coin_debate_rounds SET closes_at=clock_timestamp()-$2*INTERVAL '1 second',
          opens_at=least(opens_at, clock_timestamp()-($2+1)*INTERVAL '1 second')
        WHERE debate_id=$1`,
        [debateId, seconds],
      ),
    );
  // The debate ended and its recording started two minutes ago.
  async function ended(debateId) {
    await owner.query(
      "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
      [debateId],
    );
    await runtime.query(
      `INSERT INTO recording_clocks(debate_id,egress_id,started_at)
      VALUES ($1,$2,clock_timestamp()-INTERVAL '2 minutes')`,
      [debateId, `egress-${randomUUID()}`],
    );
  }
  const windowCount = async (debateId) =>
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM outline_windows WHERE debate_id=$1",
        [debateId],
      )
    ).rows[0].n;
  // Their freeze happened this many seconds ago.
  const frozeAgo = (debateId, seconds) =>
    withoutTrigger("outline_windows", "outline_windows_append_only", (c) =>
      c.query(
        `UPDATE outline_windows SET frozen_at=clock_timestamp()-$2*INTERVAL '1 second'
        WHERE debate_id=$1`,
        [debateId, seconds],
      ),
    );
  const cleanup = (turnNumber, items) => ({
    jobId: "AJ_outline",
    turnNumber,
    model: "claude-sonnet-5-5",
    arguments: items,
  });
  const item = (id, label, points = [], links = {}) => ({
    id,
    label,
    points,
    rebuts: null,
    continues: null,
    ...links,
  });

  it("accepts one cleanup per window within a minute of its freeze", async () => {
    const { debateId } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({
        edits: [
          proposal("add_argument", {
            key: "k",
            text: "Le nucléaire est pilotable",
          }),
          proposal("add_point", {
            argument: "k",
            text: "Il produit à la demande",
          }),
        ],
      }),
    );
    const rewrite = cleanup(1, [
      item("t1a1", "Le nucléaire est pilotable et sûr", [
        "Il produit à la demande",
        "Espèce d'idiot",
        "Peu d'accidents graves",
      ]),
      item(null, "Les renouvelables ne suffisent pas", [], { rebuts: "t9a9" }),
    ]);
    assert.deepEqual((await outlines.applyCleanup(debateId, rewrite)).body, {
      accepted: false,
      reason: "not_frozen",
    });
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    const before = await signals(debateId);
    const accepted = await outlines.applyCleanup(debateId, rewrite);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.dropped, 1, "the insult never becomes final");
    assert.deepEqual(accepted.body.turn, {
      turnNumber: 1,
      side: "A",
      language: "fr",
      arguments: [
        {
          id: "t1a1",
          label: "Le nucléaire est pilotable et sûr",
          rebuts: null,
          continues: null,
        },
        {
          id: "t1a2",
          label: "Les renouvelables ne suffisent pas",
          rebuts: null,
          continues: null,
        },
      ],
      final: true,
    });
    const stored = (
      await owner.query(
        "SELECT final_outline, final_source, final_model FROM outline_windows WHERE debate_id=$1",
        [debateId],
      )
    ).rows[0];
    assert.equal(stored.final_source, "cleanup");
    assert.equal(stored.final_model, "claude-sonnet-5-5");
    assert.deepEqual(
      stored.final_outline.arguments[0].points.map((point) => point.id),
      ["t1a1p1", "t1a1p2"],
      "the unchanged point keeps its live ID",
    );
    assert.equal(await signals(debateId), before + 1);
    assert.equal(
      (await outlines.applyCleanup(debateId, rewrite)).body.reason,
      "final",
    );
    const snapshot = await outlines.snapshot(debateId);
    assert.equal(snapshot.finals, 1);
    assert.deepEqual(
      (await outlines.applyCleanup(debateId, cleanup(2, [item(null, "Rien")])))
        .body.reason,
      "not_frozen",
    );
  });

  it("keeps the frozen outline as final when no cleanup comes in time", async () => {
    const { debateId } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({ edits: [proposal("add_argument", { text: "Gelé tel quel" })] }),
    );
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    assert.equal(
      (
        await outlines.applyCleanup(
          debateId,
          cleanup(1, [item("t1a1", "Hors d'atteinte ", ["idiot"])]),
        )
      ).status,
      201,
      "a cleanup whose points are all refused still keeps its label",
    );
    const other = await liveDebate();
    await transcripts.ingest(
      other.debateId,
      update({ edits: [proposal("add_argument", { text: "Trop tard" })] }),
    );
    await closeWindows(other.debateId);
    await outlines.freezeDue(500);
    await frozeAgo(other.debateId, 61);
    assert.equal(
      (
        await outlines.applyCleanup(
          other.debateId,
          cleanup(1, [item("t1a1", "Réécrit")]),
        )
      ).body.reason,
      "late",
    );
    assert.ok((await outlines.finalizeDue(500)).finalized >= 1);
    const final = (
      await owner.query(
        "SELECT final_outline, frozen_outline, final_source FROM outline_windows WHERE debate_id=$1",
        [other.debateId],
      )
    ).rows[0];
    assert.equal(final.final_source, "frozen");
    assert.deepEqual(final.final_outline, final.frozen_outline);
    assert.equal(
      (await outlines.snapshot(other.debateId)).finals,
      1,
      "the ETag changes with it",
    );
    // Only labels the filter refuses drop a whole argument.
    const empty = await liveDebate();
    await transcripts.ingest(
      empty.debateId,
      update({ edits: [proposal("add_argument", { text: "Vide" })] }),
    );
    await closeWindows(empty.debateId);
    await outlines.freezeDue(500);
    assert.equal(
      (
        await outlines.applyCleanup(
          empty.debateId,
          cleanup(1, [item("t1a1", "idiot")]),
        )
      ).body.reason,
      "empty",
    );
  });

  it("freezes a turn with its cleanup when all live calls failed", async () => {
    const { debateId } = await liveDebate();
    // No live outline call succeeded: the transcript arrives with no proposal.
    const segments = update();
    delete segments.outline;
    assert.equal((await transcripts.ingest(debateId, segments)).status, 200);
    const rewrite = cleanup(1, [
      item(null, "Le nucléaire est pilotable", ["Il produit à la demande"]),
    ]);
    assert.equal(
      (await outlines.applyCleanup(debateId, rewrite)).body.reason,
      "not_frozen",
      "before the window's cutoff",
    );
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    assert.equal(await windowCount(debateId), 0, "no version to freeze");
    const before = await signals(debateId);
    const accepted = await outlines.applyCleanup(debateId, rewrite);
    assert.equal(accepted.status, 201);
    assert.deepEqual(accepted.body.turn, {
      turnNumber: 1,
      side: "A",
      language: "fr",
      arguments: [
        {
          id: "t1a1",
          label: "Le nucléaire est pilotable",
          rebuts: null,
          continues: null,
        },
      ],
      final: true,
    });
    const stored = (
      await owner.query(
        `SELECT frozen_version, frozen_outline, final_source, final_model,
          finalized_at IS NOT NULL AS final FROM outline_windows WHERE debate_id=$1`,
        [debateId],
      )
    ).rows[0];
    assert.equal(stored.frozen_version, null);
    assert.deepEqual(
      stored.frozen_outline,
      emptyTurn(1, "A", "fr"),
      "traders saw an empty outline",
    );
    assert.equal(stored.final_source, "cleanup");
    assert.equal(stored.final_model, "claude-sonnet-5-5");
    assert.equal(stored.final, true);
    assert.equal(await signals(debateId), before + 1);
    assert.equal(
      (await outlines.applyCleanup(debateId, rewrite)).body.reason,
      "final",
    );
    const snapshot = await outlines.snapshot(debateId);
    assert.equal(snapshot.current, null, "no live turn");
    assert.equal(snapshot.finals, 1);
    assert.deepEqual(
      snapshot.turns.map((turn) => [turn.turnNumber, turn.final]),
      [[1, true]],
    );
    const state = await outlines.agentState(debateId, 1);
    assert.equal(state.turn, null);
    assert.deepEqual(
      state.map.map((entry) => entry.id),
      ["t1a1"],
    );
  });

  it("freezes a turn with its cleanup when Haiku returned no usable edit", async () => {
    const { debateId } = await liveDebate();
    const unusable = await transcripts.ingest(
      debateId,
      update({
        edits: [proposal("update_point", { point: "t1a1p9", text: "x" })],
      }),
    );
    assert.equal(unusable.body.outline.reason, "unchanged");
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    await ended(debateId);
    assert.equal(
      (await outlines.timeline(debateId)).complete,
      false,
      "its cleanup may still come",
    );
    const accepted = await outlines.applyCleanup(
      debateId,
      cleanup(1, [item(null, "Rien de neuf")]),
    );
    assert.equal(accepted.status, 201);
    const timeline = await outlines.timeline(debateId);
    assert.equal(timeline.complete, true);
    assert.deepEqual(
      timeline.turns.map((turn) => [turn.turnNumber, turn.final]),
      [[1, true]],
    );

    // More than a minute after the cutoff, the cleanup is late, and the
    // timeline no longer waits for it.
    const late = await liveDebate();
    await transcripts.ingest(
      late.debateId,
      update({
        edits: [proposal("update_point", { point: "t1a1p9", text: "x" })],
      }),
    );
    await closedAgo(late.debateId, 61);
    assert.equal(
      (
        await outlines.applyCleanup(
          late.debateId,
          cleanup(1, [item(null, "Trop tard")]),
        )
      ).body.reason,
      "late",
    );
    assert.equal(await windowCount(late.debateId), 0);
    await ended(late.debateId);
    assert.equal((await outlines.timeline(late.debateId)).complete, true);
  });

  it("serves the replay timeline in recording time", async () => {
    const { debateId } = await liveDebate();
    await transcripts.ingest(
      debateId,
      update({ edits: [proposal("add_argument", { text: "Premier" })] }),
    );
    await transcripts.ingest(
      debateId,
      update({
        baseVersion: 1,
        edits: [proposal("add_argument", { text: "Second" })],
      }),
    );
    let timeline = await outlines.timeline(debateId);
    assert.equal(timeline.timed, false);
    assert.equal(timeline.complete, false);
    assert.deepEqual(
      timeline.versions.map((version) => [version.version, version.at]),
      [
        [1, null],
        [2, null],
      ],
    );
    await runtime.query(
      `INSERT INTO recording_clocks(debate_id,egress_id,started_at)
      SELECT $1,'egress-timeline',created_at-INTERVAL '5 seconds'
      FROM outline_versions WHERE debate_id=$1 AND version=1`,
      [debateId],
    );
    timeline = await outlines.timeline(debateId);
    assert.equal(timeline.timed, true);
    assert.equal(timeline.versions[0].at, 5000);
    assert.ok(timeline.versions[1].at >= 5000);
    assert.deepEqual(timeline.versions[1].edits[0].label, "Second");
    assert.equal(timeline.turns[0].arguments.length, 2);
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    await frozeAgo(debateId, 61);
    await outlines.finalizeDue(500);
    await owner.query(
      "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
      [debateId],
    );
    timeline = await outlines.timeline(debateId);
    assert.equal(timeline.complete, true, "immutable from now on");
    assert.equal(timeline.turns[0].final, true);
  });

  async function funded() {
    const sandbox = createCoinSandboxRepository(runtime, {
      rail: "simulation",
    });
    const operator = createCoinSandboxOperatorRepository(owner, {
      rail: "simulation",
    });
    const id = await user();
    const token = createSessionToken();
    const generation = (
      await owner.query("SELECT auth_generation FROM users WHERE id=$1", [id])
    ).rows[0].auth_generation;
    await createSessionRepository(runtime).create(
      id,
      token.tokenHash,
      new Date(Date.now() + 600000),
      { authGeneration: generation },
    );
    await attachSubject(owner, id);
    await openSandbox(owner, id);
    const context = { userId: id, sessionTokenHash: token.tokenHash };
    await sandbox.initialize(context);
    for (const purpose of ["center", "promotional"])
      await operator.seedSandboxTreasury({
        userId: id,
        purpose,
        amount: "1000000",
        idempotencyKey: randomUUID(),
      });
    return context;
  }
  async function commit(windowId, side, { replayPositionMs } = {}) {
    const context = await funded();
    await windows.submit(context, windowId, randomUUID(), {
      side,
      limit: "1",
      quantity: 10,
      ...(replayPositionMs === undefined ? {} : { replayPositionMs }),
    });
  }
  const windowOf = async (debateId, turnNumber) =>
    (
      await owner.query(
        "SELECT id FROM coin_debate_rounds WHERE debate_id=$1 AND turn_number=$2",
        [debateId, turnNumber],
      )
    ).rows[0].id;

  it("correlates endorsement with each argument from revealed windows only", async () => {
    const { debateId } = await liveDebate();
    const first = await windowOf(debateId, 1);
    // Two commitments before the argument appears, four after.
    await commit(first, "YES");
    await commit(first, "NO");
    await transcripts.ingest(
      debateId,
      update({ edits: [proposal("add_argument", { text: "Pilotable" })] }),
    );
    for (const side of ["YES", "YES", "NO", "NO"]) await commit(first, side);
    await nextTurn(debateId);
    const second = await windowOf(debateId, 2);
    await transcripts.ingest(
      debateId,
      update({
        turnNumber: 2,
        baseVersion: 1,
        edits: [proposal("add_argument", { text: "Too expensive" })],
      }),
    );
    await commit(second, "NO");
    await closeWindows(debateId);
    await outlines.freezeDue(500);
    await frozeAgo(debateId, 61);
    await outlines.finalizeDue(500);
    // Unrevealed windows report nothing.
    assert.deepEqual((await outlines.correlation(debateId)).windows, []);
    // A replay viewer joins the first window after the argument appeared.
    await owner.query(
      "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
      [debateId],
    );
    const started = (
      await owner.query("SELECT opens_at FROM coin_debate_rounds WHERE id=$1", [
        first,
      ])
    ).rows[0].opens_at;
    await runtime.query(
      "INSERT INTO recording_clocks(debate_id,egress_id,started_at) VALUES($1,'egress-correlation',$2)",
      [debateId, started],
    );
    const appearedMs = (
      await owner.query(
        `SELECT floor(extract(epoch FROM v.created_at-r.opens_at)*1000)::int AS ms
        FROM outline_versions v, coin_debate_rounds r
        WHERE v.debate_id=$1 AND v.version=1 AND r.id=$2`,
        [debateId, first],
      )
    ).rows[0].ms;
    await commit(first, "YES", { replayPositionMs: appearedMs + 10 });
    await withoutTrigger("coin_debate_rounds", "coin_debate_round_guard", (c) =>
      c.query(
        `UPDATE coin_debate_rounds SET state='settled',result='{"snapshot":[]}'::jsonb,
            revealed_at=clock_timestamp() WHERE debate_id=$1`,
        [debateId],
      ),
    );
    const correlation = await outlines.correlation(debateId);
    assert.equal(correlation.minimumCount, 5);
    assert.deepEqual(correlation.windows, [
      { turnNumber: 1, side: "A", yesShare: 4 / 7, change: null },
      { turnNumber: 2, side: "B", yesShare: null, change: null },
    ]);
    assert.deepEqual(correlation.arguments, [
      {
        id: "t1a1",
        turnNumber: 1,
        side: "A",
        label: "Pilotable",
        thread: "t1a1",
        onScreenShare: 5 / 7,
      },
      {
        id: "t2a1",
        turnNumber: 2,
        side: "B",
        label: "Too expensive",
        thread: "t2a1",
        onScreenShare: null,
      },
    ]);
  });
});
