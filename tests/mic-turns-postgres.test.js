import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createMediaOperations } from "../dist/features/media/operations.js";
import { createMicRepository } from "../dist/features/mic/repository.js";
import { createMicTurns } from "../dist/features/mic/turns.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { withTransaction } from "../dist/platform/transaction.js";
import { attachSubject, openSandbox } from "./helpers/confirmations.js";

// Decision 0018, PR 2b: the mic in the turn engine on PostgreSQL, with the
// turn windows of Decision 0012 and the cut-turn refund of Decision 0017.
// Clocks are moved on this file's own debates only, never through the
// global tick, because other PostgreSQL suites share the database.
const YC = 10_000n;
const relaxed = { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 };
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "borrow the microphone: the mic in the turn engine",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, windows, media, turns, mic, topicId;
    const logged = [];
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
        limits: { request: relaxed, worker: relaxed },
        turnWindows: true,
      });
      media = createMediaRepository(runtime, undefined, { micEnabled: true });
      turns = createMicTurns({
        database: runtime,
        media,
        voidTurnWindow: (...args) => windows.voidTurnWindow(...args),
        logger: {
          warn: (details, message) => logged.push(message),
          error: (details, message) => logged.push(message),
        },
      });
      mic = createMicRepository(runtime, "simulation", {
        limits: relaxed,
        afterFire: turns.start,
      });
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Mic turns','Synthetic mic turn fixture','Support','Oppose','published') RETURNING id",
          [`mic-turns-${randomUUID()}`],
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
      const session = await createSessionRepository(runtime).create(
        user.id,
        token.tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration: user.auth_generation },
      );
      await attachSubject(owner, user.id);
      await openSandbox(owner, user.id);
      return {
        userId: user.id,
        sessionTokenHash: token.tokenHash,
        expectedSessionId: String(session.id),
      };
    }
    async function seat(context) {
      return (
        await owner.query(
          "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,$2,'Debater','published') RETURNING id",
          [context.userId, `mic-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id;
    }
    async function seed() {
      const context = await actor();
      for (const purpose of ["center", "promotional"])
        await operator.seedSandboxTreasury({
          userId: context.userId,
          purpose,
          amount: "200000000",
          idempotencyKey: randomUUID(),
        });
    }
    // A viewer with the welcome grant and 100 purchased YC, present.
    async function viewer(debateId) {
      const context = await actor();
      await sandbox.initialize(context);
      const quote = await sandbox.quoteFunding(context, {
        amount: "1000000",
        idempotencyKey: randomUUID(),
      });
      await sandbox.confirmSimulatedFunding(context, { requestId: quote.id });
      await owner.query(
        "INSERT INTO debate_viewers(debate_id,user_id) VALUES($1,$2)",
        [debateId, context.userId],
      );
      return context;
    }
    // A live debate that started with the mic on, at the end of turn 6.
    async function liveDebate() {
      const debaters = { A: await actor(), B: await actor() };
      const id = (
        await owner.query(
          `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,speaker_a_profile_id,speaker_b_profile_id,is_demo)
          VALUES($1,$2,'Should viewers borrow the mic?','live','published','preview-1',
            '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":3600,"mic_enabled":true}',
            clock_timestamp(),$3,$4,true) RETURNING id`,
          [
            topicId,
            `mic-turns-${randomUUID()}`,
            await seat(debaters.A),
            await seat(debaters.B),
          ],
        )
      ).rows[0].id;
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
          remaining_ms,active_ms,last_resumed_at,recording_status)
        VALUES($1,'running','B',6,clock_timestamp()+INTERVAL '60 seconds',60000,300000,
          clock_timestamp(),'recording')`,
        [id],
      );
      return { debateId: id, debaters };
    }
    // The running turn reaches its deadline, and the clock moves this debate.
    async function deadline(debateId) {
      await owner.query(
        `UPDATE debate_media SET turn_deadline_at=clock_timestamp()-INTERVAL '1 millisecond',
          last_resumed_at=clock_timestamp()-remaining_ms*INTERVAL '1 millisecond'
        WHERE debate_id=$1`,
        [debateId],
      );
      return withTransaction(runtime, (client) =>
        media.advanceWithClient(client, debateId),
      );
    }
    async function clock(debateId) {
      return (
        await owner.query(
          `SELECT turn_number AS "turnNumber",active_side AS "activeSide",
            remaining_ms AS "remainingMs" FROM debate_media WHERE debate_id=$1`,
          [debateId],
        )
      ).rows[0];
    }
    async function rounds(debateId) {
      return (
        await owner.query(
          `SELECT id,turn_number,turn_side,state,result->>'voidReason' AS reason
          FROM coin_debate_rounds WHERE debate_id=$1 ORDER BY turn_number`,
          [debateId],
        )
      ).rows;
    }
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

    it("cuts the running turn, refunds its window and gives every mic turn a window", async () => {
      await seed();
      const { debateId } = await liveDebate();
      // L2: turn 6 ends, both debaters have spoken three times.
      assert.equal((await deadline(debateId)).ended, false);
      assert.deepEqual(await clock(debateId), {
        turnNumber: 7,
        activeSide: "A",
        remainingMs: 60000,
      });
      const lists = (
        await owner.query(
          "SELECT opened_round FROM mic_lists WHERE debate_id=$1",
          [debateId],
        )
      ).rows;
      assert.deepEqual(lists, [{ opened_round: 4 }]);
      // A position in turn 7's window.
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
      const trader = await viewer(debateId),
        before = await sandbox.summary(trader);
      const window = await windows.create(trader, debateId, randomUUID());
      await windows.submit(trader, window.id, randomUUID(), {
        side: "YES",
        limit: "0.6",
        quantity: 10,
      });
      const held = (await sandbox.summary(trader)).balances;
      assert.ok(BigInt(held.reserved) + BigInt(held.promotionalReserved) > 0n);
      // Camp B asks debater A, and fires in the middle of turn 7.
      const author = await viewer(debateId);
      const asked = await mic.submitQuestion(author, debateId, {
        target: "A",
        text: "Why should the mic be borrowed?",
        wager: 3n * YC,
        requestId: randomUUID(),
      });
      const fired = await mic.fire(
        author,
        debateId,
        asked.questionId,
        randomUUID(),
      );
      assert.equal(fired.state, "live");
      // F2, E5, E6: the question turn has its own number and a full turn.
      assert.deepEqual(await clock(debateId), {
        turnNumber: 8,
        activeSide: "B",
        remainingMs: 60000,
      });
      const run = (
        await owner.query(
          "SELECT cut_turn_number,cut_side,lost_ms,cut_void FROM mic_runs WHERE mic_id=$1",
          [fired.micId],
        )
      ).rows[0];
      assert.equal(run.cut_turn_number, 7);
      assert.equal(run.cut_side, "A");
      assert.ok(run.lost_ms > 50_000 && run.lost_ms <= 60_000);
      assert.equal(run.cut_void, "done");
      // E10: the cut turn's window is refunded in full.
      const [cut] = await rounds(debateId);
      assert.equal(cut.turn_number, 7);
      assert.equal(cut.state, "void");
      assert.equal(cut.reason, "turn_cut");
      const refunded = await sandbox.summary(trader);
      assert.equal(refunded.balances.reserved, "0");
      assert.equal(refunded.balances.promotionalReserved, "0");
      assert.deepEqual(refunded.book, before.book);
      // A retried fire or a recovery pass starts and refunds nothing twice.
      await turns.start(debateId);
      assert.deepEqual(await turns.recover(), { started: 0, voided: 0 });
      assert.equal((await clock(debateId)).turnNumber, 8);
      // E9: the asker's text is on the public read with the turn.
      await turns.setAskerText(author, debateId, "Why now?");
      const view = await mic.read(debateId);
      assert.equal(view.turn.kind, "question");
      assert.equal(view.turn.speaker, "asker");
      assert.equal(view.turn.text, "Why now?");
      assert.equal(view.turn.target, "A");
      assert.deepEqual(view.mics[0].cut, {
        turnNumber: 7,
        side: "A",
        lostMs: run.lost_ms,
      });
      // No debater's microphone opens in the asker's turns; the target's
      // opens to answer.
      const permissions = [];
      const operations = createMediaOperations({
        database: runtime,
        media,
        provider: {
          setTurn: async (debateId, side) => permissions.push(side),
        },
        logger: { warn() {} },
      });
      // E11: each new turn number gets a window; asker turns are camp B's.
      const sides = [];
      for (let step = 0; step < 5; step++) {
        assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
        await operations.reconcile(debateId);
        if (step === 0) await turns.endAskerTurn(author, debateId);
        else await deadline(debateId);
      }
      await operations.reconcile(debateId);
      await operations.stop();
      assert.deepEqual(permissions, [null, "A", null, "A", "B", "A"]);
      for (const round of await rounds(debateId))
        sides.push([round.turn_number, round.turn_side, round.state]);
      assert.deepEqual(sides, [
        [7, "A", "void"],
        [8, "B", "open"],
        [9, "A", "open"],
        [10, "B", "open"],
        [11, "A", "open"],
        [12, "B", "open"],
      ]);
      // After the resume, regular turns go on from it; the mic is done.
      assert.deepEqual(await clock(debateId), {
        turnNumber: 13,
        activeSide: "A",
        remainingMs: 60000,
      });
      assert.equal(
        (
          await owner.query("SELECT state FROM mic_mics WHERE id=$1", [
            fired.micId,
          ])
        ).rows[0].state,
        "done",
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT turn_number,kind,used_ms IS NOT NULL AS ended FROM mic_turns WHERE debate_id=$1 ORDER BY turn_number",
            [debateId],
          )
        ).rows.map((t) => [t.turn_number, t.kind, t.ended]),
        [
          [8, "question", true],
          [9, "answer", true],
          [10, "followup", true],
          [11, "answer2", true],
          [12, "resume", true],
        ],
      );
      assert.deepEqual(logged, []);
      await reconcile();
    });

    it("lets the database refuse a mic turn changed after it ended", async () => {
      await seed();
      const { debateId } = await liveDebate();
      await deadline(debateId);
      const author = await viewer(debateId);
      const asked = await mic.submitQuestion(author, debateId, {
        target: "B",
        text: "And the other side?",
        wager: 1n * YC,
        requestId: randomUUID(),
      });
      await mic.fire(author, debateId, asked.questionId, randomUUID());
      await deadline(debateId);
      await assert.rejects(
        runtime.query(
          "UPDATE mic_turns SET text='late' WHERE debate_id=$1 AND kind='question'",
          [debateId],
        ),
        /an ended mic turn does not change/,
      );
      await assert.rejects(
        runtime.query(
          "UPDATE mic_runs SET cut_void='pending' WHERE debate_id=$1",
          [debateId],
        ),
        /only settle their cut once/,
      );
      await assert.rejects(
        runtime.query("DELETE FROM mic_turns WHERE debate_id=$1", [debateId]),
        /permission denied/,
      );
    });
  },
);
