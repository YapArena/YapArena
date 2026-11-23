import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { createCoinDebateSandbox } from "../../dist/features/account-wallet/debate-sandbox.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../../dist/features/account-wallet/sandbox-repository.js";
import { createSessionRepository } from "../../dist/platform/auth/sessions.js";
import { createSessionToken } from "../../dist/platform/auth/session-tokens.js";
import { createMediaRepository } from "../../dist/features/media/repository.js";
import { countedRoundSql } from "../../dist/features/endorsement/repository.js";
import {
  viewerIdsNow,
  viewersInWindow,
  viewersNow,
} from "../../dist/features/presence/repository.js";
import { attachSubject, openSandbox } from "./confirmations.js";

// Decision 0012: one Yap Coins trading window per live speaking turn. These
// cases run inside coin-debate-postgres.test.js, so they never overlap its
// fixtures: global settlement locks every due round's accounts, and those
// fixtures hold account locks before waiting for the transition lock. Other
// PostgreSQL suites share the database in parallel, so window opening and
// voiding stay scoped to this file's own debates.
// Behaviour cases hold locks on purpose, sometimes for seconds, while other
// PostgreSQL suites run in parallel; they relax the sandbox's lock and
// statement timeouts, and the settlement batch's time budget, so a busy
// runner can't leave part of a small round for a later batch. Dedicated
// cases check the real limits and budget.
const relaxed = {
  limits: {
    request: { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 },
    worker: { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 },
  },
  settlement: { budgetMs: 10_000, quietBudgetMs: 10_000 },
};
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "turn-aligned Yap Coins trading windows",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, windows, manual, duels, topicId;
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
        ...relaxed,
        turnWindows: true,
      });
      manual = createCoinDebateSandbox(runtime, "simulation", relaxed);
      // Decision 0017: windows opened under forecast duels.
      duels = createCoinDebateSandbox(runtime, "simulation", {
        ...relaxed,
        turnWindows: true,
        duelWindows: true,
      });
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
    // Most fixtures ask their own question, so they are not counted in the
    // last-answer figure (Decision 0015); "Turn windows" is the topic title.
    async function liveDebate({
      status = "live",
      deadline = "60 seconds",
      reveal = "per_round",
      proposition = "Should each turn be one trading window?",
    } = {}) {
      const id = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,is_demo)
          VALUES($1,$2,$4,$3,'published','preview-1',
            '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":600}',
            clock_timestamp()-INTERVAL '1 second',true) RETURNING id`,
          [`turn-windows-${randomUUID()}`, topicId, status, proposition],
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
      // Decision 0013 (founder D5): with turn windows, nothing opens before
      // the debate is live, so nobody stakes before a scheduled start.
      await assert.rejects(
        windows.create(context, debateId, randomUUID()),
        (error) => error.code === "window_closed" && error.status === 409,
      );
      assert.equal((await rounds(debateId)).length, 0);
      // A five-minute round opened without the flag (an earlier release)
      // keeps its own series and does not hold back the turn windows.
      const early = await manual.create(context, debateId, randomUUID());
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
          "duels",
          "id",
          "opensAt",
          "pricing",
          "recording",
          "revealAt",
          "revealMode",
          "rule",
          "side",
          "state",
          "turnNumber",
          "voidReason",
        ]);
        assert.equal(window.rule, "a4-v1");
        assert.equal(window.pricing, null, "nothing priced before the reveal");
        assert.equal(window.duels, null, "no duel summary before the reveal");
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

    it("publishes a revealed window's pricing at any size, never before the reveal", async () => {
      const traders = [];
      for (let index = 0; index < 5; index++) traders.push(await funded());
      const orders = [
        ["YES", "0.7"],
        ["YES", "0.6"],
        ["YES", "0.55"],
        ["NO", "0.4"],
        ["NO", "0.5"],
      ];
      const commit = async (roundId, count) => {
        for (let index = 0; index < count; index++)
          await windows.submit(traders[index], roundId, randomUUID(), {
            side: orders[index][0],
            limit: orders[index][1],
            quantity: 10,
          });
      };
      const priced = (view) =>
        Object.fromEntries(view.windows.map((w) => [w.turnNumber, w.pricing]));
      // Per-round: turn 1 gets five commitments, turn 2 one.
      const debateId = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const [first] = await rounds(debateId);
      await commit(first.id, 5);
      await nextTurn(debateId);
      await windows.openTurnWindows(20, [debateId]);
      const second = (await rounds(debateId)).find((r) => r.turn_number === 2);
      await commit(second.id, 1);
      assert.deepEqual(priced(await windows.publicWindows(debateId)), {
        1: null,
        2: null,
      });
      await close(first.id);
      await close(second.id);
      await windows.advance(20);
      const stored = Object.fromEntries(
        (await rounds(debateId)).map((r) => [r.turn_number, r]),
      );
      assert.equal(stored[1].state, "settled");
      assert.equal(stored[2].state, "settled");
      const view = await windows.publicWindows(debateId);
      const [one, two] = view.windows;
      // The signed-in view's aggregate pricing, and nothing about any order.
      assert.deepEqual(one.pricing, stored[1].result.pricing);
      assert.deepEqual(Object.keys(one.pricing).sort(), [
        "a",
        "b",
        "branch",
        "price",
        "reason",
        "share",
      ]);
      assert.deepEqual(one.pricing.share, { n: "3", d: "5" });
      const signedIn = (await windows.view(traders[0], debateId)).find(
        (r) => r.id === first.id,
      );
      assert.deepEqual(one.pricing, signedIn.pricing);
      // Founder, 2026-10-26: revealed results are public at any size.
      assert.equal(two.state, "settled");
      assert.deepEqual(two.pricing, stored[2].result.pricing);
      assert.deepEqual(two.pricing.share, { n: "1", d: "1" });
      // Five-day: a locked window shows nothing until its 120-hour close.
      const fiveDay = await liveDebate({ reveal: "five_day" });
      await windows.openTurnWindows(20, [fiveDay]);
      const [locked] = await rounds(fiveDay);
      await commit(locked.id, 5);
      await close(locked.id);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [fiveDay],
      );
      await windows.advance(20);
      const pending = (await windows.publicWindows(fiveDay)).windows[0];
      assert.equal(pending.state, "open");
      assert.equal(pending.pricing, null);
    });

    // Decision 0015: the debate's last-answer figure rides on the window
    // list, counting only settled, revealed turns whose earlier turns are
    // closed, and only when the question is the topic title.
    it("adds the debate's last-answer figure once its turns are revealed", async () => {
      const traders = [];
      for (let index = 0; index < 3; index++) traders.push(await funded());
      const answer = (trader, roundId, side) =>
        windows.submit(traders[trader], roundId, randomUUID(), {
          side,
          limit: side === "YES" ? "0.6" : "0.4",
          quantity: 10,
        });
      const debateId = await liveDebate({ proposition: "Turn windows" });
      await windows.openTurnWindows(20, [debateId]);
      const [first] = await rounds(debateId);
      await answer(0, first.id, "YES");
      await answer(1, first.id, "YES");
      await answer(2, first.id, "NO");
      await nextTurn(debateId);
      await windows.openTurnWindows(20, [debateId]);
      const second = (await rounds(debateId)).find((r) => r.turn_number === 2);
      await answer(0, second.id, "NO");
      await answer(2, second.id, "YES");
      assert.equal(
        (await windows.publicWindows(debateId)).endorsement,
        null,
        "nothing before a reveal",
      );
      // Turn 2 settles first: it waits for turn 1 (closed-turn rule).
      await close(second.id);
      await windows.advance(20);
      assert.equal(
        (await rounds(debateId)).find((r) => r.turn_number === 2).state,
        "settled",
      );
      assert.deepEqual(
        (await windows.publicWindows(debateId)).endorsementTurns,
        [],
      );
      await close(first.id);
      await windows.advance(20);
      const revealed = await windows.publicWindows(debateId);
      // The figure through each counted turn, for a replay to follow.
      assert.deepEqual(revealed.endorsementTurns[0], {
        throughTurn: 1,
        yes: 2,
        accounts: 3,
        previous: null,
        switched: { toYes: 0, toNo: 0, cameBack: 0 },
        multiAnswerAccounts: 0,
      });
      assert.deepEqual(revealed.endorsementTurns[1], revealed.endorsement);
      assert.deepEqual((await windows.publicWindows(debateId)).endorsement, {
        throughTurn: 2,
        yes: 2,
        accounts: 3,
        previous: { throughTurn: 1, yes: 2, accounts: 3 },
        switched: { toYes: 1, toNo: 1, cameBack: 0 },
        multiAnswerAccounts: 2,
      });
      // The fold equals the SQL reference: each account's last answer.
      const reference = (
        await owner.query(
          `WITH kept AS (SELECT DISTINCT ON (o.user_id) o.side FROM coin_debate_orders o
             JOIN coin_debate_rounds r ON r.id=o.round_id WHERE r.debate_id=$1
             ORDER BY o.user_id, o.created_at DESC, r.revealed_at DESC, r.turn_number DESC, r.id DESC)
           SELECT count(*) FILTER (WHERE side='YES')::int AS yes, count(*)::int AS accounts FROM kept`,
          [debateId],
        )
      ).rows[0];
      assert.deepEqual(reference, { yes: 2, accounts: 3 });
      // A debate asking its own question keeps its per-turn results only.
      const own = await liveDebate();
      await windows.openTurnWindows(20, [own]);
      const [ownRound] = await rounds(own);
      await answer(0, ownRound.id, "YES");
      await close(ownRound.id);
      await windows.advance(20);
      const ownView = await windows.publicWindows(own);
      assert.ok(ownView.windows[0].pricing);
      assert.equal(ownView.endorsement, null);
      // Five-day: answers stay out until the 120-hour close.
      const fiveDay = await liveDebate({
        reveal: "five_day",
        proposition: "Turn windows",
      });
      await windows.openTurnWindows(20, [fiveDay]);
      const [locked] = await rounds(fiveDay);
      await answer(1, locked.id, "NO");
      await close(locked.id);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [fiveDay],
      );
      await windows.advance(20);
      const hidden = await windows.publicWindows(fiveDay);
      assert.equal(hidden.endorsement, null);
      assert.deepEqual(hidden.endorsementTurns, [], "no turn before the close");
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
      // Its own refusal, not the five-day rule (audit item 9).
      await assert.rejects(
        windows.submit(viewer, untimedWindow.id, randomUUID(), order(1)),
        (error) => error.code === "replay_untimed" && error.status === 409,
      );
      await assert.rejects(
        windows.submit(viewer, untimedWindow.id, randomUUID(), {
          ...order(),
          replayPositionMs: -1,
        }),
        /invalid replay position/,
      );
    });

    // PR 2 (audit item 9): an operator who ends a debate early closes its
    // open window to live orders, before the turn's own cutoff.
    it("refuses live orders once the debate is no longer live", async () => {
      const viewer = await funded(),
        debateId = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [debateId],
      );
      await assert.rejects(
        windows.submit(viewer, window.id, randomUUID(), order(1)),
        (error) => error.code === "window_closed" && error.status === 409,
      );
      const [view] = await windows.view(viewer, debateId);
      assert.equal(view.eligibility.reason, "closed");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_debate_orders WHERE round_id=$1",
            [window.id],
          )
        ).rows[0].n,
        0,
      );
      await owner.query("UPDATE debates SET status='cancelled' WHERE id=$1", [
        debateId,
      ]);
      await windows.voidUnavailable(20, [debateId]);
    });

    it("names debates stuck in live past their maximum duration", async () => {
      const stuck = await liveDebate(),
        recent = await liveDebate();
      // The fixture's maximum is 600 seconds; 30 minutes of grace follow.
      await owner.query(
        "UPDATE debates SET live_started_at=clock_timestamp()-INTERVAL '41 minutes' WHERE id=$1",
        [stuck],
      );
      const overdue = (await windows.overdueLive()).map((row) => row.debateId);
      assert.ok(overdue.includes(stuck));
      assert.ok(!overdue.includes(recent));
      const row = (await windows.overdueLive()).find(
        (entry) => entry.debateId === stuck,
      );
      assert.equal(row.maximumSeconds, 600);
      for (const id of [stuck, recent])
        await owner.query("UPDATE debates SET status='cancelled' WHERE id=$1", [
          id,
        ]);
    });

    // PR 2: a round larger than a batch settles over several batches, in
    // smaller ones while a live window is in its final seconds, and is
    // revealed only by the last one.
    it("settles a large round over several batches and reveals it with the last", async () => {
      const quiet = createCoinDebateSandbox(runtime, "simulation", {
        ...relaxed,
        settlement: { orders: 300, quietOrders: 1, quietSeconds: 15 },
      });
      const one = await funded(),
        two = await funded();
      const debateId = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      for (const viewer of [one, two])
        await windows.submit(viewer, window.id, randomUUID(), order());
      // A second live debate's window closes within 15 seconds: quiet.
      const closing = await liveDebate({ deadline: "10 seconds" });
      await windows.openTurnWindows(20, [closing]);
      await close(window.id);
      const progress = async () =>
        (
          await owner.query(
            `SELECT r.state,count(*) FILTER (WHERE q.status='settled')::int AS settled
            FROM coin_debate_rounds r JOIN coin_debate_orders o ON o.round_id=r.id
            JOIN coin_sandbox_requests q ON q.id=o.request_id WHERE r.id=$1 GROUP BY r.state`,
            [window.id],
          )
        ).rows[0];
      // Batches of one order: other suites' due rounds may come first.
      for (
        let attempt = 0;
        attempt < 20 && (await progress()).settled === 0;
        attempt++
      )
        await quiet.advance(20);
      assert.deepEqual(await progress(), { state: "open", settled: 1 });
      // Part-way through settlement, it can no longer be voided.
      await assert.rejects(
        createCoinDebateSandbox(owner, "simulation").voidRound(
          window.id,
          "operator_cancelled",
        ),
        /settlement has started/,
      );
      // Once no window of ours is closing, the last batch reveals it.
      for (const id of [closing, debateId])
        await owner.query(
          "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      for (
        let attempt = 0;
        attempt < 20 && (await progress()).state === "open";
        attempt++
      ) {
        // Other suites' live windows can make it quiet for a few seconds.
        await quiet.advance(20);
        await owner.query("SELECT pg_sleep(0.5)");
      }
      assert.deepEqual(await progress(), { state: "settled", settled: 2 });
      const [view] = await windows.view(one, debateId);
      assert.equal(view.state, "settled");
      assert.ok(view.outcome);
    });

    // Decision 0017: forecast duel windows.
    const example = [
      ["YES", "0.60", 10],
      ["YES", "0.70", 20],
      ["YES", "0.55", 10],
      ["NO", "0.66", 10],
      ["NO", "0.50", 40],
      ["YES", "0.75", 10],
    ];
    // Every YC an account holds: cash plus grant principal, reserved or not.
    const holdings = async (context) => {
      const { balances } = await sandbox.summary(context);
      return (
        BigInt(balances.cashAvailable) +
        BigInt(balances.reserved) +
        BigInt(balances.promotionalPrincipal) +
        BigInt(balances.promotionalReserved)
      );
    };
    async function duelWindow(viewers) {
      const debateId = await liveDebate({ reveal: "five_day" });
      await duels.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      const traders = [];
      for (const [side, limit, quantity] of example) {
        const context = await funded();
        traders.push({ context, before: await holdings(context) });
        await duels.submit(context, window.id, randomUUID(), {
          side,
          limit,
          quantity,
        });
      }
      for (let index = 0; index < viewers; index++)
        assert.deepEqual(await duels.recordPresence(await actor(), debateId), {
          present: true,
        });
      return { debateId, window, traders };
    }
    // Every projection matches its postings, and only backing goes negative.
    async function reconcile() {
      assert.equal(
        (
          await owner.query(`SELECT count(*)::int n FROM coin_accounts a WHERE environment='sandbox' AND balance<>
      (SELECT COALESCE(sum(amount),0) FROM coin_postings p WHERE p.account_id=a.id)`)
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_accounts WHERE environment='sandbox' AND kind<>'backing' AND balance<0",
          )
        ).rows[0].n,
        0,
      );
    }

    it("opens duel windows that reveal at each close and take no replay positions", async () => {
      const debateId = await liveDebate({ reveal: "five_day" });
      await duels.openTurnWindows(20, [debateId]);
      const stored = (
        await owner.query(
          "SELECT terms,reveal_mode FROM coin_debate_rounds WHERE debate_id=$1",
          [debateId],
        )
      ).rows[0];
      assert.equal(stored.terms.rule, "fd-v1");
      assert.equal(stored.terms.minViewers, 10);
      // The debate is five-day; a duel window still reveals at its cutoff.
      assert.equal(stored.reveal_mode, "per_round");
      // A ticket reserves its stake; the center sets aside twice the stake.
      const context = await funded();
      const [window] = await rounds(debateId);
      await duels.submit(context, window.id, randomUUID(), {
        side: "NO",
        limit: "0.4",
        quantity: 25,
      });
      const order = (
        await owner.query(
          "SELECT center_reservation::text,promotional_reservation::text FROM coin_debate_orders WHERE round_id=$1",
          [window.id],
        )
      ).rows[0];
      assert.equal(order.center_reservation, "500000");
      assert.ok(["0", "250000"].includes(order.promotional_reservation));
      // Placing a ticket counts its account as present.
      const client = await runtime.connect();
      try {
        assert.equal(await viewersInWindow(client, window.id), 1);
      } finally {
        client.release();
      }
      // After the debate ends, no replay position is taken.
      await close(window.id);
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [debateId],
      );
      await assert.rejects(
        duels.submit(await funded(), window.id, randomUUID(), {
          side: "YES",
          limit: "0.5",
          quantity: 10,
          replayPositionMs: 1000,
        }),
        (error) => error.code === "window_closed",
      );
    });

    it("settles a duel window with ten viewers present, paying from the losers", async () => {
      // Six tickets plus four accounts that only watch: ten present.
      const { debateId, window, traders } = await duelWindow(4);
      await close(window.id);
      await duels.advance(20);
      const [settled] = await rounds(debateId);
      assert.equal(settled.state, "settled");
      assert.equal(settled.result.duels.status, "settled");
      assert.equal(settled.result.duels.viewers, 10);
      assert.deepEqual(settled.result.duels.share, { n: "2", d: "3" });
      // Each account's holdings move by exactly its duel result.
      const nets = ["31325", "50150", "25075", "43375", "-162500", "12575"];
      for (const [index, trader] of traders.entries()) {
        assert.equal(
          (await holdings(trader.context)) - trader.before,
          BigInt(nets[index]),
        );
        const { balances } = await sandbox.summary(trader.context);
        assert.equal(balances.reserved, "0");
        assert.equal(balances.promotionalReserved, "0");
      }
      // The window is zero-sum, so the center's float comes back whole.
      assert.equal(
        nets.reduce((total, net) => total + BigInt(net), 0n),
        0n,
      );
      await reconcile();
      // Results show at once, to everyone.
      const [published] = (await duels.publicWindows(debateId)).windows;
      assert.equal(published.rule, "fd-v1");
      assert.deepEqual(published.duels, settled.result.duels);
      assert.deepEqual(published.pricing.share, { n: "2", d: "3" });
      assert.equal(published.pricing.branch, "duels");
      const own = (await duels.view(traders[4].context, debateId))[0];
      assert.equal(own.outcome.net, "-162500");
      assert.equal(own.outcome.duelsWon, 0);
      const { results } = await duels.results(traders[1].context, new Date(0));
      assert.equal(results[0].outcome.net, "50150");
      assert.equal(results[0].outcome.duelsWon, 3);
      // A settled duel window counts toward the last-answer figure.
      assert.equal(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM coin_debate_rounds r WHERE r.id=$1 AND ${countedRoundSql("$2")}`,
            [window.id, "simulation"],
          )
        ).rows[0].n,
        1,
      );
    });

    it("returns every stake of a duel window with fewer than ten viewers", async () => {
      const { debateId, window, traders } = await duelWindow(3);
      await close(window.id);
      await duels.advance(20);
      const [returned] = await rounds(debateId);
      assert.equal(returned.state, "settled");
      assert.equal(returned.result.duels.status, "returned_few_viewers");
      assert.equal(returned.result.duels.viewers, 9);
      assert.equal(returned.result.duels.share, null);
      for (const trader of traders)
        assert.equal(await holdings(trader.context), trader.before);
      await reconcile();
      const [published] = (await duels.publicWindows(debateId)).windows;
      assert.equal(published.pricing.share, null);
      assert.equal(published.duels.status, "returned_few_viewers");
      // A returned window publishes no share and is not counted.
      assert.equal(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM coin_debate_rounds r WHERE r.id=$1 AND ${countedRoundSql("$2")}`,
            [window.id, "simulation"],
          )
        ).rows[0].n,
        0,
      );
    });

    it("voids a cut turn's window in full, under either rule", async () => {
      for (const sandboxUnderTest of [duels, windows]) {
        const context = await funded(),
          before = await sandbox.summary(context);
        const debateId = await liveDebate();
        const round = await sandboxUnderTest.create(
          context,
          debateId,
          randomUUID(),
        );
        await sandboxUnderTest.submit(context, round.id, randomUUID(), {
          side: "YES",
          limit: "0.6",
          quantity: 10,
        });
        const voided = await sandboxUnderTest.voidTurnWindow(
          debateId,
          1,
          "turn_cut",
        );
        assert.deepEqual(voided, { roundId: round.id, created: true });
        assert.deepEqual(
          await sandboxUnderTest.voidTurnWindow(debateId, 1, "turn_cut"),
          { roundId: round.id, created: false },
        );
        assert.deepEqual(
          await sandboxUnderTest.voidTurnWindow(debateId, 7, "turn_cut"),
          { roundId: null, created: false },
        );
        const [stored] = await rounds(debateId);
        assert.equal(stored.state, "void");
        assert.equal(stored.result.voidReason, "turn_cut");
        const after = await sandbox.summary(context);
        assert.equal(after.balances.reserved, "0");
        assert.deepEqual(after.book, before.book);
      }
      await reconcile();
      // The runtime voids a manual round for a cut turn never.
      const manualDebate = await liveDebate({ status: "ready" });
      const manualRound = await manual.create(
        await actor(),
        manualDebate,
        randomUUID(),
      );
      await assert.rejects(
        runtime.query(
          `UPDATE coin_debate_rounds SET state='void',revealed_at=clock_timestamp(),
            result=jsonb_build_object('voidReason','turn_cut','snapshot','[]'::jsonb)
          WHERE id=$1`,
          [manualRound.id],
        ),
        /unauthorized outcome/,
      );
    });

    it("counts signed-in viewers present, never a seated debater", async () => {
      const debateId = await liveDebate();
      await duels.openTurnWindows(20, [debateId]);
      const [window] = await rounds(debateId);
      const watching = [await actor(), await actor()];
      for (const context of watching)
        assert.deepEqual(await duels.recordPresence(context, debateId), {
          present: true,
        });
      // A second heartbeat is one viewer, not two.
      await duels.recordPresence(watching[0], debateId);
      // A seated debater records nothing.
      const debater = await actor();
      const profile = (
        await owner.query(
          "INSERT INTO public_profiles(user_id,handle,display_name) VALUES($1,$2,'Seated') RETURNING id",
          [debater.userId, `seated${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id;
      await owner.query(
        "UPDATE debates SET speaker_a_profile_id=$2 WHERE id=$1",
        [debateId, profile],
      );
      assert.deepEqual(await duels.recordPresence(debater, debateId), {
        present: false,
      });
      const client = await runtime.connect();
      try {
        assert.equal(await viewersInWindow(client, window.id), 2);
        assert.equal(await viewersNow(client, debateId), 2);
        assert.deepEqual(
          await viewerIdsNow(client, debateId),
          watching
            .map((c) => String(c.userId))
            .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
        );
        // A viewer who takes a seat stops counting as present now at once.
        const seat = (
          await owner.query(
            "INSERT INTO public_profiles(user_id,handle,display_name) VALUES($1,$2,'Took a seat') RETURNING id",
            [watching[1].userId, `seat${randomUUID().slice(0, 8)}`],
          )
        ).rows[0].id;
        await owner.query(
          "UPDATE debates SET speaker_b_profile_id=$2 WHERE id=$1",
          [debateId, seat],
        );
        assert.deepEqual(await viewerIdsNow(client, debateId), [
          String(watching[0].userId),
        ]);
        // The window's count is fixed: it was a viewer when recorded.
        assert.equal(await viewersInWindow(client, window.id), 2);
        assert.equal(await viewersNow(client, debateId, 0), 0);
      } finally {
        client.release();
      }
      // No heartbeat counts after the window closes, nor once the debate ends.
      await close(window.id);
      const late = await actor();
      await duels.recordPresence(late, debateId);
      await owner.query("UPDATE debates SET status='ended' WHERE id=$1", [
        debateId,
      ]);
      assert.deepEqual(await duels.recordPresence(await actor(), debateId), {
        present: false,
      });
      const check = await runtime.connect();
      try {
        assert.equal(await viewersInWindow(check, window.id), 2);
      } finally {
        check.release();
      }
      await assert.rejects(
        runtime.query(
          "INSERT INTO coin_window_viewers(round_id,user_id) VALUES($1,$2)",
          [window.id, late.userId],
        ),
        /this window is not open/,
      );
    });
  },
);
