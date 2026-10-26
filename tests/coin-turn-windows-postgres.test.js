import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { attachSubject, openSandbox } from "./helpers/confirmations.js";

// Decision 0012: one Yap Coins trading window per live speaking turn. Other
// PostgreSQL suites share this database in parallel, so every coin-loop call
// here is scoped to this suite's own debates and never runs the global clocks.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "turn-aligned Yap Coins trading windows",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, windows, manual, topicId;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      sandbox = createCoinSandboxRepository(runtime, { rail: "simulation" });
      operator = createCoinSandboxOperatorRepository(owner, {
        rail: "simulation",
      });
      windows = createCoinDebateSandbox(runtime, "simulation", {
        turnWindows: true,
      });
      manual = createCoinDebateSandbox(runtime, "simulation");
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Turn windows','Synthetic turn window fixture','Support','Oppose','published') RETURNING id",
          [`turn-windows-${randomUUID()}`],
        )
      ).rows[0].id;
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    async function actor() {
      const user = (
        await owner.query(
          "INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation",
        )
      ).rows[0];
      const token = createSessionToken();
      await createSessionRepository(runtime).create(
        user.id,
        token.tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration: user.auth_generation },
      );
      await attachSubject(owner, user.id);
      await openSandbox(owner, user.id);
      return { userId: user.id, sessionTokenHash: token.tokenHash };
    }
    async function funded() {
      const context = await actor();
      await sandbox.initialize(context);
      const quote = await sandbox.quoteFunding(context, {
        amount: "10000000",
        idempotencyKey: randomUUID(),
      });
      await sandbox.confirmSimulatedFunding(context, { requestId: quote.id });
      for (const purpose of ["center", "promotional"])
        await operator.seedSandboxTreasury({
          userId: context.userId,
          purpose,
          amount: "1000000",
          idempotencyKey: randomUUID(),
        });
      return context;
    }
    // Live fixtures are demos so they never compete for the featured slot
    // that featured-postgres checks in parallel.
    // Recorded as per-round so windows settle at their cutoff (F11).
    async function liveDebate({
      status = "live",
      deadline = "60 seconds",
      reveal = "per_round",
    } = {}) {
      const id = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,is_demo)
          VALUES($1,$2,'Should each turn be one trading window?',$3,'published','preview-1',
            '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":600}',
            clock_timestamp()-INTERVAL '1 second',true) RETURNING id`,
          [`turn-windows-${randomUUID()}`, topicId, status],
        )
      ).rows[0].id;
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
          remaining_ms,active_ms,last_resumed_at,recording_status)
        VALUES($1,'running','A',1,clock_timestamp()+$2::interval,60000,0,clock_timestamp(),'recording')`,
        [id, deadline],
      );
      if (reveal === "per_round")
        await owner.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,'per_round','Founder-created test debate')",
          [id],
        );
      return id;
    }
    // The media clock's turn advance, as tick() writes it.
    async function nextTurn(debateId, deadline = "60 seconds") {
      await owner.query(
        `UPDATE debate_media SET active_side=CASE active_side WHEN 'A' THEN 'B' ELSE 'A' END,
          turn_number=turn_number+1,last_resumed_at=clock_timestamp(),
          turn_deadline_at=clock_timestamp()+$2::interval,revision=revision+1 WHERE debate_id=$1`,
        [debateId, deadline],
      );
    }
    async function rounds(debateId) {
      return (
        await owner.query(
          `SELECT id,turn_number,turn_side,creator_id,state,closes_at,result FROM coin_debate_rounds
          WHERE debate_id=$1 ORDER BY opens_at,id`,
          [debateId],
        )
      ).rows;
    }
    // Clock advancement is a privileged fixture action in a disposable database.
    async function close(roundId) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
        );
        await client.query(
          "UPDATE coin_debate_rounds SET opens_at=clock_timestamp()-INTERVAL '2 seconds',closes_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
          [roundId],
        );
        await client.query(
          "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    async function signals(debateId) {
      return (
        await owner.query(
          "SELECT refresh FROM community_room_events WHERE room_id=$1 AND refresh='window' ORDER BY cursor",
          [debateId],
        )
      ).rows.length;
    }

    it("opens exactly one window per live turn, cut off at the turn deadline", async () => {
      const debateId = await liveDebate();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          windows.openTurnWindows(20, [debateId]),
        ),
      );
      assert.equal(
        results.reduce((total, result) => total + result.opened, 0),
        1,
      );
      const [first] = await rounds(debateId);
      assert.equal(first.turn_number, 1);
      assert.equal(first.turn_side, "A");
      assert.equal(first.creator_id, null);
      assert.equal(first.state, "open");
      const deadline = (
        await owner.query(
          "SELECT turn_deadline_at FROM debate_media WHERE debate_id=$1",
          [debateId],
        )
      ).rows[0].turn_deadline_at;
      assert.equal(first.closes_at.getTime(), deadline.getTime());
      assert.equal(
        (await windows.openTurnWindows(20, [debateId])).opened,
        0,
        "a retry opens nothing",
      );
      assert.equal(await signals(debateId), 1);
      // Database uniqueness, independent of the loop's own check.
      await assert.rejects(
        owner.query(
          `INSERT INTO coin_debate_rounds(id,debate_id,turn_number,turn_side,proposition,rail,
            reference,terms,seed,seed_commitment,closes_at)
          SELECT $1,debate_id,turn_number,turn_side,proposition,rail,repeat('c',64),terms,seed,
            seed_commitment,closes_at FROM coin_debate_rounds WHERE id=$2`,
          [randomUUID(), first.id],
        ),
        /coin_debate_turn_window/,
      );
      // A window is system-opened; a manual round names its creator.
      await assert.rejects(
        owner.query("UPDATE coin_debate_rounds SET turn_number=2 WHERE id=$1", [
          first.id,
        ]),
        /immutable sandbox debate terms/,
      );

      await nextTurn(debateId);
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
      const all = await rounds(debateId);
      assert.deepEqual(
        all.map((r) => [r.turn_number, r.turn_side]),
        [
          [1, "A"],
          [2, "B"],
        ],
      );
      assert.equal(await signals(debateId), 2);
    });

    it("keeps a paused turn's cutoff and never opens a second window for it", async () => {
      const debateId = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      await owner.query(
        `UPDATE debate_media SET state='paused',remaining_ms=40000,turn_deadline_at=NULL,
          last_resumed_at=NULL,revision=revision+1 WHERE debate_id=$1`,
        [debateId],
      );
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 0);
      await owner.query(
        `UPDATE debate_media SET state='running',last_resumed_at=clock_timestamp(),
          turn_deadline_at=clock_timestamp()+INTERVAL '3 minutes',revision=revision+1
          WHERE debate_id=$1`,
        [debateId],
      );
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 0);
      const [same, ...others] = await rounds(debateId);
      assert.equal(others.length, 0);
      assert.equal(same.id, window.id);
      assert.equal(same.closes_at.getTime(), window.closes_at.getTime());
    });

    it("opens nothing for debates that are not live, turns about to end, or when disabled", async () => {
      const scheduled = await liveDebate({ status: "scheduled" }),
        ending = await liveDebate({ deadline: "500 milliseconds" }),
        live = await liveDebate();
      assert.equal(
        (await windows.openTurnWindows(20, [scheduled, ending])).opened,
        0,
      );
      assert.equal((await manual.openTurnWindows(20, [live])).opened, 0);
      assert.equal((await rounds(live)).length, 0);
      // A turn the loop missed gets no window; the current turn still does.
      await nextTurn(live);
      assert.equal((await windows.openTurnWindows(20, [live])).opened, 1);
      assert.deepEqual(
        (await rounds(live)).map((r) => r.turn_number),
        [2],
      );
    });

    it("returns the current turn's window to manual creation during a live debate", async () => {
      const context = await actor(),
        debateId = await liveDebate({ status: "ready" });
      // A five-minute round opened before the debate went live keeps its own
      // series and does not hold back the turn windows.
      const early = await windows.create(context, debateId, randomUUID());
      assert.equal(early.created, true);
      await owner.query("UPDATE debates SET status='live' WHERE id=$1", [
        debateId,
      ]);
      const joined = await windows.create(context, debateId, randomUUID());
      assert.equal(joined.created, true, "opened inline by the request");
      assert.notEqual(joined.id, early.id);
      assert.equal(
        (await windows.create(context, debateId, randomUUID())).id,
        joined.id,
      );
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 0);
      const view = await windows.view(context, debateId);
      const turn = view.find((r) => r.id === joined.id),
        old = view.find((r) => r.id === early.id);
      assert.equal(turn.kind, "turn");
      assert.equal(turn.turnNumber, 1);
      assert.equal(turn.side, "A");
      assert.equal(turn.voidReason, null);
      assert.equal(old.kind, "manual");
      assert.equal(old.turnNumber, null);
      // Paused before a window opened: nothing to join.
      const paused = await liveDebate();
      await owner.query(
        "UPDATE debate_media SET state='paused',turn_deadline_at=NULL WHERE debate_id=$1",
        [paused],
      );
      await assert.rejects(
        windows.create(context, paused, randomUUID()),
        /no trading window is open/,
      );
      assert.equal((await rounds(paused)).length, 0);
      // With the flag off, live debates keep the five-minute rounds.
      const unflagged = await liveDebate();
      const created = await manual.create(context, unflagged, randomUUID());
      const [row] = await rounds(unflagged);
      assert.equal(row.id, created.id);
      assert.equal(row.turn_number, null);
    });

    it("settles a window after its cutoff, and voids every open round of a cancelled debate", async () => {
      const context = await funded(),
        before = await sandbox.summary(context);
      const settledDebate = await liveDebate(),
        cancelledDebate = await liveDebate();
      for (const id of [settledDebate, cancelledDebate]) {
        const round = await windows.create(context, id, randomUUID());
        await windows.submit(context, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 10,
        });
      }
      const [settling] = await rounds(settledDebate),
        [voiding] = await rounds(cancelledDebate);
      await owner.query("UPDATE debates SET status='cancelled' WHERE id=$1", [
        cancelledDebate,
      ]);
      // Both are past cutoff; only the live debate's round may settle.
      await close(settling.id);
      await close(voiding.id);
      await windows.advance();
      assert.equal((await rounds(settledDebate))[0].state, "settled");
      assert.equal((await rounds(cancelledDebate))[0].state, "open");
      const signalsBefore = await signals(cancelledDebate);
      assert.deepEqual(await windows.voidUnavailable(20, [cancelledDebate]), {
        voided: 1,
      });
      assert.deepEqual(await windows.voidUnavailable(20, [cancelledDebate]), {
        voided: 0,
      });
      const [voided] = await rounds(cancelledDebate);
      assert.equal(voided.state, "void");
      assert.equal(voided.result.voidReason, "debate_unavailable");
      assert.equal(await signals(cancelledDebate), signalsBefore + 1);
      const event = (
        await owner.query(
          "SELECT metadata FROM coin_sandbox_events WHERE user_id=$1 AND kind='debate.voided'",
          [context.userId],
        )
      ).rows[0];
      assert.equal(event.metadata.actorRole, "yaparena_runtime");
      const view = (await windows.view(context, cancelledDebate))[0];
      assert.equal(view.state, "void");
      assert.equal(view.voidReason, "debate_unavailable");
      assert.equal(view.seed, undefined);
      // A one-sided window does not fill, and the void returns exact
      // sources, so the book is back where it started.
      const after = await sandbox.summary(context);
      assert.equal(after.balances.reserved, "0");
      assert.deepEqual(after.book, before.book);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT status FROM coin_sandbox_requests WHERE user_id=$1 AND kind='stake' ORDER BY created_at",
            [context.userId],
          )
        ).rows.map((row) => row.status),
        ["settled", "void"],
      );
    });

    it("lets the runtime void only rounds of unavailable debates", async () => {
      const debateId = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      const forge = (reason) =>
        runtime.query(
          `UPDATE coin_debate_rounds SET state='void',revealed_at=clock_timestamp(),
            result=jsonb_build_object('voidReason',$2::text,'snapshot','[]'::jsonb)
          WHERE id=$1`,
          [window.id, reason],
        );
      await assert.rejects(forge("debate_unavailable"), /unauthorized outcome/);
      await owner.query("UPDATE debates SET status='void_review' WHERE id=$1", [
        debateId,
      ]);
      await assert.rejects(forge("operator_cancelled"), /unauthorized outcome/);
      await assert.rejects(
        windows.voidRound(window.id, "debate_unavailable"),
        /operator ownership/,
      );
      assert.deepEqual(await windows.voidUnavailable(20, [debateId]), {
        voided: 1,
      });
    });

    it("publishes only window timing and state to every viewer", async () => {
      const debateId = await liveDebate();
      assert.deepEqual((await windows.publicWindows(debateId)).windows, []);
      await windows.openTurnWindows(20, [debateId]);
      await nextTurn(debateId);
      await windows.openTurnWindows(20, [debateId]);
      const view = await windows.publicWindows(debateId);
      assert.equal(view.debateId, debateId);
      assert.equal(view.eventStatus, "live");
      assert.ok(view.serverNow instanceof Date);
      assert.deepEqual(
        view.windows.map((w) => [w.turnNumber, w.side, w.state, w.voidReason]),
        [
          [1, "A", "open", null],
          [2, "B", "open", null],
        ],
      );
      assert.equal(view.revealMode, "per_round");
      assert.equal(view.revealAt, null);
      for (const window of view.windows) {
        assert.deepEqual(Object.keys(window).sort(), [
          "closesAt",
          "id",
          "opensAt",
          "recording",
          "revealAt",
          "revealMode",
          "side",
          "state",
          "turnNumber",
          "voidReason",
        ]);
        assert.equal(window.revealMode, "per_round");
        assert.equal(window.revealAt, window.closesAt, "reveals at its cutoff");
      }
      // A user-created debate reveals at its 120-hour close (F11).
      const fiveDay = await liveDebate({ reveal: "five_day" });
      await windows.openTurnWindows(20, [fiveDay]);
      const pending = await windows.publicWindows(fiveDay);
      assert.equal(pending.revealMode, "five_day");
      assert.equal(pending.revealAt, null, "unknown until the debate ends");
      assert.equal(pending.windows[0].revealMode, "five_day");
      assert.equal(pending.windows[0].revealAt, null);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [fiveDay],
      );
      const ended = await windows.publicWindows(fiveDay);
      assert.ok(
        ended.revealAt instanceof Date || typeof ended.revealAt === "string",
      );
      assert.equal(
        new Date(ended.windows[0].revealAt).getTime(),
        new Date(ended.revealAt).getTime(),
      );
      await owner.query(
        "UPDATE debates SET publication_state='draft' WHERE id=$1",
        [debateId],
      );
      assert.equal(await windows.publicWindows(debateId), null);
    });

    // Turn windows' places in time, seconds before one shared instant
    // (guard bypassed): [roundId, opensAgo, closesAgo] each.
    async function place(placements) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
        );
        for (const [roundId, opensAgo, closesAgo] of placements)
          await client.query(
            `UPDATE coin_debate_rounds SET opens_at=now()-$2*INTERVAL '1 second',
              closes_at=now()-$3*INTERVAL '1 second' WHERE id=$1`,
            [roundId, opensAgo, closesAgo],
          );
        await client.query(
          "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    // Three one-minute turns that started an hour ago, a recording that
    // started 2 s before the first turn, and a debate that ended after them.
    async function replayedDebate({
      reveal = "five_day",
      endedAgo = 3000,
    } = {}) {
      const debateId = await liveDebate({ reveal });
      for (let turn = 1; turn <= 3; turn++) {
        if (turn > 1) await nextTurn(debateId);
        await windows.openTurnWindows(20, [debateId]);
      }
      const list = await rounds(debateId);
      await place(
        list.map((round, index) => [
          round.id,
          3600 - 60 * index,
          3540 - 60 * index,
        ]),
      );
      const egress = `egress-${randomUUID()}`;
      await owner.query(
        `UPDATE debate_media SET state='ended',egress_id=$2,recording_key=$3,
          recording_status='processing' WHERE debate_id=$1`,
        [debateId, egress, `debates/${debateId}/recording.mp4`],
      );
      await owner.query(
        `UPDATE debates SET status='ended',live_started_at=clock_timestamp()-$2*INTERVAL '1 second'-INTERVAL '1 hour',
          live_ended_at=clock_timestamp()-$2*INTERVAL '1 second'
        WHERE id=$1`,
        [debateId, endedAgo],
      );
      const started = (
        await owner.query(
          "SELECT opens_at-INTERVAL '2 seconds' AS at FROM coin_debate_rounds WHERE id=$1",
          [list[0].id],
        )
      ).rows[0].at;
      const media = createMediaRepository(runtime);
      const state = await media.recordingEnded(
        egress,
        true,
        `debates/${debateId}/recording.mp4`,
        started,
      );
      assert.equal(state.recordingStatus, "ready");
      return {
        debateId,
        windows: list.map((round) => round.id),
        media,
        egress,
      };
    }
    const order = (replayPositionSeconds) => ({
      side: "YES",
      limit: "1",
      quantity: 1,
      ...(replayPositionSeconds === undefined
        ? {}
        : { replayPositionMs: Math.floor(replayPositionSeconds * 1000) }),
    });

    it("lets replay viewers join the window playing at their position, never an earlier one", async () => {
      const viewer = await funded();
      const replay = await replayedDebate();
      const [first, second, third] = replay.windows;
      // The clock is written once, even when the completion is reported again.
      await replay.media.recordingEnded(
        replay.egress,
        true,
        `debates/${replay.debateId}/recording.mp4`,
        new Date(),
      );
      const spans = (await windows.publicWindows(replay.debateId)).windows.map(
        (w) => w.recording,
      );
      assert.deepEqual(spans, [
        { startSeconds: 2, endSeconds: 62 },
        { startSeconds: 62, endSeconds: 122 },
        { startSeconds: 122, endSeconds: 182 },
      ]);
      await assert.rejects(
        windows.submit(viewer, second, randomUUID(), order()),
        /past cutoff/,
      );
      await assert.rejects(
        windows.submit(viewer, second, randomUUID(), order(30)),
        /not playing at that replay position/,
      );
      const joined = await windows.submit(
        viewer,
        second,
        randomUUID(),
        order(90.5),
      );
      assert.equal(
        (
          await owner.query(
            "SELECT replay_position_ms FROM coin_debate_orders WHERE request_id=$1",
            [joined.id],
          )
        ).rows[0].replay_position_ms,
        90500,
      );
      await assert.rejects(
        windows.submit(viewer, first, randomUUID(), order(30)),
        /already joined a later turn's window/,
      );
      const view = await windows.view(viewer, replay.debateId);
      const byId = new Map(view.map((round) => [round.id, round]));
      assert.equal(byId.get(first).eligibility.reason, "later_window");
      assert.equal(byId.get(second).eligibility.reason, "committed");
      assert.equal(byId.get(second).own.replayPositionMs, 90500);
      assert.deepEqual(byId.get(third).eligibility, {
        canTakePosition: true,
        reason: null,
        via: "replay",
      });
      assert.deepEqual(byId.get(third).recording, {
        startSeconds: 122,
        endSeconds: 182,
      });
      assert.equal(byId.get(second).participants, 1, "replay joiners count");
      // The database refuses an earlier window too.
      await assert.rejects(
        runtime.query(
          `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,
            funding,center_reservation,promotional_reservation,replay_position_ms)
          VALUES($1,$2,$3,'YES','1',1,'{}'::jsonb,1,0,30000)`,
          [first, viewer.userId, randomUUID()],
        ),
        /later turn's window was already joined/,
      );
      await assert.rejects(
        runtime.query(
          `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,
            funding,center_reservation,promotional_reservation,replay_position_ms)
          VALUES($1,$2,$3,'YES','1',1,'{}'::jsonb,1,0,30000)`,
          [third, viewer.userId, randomUUID()],
        ),
        /not playing at that replay position/,
      );
      // Another viewer may start from the first window.
      const other = await funded();
      await windows.submit(other, first, randomUUID(), order(2));
      await windows.submit(other, third, randomUUID(), order(182));
    });

    it("takes no replay positions from per-round, live or closed debates", async () => {
      const viewer = await funded();
      // These windows are due for settlement, which another suite's coin
      // loop may do first: either refusal is right. They are voided after.
      const refused =
        /only by a five-day debate's turn windows|round is closed/;
      const perRound = await replayedDebate({ reveal: "per_round" });
      await assert.rejects(
        windows.submit(viewer, perRound.windows[1], randomUUID(), order(90)),
        refused,
      );
      const [perRoundView] = await windows.view(viewer, perRound.debateId);
      assert.equal(perRoundView.eligibility.reason, "closed");
      const closed = await replayedDebate({ endedAgo: 121 * 3600 });
      await assert.rejects(
        windows.submit(viewer, closed.windows[1], randomUUID(), order(90)),
        refused,
      );
      for (const { debateId } of [perRound, closed]) {
        await owner.query("UPDATE debates SET status='cancelled' WHERE id=$1", [
          debateId,
        ]);
        await windows.voidUnavailable(20, [debateId]);
      }
      // A live debate's past window takes no replay position either.
      const live = await liveDebate({ reveal: "five_day" });
      await windows.openTurnWindows(20, [live]);
      const [window] = await rounds(live);
      await close(window.id);
      await assert.rejects(
        windows.submit(viewer, window.id, randomUUID(), order(1)),
        /only by a five-day debate's turn windows/,
      );
      // Without a recording clock there is no span.
      const untimed = await liveDebate({ reveal: "five_day" });
      await windows.openTurnWindows(20, [untimed]);
      const [untimedWindow] = await rounds(untimed);
      await close(untimedWindow.id);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [untimed],
      );
      const [untimedView] = await windows.view(viewer, untimed);
      assert.equal(untimedView.recording, null);
      assert.equal(untimedView.eligibility.reason, "closed");
      await assert.rejects(
        windows.submit(viewer, untimedWindow.id, randomUUID(), order(1)),
        /only by a five-day debate's turn windows/,
      );
      await assert.rejects(
        windows.submit(viewer, untimedWindow.id, randomUUID(), {
          ...order(),
          replayPositionMs: -1,
        }),
        /invalid replay position/,
      );
    });
  },
);
