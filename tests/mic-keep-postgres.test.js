import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { coinJournalReference } from "../dist/features/account-wallet/ledger.js";
import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createMicFunds } from "../dist/features/mic/funds.js";
import { createMicRepository } from "../dist/features/mic/repository.js";
import { createMicTurns } from "../dist/features/mic/turns.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { withTransaction } from "../dist/platform/transaction.js";
import { attachSubject, openSandbox } from "./helpers/confirmations.js";

// Decision 0018, PR 3: keep the asker on (X) and the mic's money when a
// debate ends (D7, D9), on PostgreSQL with the coin ledger and turn windows.
// Clocks are moved on this file's own debates only, never through the global
// tick, because other PostgreSQL suites share the database.
const YC = 10_000n;
const relaxed = { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 };
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "borrow the microphone: keep the asker on and the end of a debate",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, windows, media, turns, mic, funds;
    let matching, topicId, system;
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
      const logger = {
        warn: (details, message) => logged.push(message),
        error: (details, message) => logged.push(message),
      };
      funds = createMicFunds({
        database: runtime,
        rail: "simulation",
        limits: relaxed,
        logger,
      });
      turns = createMicTurns({
        database: runtime,
        media,
        voidTurnWindow: (...args) => windows.voidTurnWindow(...args),
        funds,
        logger,
      });
      mic = createMicRepository(runtime, "simulation", {
        limits: relaxed,
        afterFire: turns.start,
      });
      matching = createMatchingRepository(runtime);
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Mic keep','Synthetic keep-the-asker-on fixture','Support','Oppose','published') RETURNING id",
          [`mic-keep-${randomUUID()}`],
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
          [context.userId, `keep-${randomUUID().slice(0, 8)}`],
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
    // A present viewer with the welcome grant and/or purchased coins.
    async function viewer(debateId, { grant = true, cash = null } = {}) {
      const context = await actor();
      if (grant) await sandbox.initialize(context);
      if (cash) {
        const quote = await sandbox.quoteFunding(context, {
          amount: cash,
          idempotencyKey: randomUUID(),
        });
        await sandbox.confirmSimulatedFunding(context, {
          requestId: quote.id,
        });
      }
      await owner.query(
        "INSERT INTO debate_viewers(debate_id,user_id) VALUES($1,$2)",
        [debateId, context.userId],
      );
      return context;
    }
    // A live debate that started with the mic on, at the end of turn 6.
    async function liveDebate({ maximum = 3600 } = {}) {
      const debaters = { A: await actor(), B: await actor() };
      const id = (
        await owner.query(
          `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,speaker_a_profile_id,speaker_b_profile_id,is_demo)
          VALUES($1,$2,'Should viewers keep the asker on?','live','published','preview-1',
            jsonb_build_object('initial_speaking_time_seconds',60,
              'maximum_duration_seconds',$5::integer,'mic_enabled',true),
            clock_timestamp(),$3,$4,true) RETURNING id`,
          [
            topicId,
            `mic-keep-${randomUUID()}`,
            await seat(debaters.A),
            await seat(debaters.B),
            maximum,
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
    // A question by a fresh viewer to `target`, fired at once.
    async function liveMic(debateId, target, wager) {
      const author = await viewer(debateId);
      const asked = await ask(author, debateId, target, wager);
      const fired = await mic.fire(
        author,
        debateId,
        asked.questionId,
        randomUUID(),
      );
      return { author, ...asked, ...fired };
    }
    const ask = (context, debateId, target, wager) =>
      mic.submitQuestion(context, debateId, {
        target,
        text: `Question ${randomUUID().slice(0, 6)}?`,
        wager: BigInt(wager) * YC,
        requestId: randomUUID(),
      });
    const keep = (context, debateId, amount, requestId = randomUUID()) =>
      mic.keep(context, debateId, {
        amount: BigInt(amount) * YC,
        requestId,
      });
    const refused = (status, pattern) => (error) =>
      error.status === status && pattern.test(error.message);
    async function balances(context) {
      const rows = (
        await owner.query(
          "SELECT asset,kind,balance::text FROM coin_accounts WHERE user_id=$1 AND environment='sandbox'",
          [context.userId],
        )
      ).rows;
      const of = (asset, kind) =>
        BigInt(
          rows.find((r) => r.asset === asset && r.kind === kind)?.balance ??
            "0",
        );
      return {
        cash: of("USDC", "available"),
        cashHeld: of("USDC", "reserved"),
        promo: of("YC_PROMO", "promotional"),
        promoHeld: of("YC_PROMO", "reserved"),
      };
    }
    async function book(context) {
      return (
        await owner.query(
          "SELECT book FROM coin_sandbox_books WHERE user_id=$1",
          [context.userId],
        )
      ).rows[0]?.book;
    }
    // Balances and book together, to compare a refund with what came before.
    const wallet = async (context) => ({
      money: await balances(context),
      book: await book(context),
    });
    // The account's book agrees with its available ledger balances.
    async function agrees(context) {
      const current = await book(context),
        money = await balances(context);
      const sum = (values) => values.reduce((a, b) => a + BigInt(b), 0n);
      assert.equal(
        sum(current.grants.map((g) => g.principalRemaining)),
        money.promo,
      );
      assert.equal(
        sum([
          ...current.grants.map((g) => g.profitRemaining),
          ...current.purchased.map((p) => p.balance),
        ]),
        money.cash,
      );
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
    async function systemAccounts() {
      system ??= Object.fromEntries(
        (
          await owner.query(
            "SELECT purpose,account_id FROM coin_sandbox_system_accounts",
          )
        ).rows.map((r) => [r.purpose, r.account_id]),
      );
      return system;
    }
    async function journal(context, step, asset, pledgeId) {
      return Object.fromEntries(
        (
          await owner.query(
            `SELECT p.account_id,p.amount::text FROM coin_postings p
            JOIN coin_journals j ON j.id=p.journal_id WHERE j.environment='sandbox' AND j.reference=$1`,
            [
              coinJournalReference({
                environment: "sandbox",
                accountId: context.userId,
                operation: `mic.${step}.${asset}`,
                idempotencyKey: pledgeId,
              }),
            ],
          )
        ).rows.map((r) => [r.account_id, BigInt(r.amount)]),
      );
    }
    async function fundRows(debateId) {
      return (
        await owner.query(
          `SELECT id,opened_turn_number AS turn,closes_after,price::text,state
          FROM mic_funds WHERE debate_id=$1 ORDER BY opened_turn_number`,
          [debateId],
        )
      ).rows;
    }
    async function fundPledge(pledgeId) {
      return (
        await owner.query(
          "SELECT state,refund_reason,amount::text,requested::text FROM mic_fund_pledges WHERE id=$1",
          [pledgeId],
        )
      ).rows[0];
    }
    async function micTurns(debateId) {
      return (
        await owner.query(
          "SELECT turn_number,kind,side FROM mic_turns WHERE debate_id=$1 ORDER BY turn_number",
          [debateId],
        )
      ).rows.map((t) => [t.turn_number, t.kind, t.side]);
    }
    async function rounds(debateId) {
      return (
        await owner.query(
          `SELECT turn_number,turn_side,state,result->>'voidReason' AS reason
          FROM coin_debate_rounds WHERE debate_id=$1 ORDER BY turn_number`,
          [debateId],
        )
      ).rows.map((r) => [r.turn_number, r.turn_side, r.state, r.reason]);
    }
    async function blocked(pid, count) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const waiting = (
          await owner.query(
            `WITH RECURSIVE waiters AS (
              SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))
              UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid))
            ) SELECT count(*)::int n FROM waiters`,
            [pid],
          )
        ).rows[0].n;
        if (waiting >= count) return;
        await owner.query("SELECT pg_sleep(0.01)");
      }
      assert.fail("the racing requests never waited for the fund lock");
    }

    it("pays the debaters in halves once a fund reaches its price, and runs the extension with its own windows", async () => {
      await seed();
      const sys = await systemAccounts();
      const { debateId, debaters } = await liveDebate();
      await deadline(debateId); // turn 7; the list opens
      // Camp B asks debater A, 4 YC from the welcome grant; the question
      // turn (8) opens keep-the-asker-on at that price (X1, X2).
      const fired = await liveMic(debateId, "A", 4);
      assert.equal(fired.state, "live");
      const [opened] = await fundRows(debateId);
      assert.deepEqual(
        { ...opened, id: undefined },
        {
          id: undefined,
          turn: 8,
          closes_after: "followup",
          price: "40000",
          state: "open",
        },
      );
      let view = await mic.read(debateId);
      assert.deepEqual(view.fund, {
        id: opened.id,
        micId: fired.micId,
        price: 4,
        raised: 0,
        state: "open",
        closesAfter: "followup",
        closesAt: null,
      });
      const backer = await viewer(debateId, { grant: false, cash: "1000000" });
      const requestId = randomUUID();
      const small = await keep(backer, debateId, 1, requestId);
      assert.deepEqual(
        { amount: small.amount, funded: small.funded, created: small.created },
        { amount: 1, funded: false, created: true },
      );
      // A retried request answers with its first result.
      assert.deepEqual(await keep(backer, debateId, 1, requestId), {
        ...small,
        created: false,
      });
      // The interface's read of the viewer's own part names what they
      // pledged to the open fund.
      assert.deepEqual((await mic.readOwn(debateId, backer.userId)).kept, {
        fundId: opened.id,
        amount: 1,
      });
      await assert.rejects(
        keep(backer, debateId, 2, requestId),
        refused(409, /different request/),
      );
      // Debaters can't keep the asker on (L17).
      await owner.query(
        "INSERT INTO debate_viewers(debate_id,user_id) VALUES($1,$2)",
        [debateId, debaters.B.userId],
      );
      await assert.rejects(
        keep(debaters.B, debateId, 1),
        refused(403, /debaters can't/),
      );
      for (let step = 0; step < 2; step++) {
        assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
        await deadline(debateId);
      }
      view = await mic.read(debateId);
      assert.equal(view.turn.kind, "followup");
      assert.ok(view.fund.closesAt instanceof Date, "its closing turn runs");
      assert.equal(view.fund.raised, 1);
      // X6, X12: the asker backs their own extension with 5; 3 are left.
      const asker = await wallet(fired.author);
      const own = await keep(fired.author, debateId, 5);
      assert.deepEqual(
        { amount: own.amount, funded: own.funded },
        { amount: 3, funded: true },
      );
      assert.deepEqual(await fundPledge(own.pledgeId), {
        state: "paid",
        refund_reason: null,
        amount: "30000",
        requested: "50000",
      });
      assert.equal((await fundPledge(small.pledgeId)).state, "paid");
      assert.equal((await fundRows(debateId))[0].state, "funded");
      // X11: the debaters are paid at once, 2 YC more each, cash-backed.
      const fundId = opened.id;
      for (const side of ["A", "B"]) {
        assert.deepEqual(await balances(debaters[side]), {
          cash: 40_000n,
          cashHeld: 0n,
          promo: 0n,
          promoHeld: 0n,
        });
        assert.deepEqual(
          (await book(debaters[side])).purchased.map((p) => [
            p.kind,
            p.balance,
            p.id,
          ]),
          [
            ["purchased_profit", "20000", `mic:${fired.micId}`],
            ["purchased_profit", "20000", `mic-fund:${fundId}`],
          ],
        );
        await agrees(debaters[side]);
      }
      // The grant part is burned and the center pays the same amount.
      assert.equal(
        (await journal(fired.author, "spend", "usdc", own.pledgeId))[
          sys.center_available
        ],
        -30_000n,
      );
      assert.equal(
        (await journal(fired.author, "spend", "yc_promo", own.pledgeId))[
          sys.grant_issuer
        ],
        30_000n,
      );
      assert.deepEqual(await balances(fired.author), {
        ...asker.money,
        promo: asker.money.promo - 30_000n,
      });
      assert.deepEqual(await balances(backer), {
        cash: 990_000n,
        cashHeld: 0n,
        promo: 0n,
        promoHeld: 0n,
      });
      // Funded: nothing more is taken for this segment.
      await assert.rejects(
        keep(backer, debateId, 1),
        refused(409, /isn't open/),
      );
      // X4, X10: after the answer, an extension question opens its own fund.
      for (let step = 0; step < 2; step++) {
        assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
        await deadline(debateId);
      }
      view = await mic.read(debateId);
      assert.equal(view.turn.kind, "extq");
      assert.equal(view.turn.speaker, "asker");
      assert.equal(view.fund.state, "open");
      assert.equal(view.fund.closesAfter, "extq");
      assert.ok(view.fund.closesAt instanceof Date);
      assert.deepEqual(
        (await fundRows(debateId)).map((f) => [
          f.turn,
          f.closes_after,
          f.state,
        ]),
        [
          [8, "followup", "funded"],
          [12, "extq", "open"],
        ],
      );
      await turns.setAskerText(fired.author, debateId, "One more?");
      // Nobody funds the second extension: it closes with its question.
      for (let step = 0; step < 3; step++) {
        assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
        await deadline(debateId);
      }
      await turns.recover();
      assert.deepEqual(
        (await fundRows(debateId)).map((f) => f.state),
        ["funded", "failed"],
      );
      assert.deepEqual(await micTurns(debateId), [
        [8, "question", "B"],
        [9, "answer", "A"],
        [10, "followup", "B"],
        [11, "answer2", "A"],
        [12, "extq", "B"],
        [13, "exta", "A"],
        [14, "resume", "B"],
      ]);
      await deadline(debateId);
      // E11: every extension turn has its own window, the asker's camp's or
      // the target's.
      assert.deepEqual(await rounds(debateId), [
        [8, "B", "open", null],
        [9, "A", "open", null],
        [10, "B", "open", null],
        [11, "A", "open", null],
        [12, "B", "open", null],
        [13, "A", "open", null],
        [14, "B", "open", null],
      ]);
      view = await mic.read(debateId);
      assert.equal(view.mics[0].state, "done");
      assert.equal(view.mics[0].extensions, 1);
      assert.equal(view.fund, null);
      for (const context of [fired.author, backer]) await agrees(context);
      assert.deepEqual(logged, []);
      await reconcile();
    });

    it("refunds an unfunded fund exactly once its turn ends, and refuses pledges after the close (X7)", async () => {
      await seed();
      const { debateId } = await liveDebate();
      await deadline(debateId);
      await liveMic(debateId, "B", 5);
      const grant = await viewer(debateId),
        cash = await viewer(debateId, { grant: false, cash: "1000000" });
      const before = [await wallet(grant), await wallet(cash)];
      const pledges = [
        await keep(grant, debateId, 2),
        await keep(cash, debateId, 1),
      ];
      assert.ok(pledges.every((p) => !p.funded));
      assert.equal((await balances(grant)).promoHeld, 20_000n);
      assert.equal((await balances(cash)).cashHeld, 10_000n);
      // Question, answer, then the follow-up ends: the clock closes the fund.
      for (let step = 0; step < 3; step++) await deadline(debateId);
      assert.equal((await fundRows(debateId))[0].state, "closing");
      await assert.rejects(keep(cash, debateId, 4), refused(409, /isn't open/));
      // The clock never touched the ledger: the holds wait for the refund.
      for (const pledge of pledges)
        assert.equal((await fundPledge(pledge.pledgeId)).state, "held");
      await turns.recover();
      assert.equal((await fundRows(debateId))[0].state, "failed");
      for (const pledge of pledges)
        assert.deepEqual(
          {
            ...(await fundPledge(pledge.pledgeId)),
            amount: undefined,
            requested: undefined,
          },
          {
            state: "refunded",
            refund_reason: "fund_closed",
            amount: undefined,
            requested: undefined,
          },
        );
      assert.deepEqual([await wallet(grant), await wallet(cash)], before);
      // A second pass refunds nothing twice.
      assert.equal(await funds.settleClosing(debateId), 0);
      await deadline(debateId);
      assert.deepEqual((await micTurns(debateId)).at(-1).slice(1), [
        "resume",
        "A",
      ]);
      // Fund rows only move forward, and the runtime cannot rewrite them.
      const [row] = await fundRows(debateId);
      await assert.rejects(
        runtime.query("UPDATE mic_funds SET state='open' WHERE id=$1", [
          row.id,
        ]),
        /only move forward/,
      );
      await assert.rejects(
        runtime.query("UPDATE mic_funds SET price=1 WHERE id=$1", [row.id]),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query(
          "UPDATE mic_fund_pledges SET state='held',refund_reason=NULL WHERE id=$1",
          [pledges[0].pledgeId],
        ),
        /only move forward/,
      );
      await assert.rejects(
        runtime.query("DELETE FROM mic_fund_pledges WHERE id=$1", [
          pledges[0].pledgeId,
        ]),
        /permission denied/,
      );
      await reconcile();
    });

    it("lets the fund row decide between a pledge reaching the price and its close", async () => {
      await seed();
      for (let attempt = 0; attempt < 4; attempt++) {
        const { debateId, debaters } = await liveDebate();
        await deadline(debateId);
        await liveMic(debateId, "A", 2);
        await deadline(debateId); // the answer
        await deadline(debateId); // the follow-up runs
        const backer = await viewer(debateId, {
          grant: false,
          cash: "1000000",
        });
        const blocker = await owner.connect();
        let results;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM mic_funds WHERE debate_id=$1 FOR UPDATE",
            [debateId],
          );
          await owner.query(
            `UPDATE debate_media SET turn_deadline_at=clock_timestamp()-INTERVAL '1 millisecond'
            WHERE debate_id=$1`,
            [debateId],
          );
          const closing = () =>
              withTransaction(runtime, (client) =>
                media.advanceWithClient(client, debateId),
              ),
            pledging = () => keep(backer, debateId, 2);
          const racing =
            attempt % 2
              ? Promise.allSettled([closing(), pledging()])
              : Promise.allSettled([pledging(), closing()]).then(
                  ([pledge, close]) => [close, pledge],
                );
          await blocked(
            (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            2,
          );
          await blocker.query("COMMIT");
          results = await racing;
        } catch (error) {
          await blocker.query("ROLLBACK");
          throw error;
        } finally {
          blocker.release();
        }
        const [close, pledge] = results;
        assert.equal(close.status, "fulfilled", "the clock always moves on");
        await turns.recover();
        const [fund] = await fundRows(debateId);
        if (pledge.status === "fulfilled") {
          assert.equal(pledge.value.funded, true);
          assert.equal(fund.state, "funded");
          assert.equal((await balances(debaters.A)).cash, 20_000n);
          await deadline(debateId);
          assert.equal((await micTurns(debateId)).at(-1)[1], "extq");
        } else {
          assert.match(pledge.reason.message, /isn't open/);
          assert.equal(fund.state, "failed");
          assert.equal((await balances(backer)).cash, 1_000_000n);
          await deadline(debateId);
          assert.equal((await micTurns(debateId)).at(-1)[1], "resume");
        }
      }
      await reconcile();
    });

    it("refunds open questions and open funds when an operator ends the debate, and the cut mic turn's window", async () => {
      await seed();
      const { debateId, debaters } = await liveDebate();
      await deadline(debateId);
      // Camp A's questions to debater B stay open; camp B's mic runs.
      const waiting = await viewer(debateId),
        backer = await viewer(debateId, { grant: false, cash: "1000000" }),
        second = await viewer(debateId);
      const keeper = await viewer(debateId, { grant: false, cash: "1000000" });
      const before = new Map();
      for (const context of [waiting, backer, second, keeper])
        before.set(context.userId, await wallet(context));
      const open = await ask(waiting, debateId, "B", 3);
      const backed = await mic.pledge(backer, debateId, open.questionId, {
        amount: 2n * YC,
        add: null,
        requestId: randomUUID(),
      });
      const other = await ask(second, debateId, "B", 1);
      const fired = await liveMic(debateId, "A", 4);
      const kept = await keep(keeper, debateId, 3);
      assert.equal(kept.funded, false);
      const paid = [await balances(debaters.A), await balances(debaters.B)];
      // The question turn has a window when the operator ends the debate.
      assert.equal((await windows.openTurnWindows(20, [debateId])).opened, 1);
      const reason = "operator ended the debate";
      await matching.operatorTransition(null, debateId, "end", reason);
      await media.stop(debateId, reason);
      // Nothing moved in the end's own transactions.
      assert.equal((await fundPledge(kept.pledgeId)).state, "held");
      await turns.recover();
      for (const context of [waiting, backer, second, keeper])
        assert.deepEqual(
          await wallet(context),
          before.get(context.userId),
          context.userId,
        );
      const states = (
        await owner.query(
          `SELECT p.id,p.state,p.refund_reason,q.state AS question FROM mic_pledges p
          JOIN mic_questions q ON q.id=p.question_id WHERE p.id=ANY($1::uuid[])`,
          [[open.pledgeId, backed.pledgeId, other.pledgeId]],
        )
      ).rows;
      assert.equal(states.length, 3);
      for (const row of states)
        assert.deepEqual(
          [row.state, row.refund_reason, row.question],
          ["refunded", "debate_ended", "refunded"],
        );
      assert.deepEqual(await fundPledge(kept.pledgeId), {
        state: "refunded",
        refund_reason: "debate_ended",
        amount: "30000",
        requested: "30000",
      });
      assert.equal((await fundRows(debateId))[0].state, "refunded");
      // The fired question stays paid; the live mic is done, the list closed.
      assert.deepEqual(
        [await balances(debaters.A), await balances(debaters.B)],
        paid,
      );
      const end = (
        await owner.query(
          `SELECT (SELECT state FROM mic_mics WHERE id=$2) AS mic,
            (SELECT state FROM mic_lists WHERE debate_id=$1) AS list,
            e.cut_turn_number,e.cut_void,
            (SELECT used_ms IS NOT NULL FROM mic_turns WHERE debate_id=$1 AND turn_number=8) AS ended
          FROM mic_debate_ends e WHERE e.debate_id=$1`,
          [debateId, fired.micId],
        )
      ).rows[0];
      assert.deepEqual(end, {
        mic: "done",
        list: "closed",
        cut_turn_number: 8,
        cut_void: "done",
        ended: true,
      });
      // D9: the cut mic turn's window is refunded in full.
      assert.deepEqual((await rounds(debateId)).at(-1), [
        8,
        "B",
        "void",
        "turn_cut",
      ]);
      // Later passes find nothing more to do for this debate, and the mic
      // takes nothing after the end.
      await turns.recover();
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM mic_debate_ends WHERE debate_id=$1",
            [debateId],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        keep(keeper, debateId, 1),
        refused(409, /only open while the debate is live/),
      );
      await reconcile();
    });

    it("keeps a queued mic paid when the debate ends under review, and refunds the open fund", async () => {
      await seed();
      const { debateId, debaters } = await liveDebate();
      await deadline(debateId);
      const live = await liveMic(debateId, "A", 2);
      const queued = await liveMic(debateId, "B", 4);
      assert.deepEqual([live.state, queued.state], ["live", "queued"]);
      // 6 YC paid: 3 each.
      for (const side of ["A", "B"])
        assert.equal((await balances(debaters[side])).cash, 30_000n);
      const keeper = await viewer(debateId);
      const before = await wallet(keeper);
      await keep(keeper, debateId, 1);
      await matching.operatorTransition(
        null,
        debateId,
        "void_review",
        "operator review of the debate",
      );
      await turns.recover();
      assert.deepEqual(await wallet(keeper), before);
      const mics = (
        await owner.query(
          "SELECT state FROM mic_mics WHERE debate_id=$1 ORDER BY fired_at",
          [debateId],
        )
      ).rows.map((r) => r.state);
      assert.deepEqual(mics, ["done", "done"]);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM mic_pledges p JOIN mic_mics m ON m.question_id=p.question_id WHERE m.id=$1 AND p.state='paid'",
            [queued.micId],
          )
        ).rows[0].n,
        1,
      );
      for (const side of ["A", "B"]) {
        assert.equal((await balances(debaters[side])).cash, 30_000n);
        await agrees(debaters[side]);
      }
      await reconcile();
    });

    it("refunds open questions when the clock ends the debate at its maximum", async () => {
      await seed();
      // Turn 7 is the debate's last minute.
      const { debateId } = await liveDebate({ maximum: 420 });
      await deadline(debateId);
      const author = await viewer(debateId);
      const before = await wallet(author);
      const asked = await ask(author, debateId, "A", 7);
      assert.deepEqual(await deadline(debateId), { ended: true });
      await turns.recover();
      assert.deepEqual(await wallet(author), before);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,refund_reason FROM mic_pledges WHERE id=$1",
            [asked.pledgeId],
          )
        ).rows[0],
        { state: "refunded", refund_reason: "debate_ended" },
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT cut_turn_number,cut_void FROM mic_debate_ends WHERE debate_id=$1",
            [debateId],
          )
        ).rows,
        [{ cut_turn_number: null, cut_void: null }],
      );
      await reconcile();
    });
  },
);
