import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { coinJournalReference } from "../dist/features/account-wallet/ledger.js";
import { createMicRepository } from "../dist/features/mic/repository.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { attachSubject, openSandbox } from "./helpers/confirmations.js";

// Decision 0018, PR 2a: the mic's list on PostgreSQL and the coin ledger.
// Amounts in atoms: 1 YC is 10,000; the welcome grant is 2,500 YC of grant
// coins (25,000,000); a 1 USDC simulated purchase is 100 YC (1,000,000).
const YC = 10_000n;
const relaxed = { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 };
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "borrow the microphone: the list on the coin ledger",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, mic, system, topicId;
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
      mic = createMicRepository(runtime, "simulation", { limits: relaxed });
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Mic test','Synthetic mic fixture','Support','Oppose','published') RETURNING id",
          [`mic-${randomUUID()}`],
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
    async function seat(context) {
      return (
        await owner.query(
          "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,$2,'Debater','published') RETURNING id",
          [context.userId, `mic-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id;
    }
    // A live, published debate with both seats filled and an open list.
    async function liveDebate({ list = true } = {}) {
      const debaters = { A: await actor(), B: await actor() };
      const id = (
        await owner.query(
          `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,speaker_a_profile_id,speaker_b_profile_id)
          VALUES($1,$2,'Should viewers borrow the mic?','live','published','preview-1','{}',
            clock_timestamp(),$3,$4) RETURNING id`,
          [
            topicId,
            `mic-${randomUUID()}`,
            await seat(debaters.A),
            await seat(debaters.B),
          ],
        )
      ).rows[0].id;
      if (list) await mic.createList(id, 3);
      return { debateId: id, debaters };
    }
    async function present(context, debateId) {
      await owner.query(
        `INSERT INTO debate_viewers(debate_id,user_id) VALUES($1,$2)
        ON CONFLICT (debate_id,user_id) DO UPDATE SET last_seen_at=clock_timestamp()`,
        [debateId, context.userId],
      );
    }
    async function fund(context, amount) {
      const q = await sandbox.quoteFunding(context, {
        amount,
        idempotencyKey: randomUUID(),
      });
      await sandbox.confirmSimulatedFunding(context, { requestId: q.id });
    }
    // A present viewer with the welcome grant and/or purchased coins.
    async function viewer(debateId, { grant = true, cash = null } = {}) {
      const context = await actor();
      if (grant) await sandbox.initialize(context);
      if (cash) await fund(context, cash);
      await present(context, debateId);
      return context;
    }
    async function seedCenter(amount = 200_000_000n) {
      const context = await actor();
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose: "center",
        amount: String(amount),
        idempotencyKey: randomUUID(),
      });
    }
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
    // The postings of the journal a mic step posted for one pledge.
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
    async function pledgeState(pledgeId) {
      return (
        await owner.query(
          "SELECT state,refund_reason FROM mic_pledges WHERE id=$1",
          [pledgeId],
        )
      ).rows[0];
    }
    // Waits until `count` sessions wait, directly or in line, on a backend's locks.
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
      assert.fail("the racing requests never waited for the list lock");
    }
    const ask = (context, debateId, target, wager, requestId = randomUUID()) =>
      mic.submitQuestion(context, debateId, {
        target,
        text: `Question ${randomUUID().slice(0, 6)}?`,
        wager: BigInt(wager) * YC,
        requestId,
      });
    const back = (context, debateId, questionId, amount, add = null) =>
      mic.pledge(context, debateId, questionId, {
        amount: BigInt(amount) * YC,
        add,
        requestId: randomUUID(),
      });
    const refused = (status, pattern) => (error) =>
      error.status === status && pattern.test(error.message);

    it("holds a wager and a pledge from the pledger's own coins, grant coins first", async () => {
      const { debateId } = await liveDebate();
      const author = await viewer(debateId, { cash: "1000000" }),
        buyer = await viewer(debateId, { grant: false, cash: "1000000" }),
        mixed = await viewer(debateId, { cash: "1000000" });
      const asked = await ask(author, debateId, "B", 3);
      assert.equal(asked.created, true);
      assert.deepEqual(await balances(author), {
        cash: 1_000_000n,
        cashHeld: 0n,
        promo: 25_000_000n - 30_000n,
        promoHeld: 30_000n,
      });
      await back(buyer, debateId, asked.questionId, 2, "Ask it twice");
      assert.deepEqual(await balances(buyer), {
        cash: 1_000_000n - 20_000n,
        cashHeld: 20_000n,
        promo: 0n,
        promoHeld: 0n,
      });
      // 2,550 YC: every grant coin, then 50 YC of purchased coins.
      await back(mixed, debateId, asked.questionId, 2550);
      assert.deepEqual(await balances(mixed), {
        cash: 500_000n,
        cashHeld: 500_000n,
        promo: 0n,
        promoHeld: 25_000_000n,
      });
      for (const context of [author, buyer, mixed]) await agrees(context);
      const view = await mic.read(debateId);
      assert.equal(view.list.state, "open");
      assert.equal(view.list.openedRound, 3);
      assert.deepEqual(view.list.camps.B, []);
      const [question] = view.list.camps.A;
      assert.equal(question.id, asked.questionId);
      assert.equal(question.target, "B");
      assert.equal(question.total, 2555);
      assert.equal(question.pledges, 3);
      assert.deepEqual(question.adds, [{ text: "Ask it twice", by: null }]);
      // An over-reach holds nothing.
      await assert.rejects(
        back(buyer, debateId, asked.questionId, 1000),
        (error) => error.code === "insufficient_balance",
      );
      assert.equal((await balances(buyer)).cashHeld, 20_000n);
      await reconcile();
    });

    it("withdraws a pledge exactly, and a withdrawn wager removes the question and refunds everyone", async () => {
      const { debateId } = await liveDebate();
      const author = await viewer(debateId),
        backer = await viewer(debateId, { cash: "1000000" }),
        other = await viewer(debateId, { grant: false, cash: "1000000" });
      const [authorBefore, backerBefore, otherBefore] = await Promise.all(
        [author, backer, other].map(balances),
      );
      const backerBook = await book(backer);
      const asked = await ask(author, debateId, "A", 1);
      const backed = await back(backer, debateId, asked.questionId, 2600);
      const third = await back(other, debateId, asked.questionId, 4);
      // L11: a pledge comes back to its exact sources.
      const withdrawn = await mic.withdraw(backer, debateId, backed.pledgeId);
      assert.deepEqual(withdrawn, {
        pledgeId: backed.pledgeId,
        questionId: asked.questionId,
        removedQuestion: false,
        refunded: [backed.pledgeId],
        created: true,
      });
      assert.deepEqual(await balances(backer), backerBefore);
      assert.deepEqual(await book(backer), backerBook);
      assert.deepEqual(await pledgeState(backed.pledgeId), {
        state: "refunded",
        refund_reason: "withdrawn",
      });
      // Repeating it moves nothing.
      assert.equal(
        (await mic.withdraw(backer, debateId, backed.pledgeId)).created,
        false,
      );
      assert.deepEqual(await balances(backer), backerBefore);
      // Only the pledger can withdraw.
      await assert.rejects(
        mic.withdraw(other, debateId, asked.pledgeId),
        refused(404, /nothing to withdraw/),
      );
      // L20: the wager takes the question and every pledge with it.
      const removed = await mic.withdraw(author, debateId, asked.pledgeId);
      assert.equal(removed.removedQuestion, true);
      assert.deepEqual(
        new Set(removed.refunded),
        new Set([asked.pledgeId, third.pledgeId]),
      );
      assert.deepEqual(await balances(author), authorBefore);
      assert.deepEqual(await balances(other), otherBefore);
      assert.deepEqual(await pledgeState(third.pledgeId), {
        state: "refunded",
        refund_reason: "question_removed",
      });
      assert.deepEqual((await mic.read(debateId)).list.camps.B, []);
      await assert.rejects(
        back(other, debateId, asked.questionId, 1),
        refused(409, /isn't open any more/),
      );
      // A withdrawn question frees the author to ask again (L23).
      await ask(author, debateId, "A", 1);
      for (const context of [author, backer, other]) await agrees(context);
      await reconcile();
    });

    it("refuses debaters, absent viewers, a second open question and a debate that isn't live", async () => {
      const { debateId, debaters } = await liveDebate();
      const author = await viewer(debateId);
      const asked = await ask(author, debateId, "A", 1);
      await sandbox.initialize(debaters.A);
      await present(debaters.A, debateId);
      await assert.rejects(
        ask(debaters.A, debateId, "B", 1),
        refused(403, /debaters can't/),
      );
      await assert.rejects(
        back(debaters.A, debateId, asked.questionId, 1),
        refused(403, /debaters can't/),
      );
      const absent = await actor();
      await sandbox.initialize(absent);
      await assert.rejects(
        back(absent, debateId, asked.questionId, 1),
        refused(403, /join the live debate/),
      );
      await assert.rejects(
        ask(author, debateId, "B", 1),
        refused(409, /already have a question open/),
      );
      await assert.rejects(
        mic.submitQuestion(author, debateId, {
          target: "B",
          text: "x".repeat(201),
          wager: YC,
          requestId: randomUUID(),
        }),
        refused(400, /at most 200/),
      );
      const { debateId: quiet } = await liveDebate({ list: false });
      const early = await viewer(quiet);
      await assert.rejects(
        ask(early, quiet, "A", 1),
        refused(409, /list isn't open/),
      );
      await owner.query("UPDATE debates SET status='ended' WHERE id=$1", [
        debateId,
      ]);
      await assert.rejects(
        back(await viewer(debateId), debateId, asked.questionId, 1),
        refused(409, /only open while the debate is live/),
      );
      for (const context of [debaters.A, absent])
        assert.deepEqual(await balances(context), {
          cash: 0n,
          cashHeld: 0n,
          promo: 25_000_000n,
          promoHeld: 0n,
        });
      await reconcile();
    });

    it("lets only the camp's #1 fire, pays the debaters the full total in halves and refunds the rest of the camp", async () => {
      await seedCenter();
      const { debateId, debaters } = await liveDebate();
      const sys = await systemAccounts();
      const first = await viewer(debateId),
        mixed = await viewer(debateId, { cash: "1000000" }),
        second = await viewer(debateId, { grant: false, cash: "1000000" }),
        backer = await viewer(debateId, { grant: false, cash: "1000000" }),
        otherCamp = await viewer(debateId);
      const secondBefore = await balances(second),
        backerBefore = await balances(backer);
      // Camp A (questions to debater B): 2 + 2,550 against 5 + 3.
      const top = await ask(first, debateId, "B", 2);
      const big = await back(mixed, debateId, top.questionId, 2550);
      const runnerUp = await ask(second, debateId, "B", 5);
      const runnerBacked = await back(backer, debateId, runnerUp.questionId, 3);
      // Camp B (a question to debater A) is untouched by camp A's fire.
      const across = await ask(otherCamp, debateId, "A", 1);
      await assert.rejects(
        mic.fire(second, debateId, runnerUp.questionId, randomUUID()),
        refused(409, /only the camp's #1/),
      );
      await assert.rejects(
        mic.fire(mixed, debateId, top.questionId, randomUUID()),
        refused(403, /only the question's author/),
      );
      const fired = await mic.fire(
        first,
        debateId,
        top.questionId,
        randomUUID(),
      );
      assert.equal(fired.state, "live");
      assert.equal(fired.price, 2552);
      // The debaters receive 2,552 YC, 1,276 each, all cash-backed.
      for (const side of ["A", "B"]) {
        assert.deepEqual(await balances(debaters[side]), {
          cash: 12_760_000n,
          cashHeld: 0n,
          promo: 0n,
          promoHeld: 0n,
        });
        const { purchased } = await book(debaters[side]);
        assert.deepEqual(
          purchased.map((p) => [p.kind, p.balance, p.id]),
          [["purchased_profit", "12760000", `mic:${fired.micId}`]],
        );
        await agrees(debaters[side]);
      }
      // Grant coins are burned to the grant issuer and the center pays the
      // same amount; cash-backed coins go straight to the debaters.
      const firstMoney = await balances(first);
      assert.equal(firstMoney.promo, 25_000_000n - 20_000n);
      assert.equal(firstMoney.promoHeld, 0n);
      const mixedMoney = await balances(mixed);
      assert.deepEqual(mixedMoney, {
        cash: 500_000n,
        cashHeld: 0n,
        promo: 0n,
        promoHeld: 0n,
      });
      const bigCash = await journal(mixed, "spend", "usdc", big.pledgeId);
      assert.equal(bigCash[sys.center_available], -25_000_000n);
      const bigPromo = await journal(mixed, "spend", "yc_promo", big.pledgeId);
      assert.equal(bigPromo[sys.grant_issuer], 25_000_000n);
      const firstCash = await journal(first, "spend", "usdc", top.pledgeId);
      assert.equal(firstCash[sys.center_available], -20_000n);
      for (const pledgeId of [top.pledgeId, big.pledgeId])
        assert.deepEqual(await pledgeState(pledgeId), {
          state: "paid",
          refund_reason: null,
        });
      // L14: the rest of the camp is refunded in full.
      assert.deepEqual(await balances(second), secondBefore);
      assert.deepEqual(await balances(backer), backerBefore);
      for (const pledgeId of [runnerUp.pledgeId, runnerBacked.pledgeId])
        assert.deepEqual(await pledgeState(pledgeId), {
          state: "refunded",
          refund_reason: "camp_fired",
        });
      assert.equal((await pledgeState(across.pledgeId)).state, "held");
      // L10, L22: the camp has its mic; it takes no more questions or pledges.
      await assert.rejects(
        ask(second, debateId, "B", 1),
        refused(409, /camp has already fired/),
      );
      await assert.rejects(
        back(backer, debateId, runnerUp.questionId, 1),
        refused(409, /isn't open any more/),
      );
      // F11, F12: the other camp's #1 fires while a mic is live: it queues.
      const queued = await mic.fire(
        otherCamp,
        debateId,
        across.questionId,
        randomUUID(),
      );
      assert.equal(queued.state, "queued");
      const view = await mic.read(debateId);
      assert.deepEqual(
        view.mics.map((m) => [m.camp, m.target, m.state, m.price]),
        [
          ["A", "B", "live", 2552],
          ["B", "A", "queued", 1],
        ],
      );
      assert.deepEqual(view.list.camps, { A: [], B: [] });
      for (const side of ["A", "B"])
        assert.equal((await balances(debaters[side])).cash, 12_765_000n);
      for (const context of [first, mixed, second, backer, otherCamp])
        await agrees(context);
      await reconcile();
    });

    it("refuses to fire while a seat is empty, moving nothing", async () => {
      await seedCenter();
      const { debateId } = await liveDebate();
      const author = await viewer(debateId);
      const asked = await ask(author, debateId, "B", 2);
      await owner.query(
        "UPDATE debates SET speaker_a_profile_id=NULL WHERE id=$1",
        [debateId],
      );
      const before = await balances(author);
      await assert.rejects(
        mic.fire(author, debateId, asked.questionId, randomUUID()),
        refused(409, /seats must be filled/),
      );
      assert.deepEqual(await balances(author), before);
      assert.equal((await pledgeState(asked.pledgeId)).state, "held");
    });

    it("answers a retried request with its first result and moves nothing twice", async () => {
      await seedCenter();
      const { debateId } = await liveDebate();
      const author = await viewer(debateId),
        backer = await viewer(debateId);
      const askId = randomUUID();
      const asked = await ask(author, debateId, "A", 2, askId);
      const text = (
        await owner.query("SELECT body FROM mic_questions WHERE id=$1", [
          asked.questionId,
        ])
      ).rows[0].body;
      const again = await mic.submitQuestion(author, debateId, {
        target: "A",
        text,
        wager: 2n * YC,
        requestId: askId,
      });
      assert.deepEqual(again, { ...asked, created: false });
      await assert.rejects(
        mic.submitQuestion(author, debateId, {
          target: "A",
          text,
          wager: 3n * YC,
          requestId: askId,
        }),
        refused(409, /different request/),
      );
      const pledgeId = randomUUID();
      const input = { amount: 4n * YC, add: "Please", requestId: pledgeId };
      const backed = await mic.pledge(
        backer,
        debateId,
        asked.questionId,
        input,
      );
      const backerHeld = await balances(backer);
      assert.deepEqual(
        await mic.pledge(backer, debateId, asked.questionId, input),
        { ...backed, created: false },
      );
      assert.deepEqual(await balances(backer), backerHeld);
      // The same request id from another account is that account's own.
      const other = await viewer(debateId);
      assert.equal(
        (await mic.pledge(other, debateId, asked.questionId, input)).created,
        true,
      );
      const fireId = randomUUID();
      const fired = await mic.fire(author, debateId, asked.questionId, fireId);
      const paid = await balances(author);
      assert.deepEqual(
        await mic.fire(author, debateId, asked.questionId, fireId),
        { ...fired, created: false },
      );
      assert.deepEqual(await balances(author), paid);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM mic_pledges p JOIN mic_questions q ON q.id=p.question_id WHERE q.debate_id=$1",
            [debateId],
          )
        ).rows[0].n,
        3,
      );
      await reconcile();
    });

    it("never lets an outbid and a fire that arrive together both win", async () => {
      await seedCenter();
      for (let attempt = 0; attempt < 3; attempt++) {
        const { debateId } = await liveDebate();
        const leader = await viewer(debateId),
          challenger = await viewer(debateId),
          outbidder = await viewer(debateId);
        const top = await ask(leader, debateId, "B", 2);
        const next = await ask(challenger, debateId, "B", 1);
        // Hold the list row so both requests wait for it, then let them race.
        const blocker = await owner.connect();
        let results;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM mic_lists WHERE debate_id=$1 FOR UPDATE",
            [debateId],
          );
          // Either may reach the lock first; alternate which starts first.
          const firing = () =>
              mic.fire(leader, debateId, top.questionId, randomUUID()),
            outbidding = () => back(outbidder, debateId, next.questionId, 5);
          const racing =
            attempt % 2
              ? Promise.allSettled([firing(), outbidding()])
              : Promise.allSettled([outbidding(), firing()]).then(
                  ([outbid, fired]) => [fired, outbid],
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
        const [fired, outbid] = results;
        assert.notEqual(
          fired.status === "fulfilled" && outbid.status === "fulfilled",
          true,
          "the fire and the outbid both won",
        );
        assert.ok(
          fired.status === "fulfilled" || outbid.status === "fulfilled",
          "one of them goes through",
        );
        if (fired.status === "fulfilled")
          assert.match(outbid.reason.message, /isn't open any more/);
        else {
          assert.match(fired.reason.message, /only the camp's #1/);
          const [first] = (await mic.read(debateId)).list.camps.A;
          assert.equal(first.id, next.questionId);
        }
        const mics = (await mic.read(debateId)).mics;
        assert.equal(mics.length, fired.status === "fulfilled" ? 1 : 0);
      }
      await reconcile();
    });

    it("keeps mic rows moving forward only, and runtime grants narrow", async () => {
      const { debateId } = await liveDebate();
      const author = await viewer(debateId);
      const asked = await ask(author, debateId, "A", 1);
      await assert.rejects(
        runtime.query("UPDATE mic_pledges SET amount=20000 WHERE id=$1", [
          asked.pledgeId,
        ]),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query("UPDATE mic_pledges SET state='held' WHERE id=$1", [
          asked.pledgeId,
        ]),
        /only move forward/,
      );
      await assert.rejects(
        runtime.query("DELETE FROM mic_questions WHERE id=$1", [
          asked.questionId,
        ]),
        /permission denied/,
      );
      // One open list per debate: opening again returns the open one.
      const again = await mic.createList(debateId, 5);
      assert.equal(again.created, false);
      assert.equal(again.n, 1);
    });
  },
);
