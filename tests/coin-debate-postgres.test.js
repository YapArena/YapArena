import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createCoinDebateSandbox,
  COIN_DEBATE_FACE,
  COIN_DEBATE_TERMS,
} from "../dist/features/account-wallet/debate-sandbox.js";
import {
  appendSandboxBookEvent,
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
  ensureSandboxBuckets,
  lockSandboxBook,
  withdrawalApprovalTerms,
} from "../dist/features/account-wallet/sandbox-repository.js";
import {
  digest,
  executeRound,
  priceRound,
  randomWord,
} from "../dist/features/a4/engine.js";
import { postCoinJournal } from "../dist/features/account-wallet/ledger.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { runCoinSandboxOperator } from "../scripts/coin-sandbox-operator.ts";
import {
  attachSubject,
  confirmedApproval,
  openSandbox,
} from "./helpers/confirmations.js";
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "isolated currency attached to existing YES/NO debates",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, sandbox, operator, a4, a4Other;
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
      a4 = createCoinDebateSandbox(runtime, "simulation");
      a4Other = createCoinDebateSandbox(runtime, "simulation");
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    // An Auth0 account that, unless told otherwise, already has the automatic
    // opening its first own request records (Decision 0013).
    async function actor({ opened = true } = {}) {
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
      const subject = await attachSubject(owner, user.id);
      if (opened) await openSandbox(owner, user.id);
      return { userId: user.id, sessionTokenHash: token.tokenHash, subject };
    }
    // Most cases settle at the cutoff, so their debates are recorded as
    // founder-created per-round debates (F11); five-day is the default.
    async function debate({ reveal = "per_round", speaker = null } = {}) {
      const topic = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Currency test','Synthetic currency fixture','Support','Oppose','published') RETURNING id",
          [`coin-a4-${randomUUID()}`],
        )
      ).rows[0];
      const id = (
        await owner.query(
          "INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,rules_snapshot,speaker_a_profile_id) VALUES($1,$2,'Should we use this existing debate?','scheduled','published','preview-1','{}',$3) RETURNING id",
          [topic.id, `coin-a4-${randomUUID()}`, speaker],
        )
      ).rows[0].id;
      if (reveal === "per_round")
        await owner.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,'per_round','Founder-created test debate')",
          [id],
        );
      return id;
    }
    async function seed(context, purpose, amount) {
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose,
        amount,
        idempotencyKey: randomUUID(),
      });
    }
    async function fund(context, amount = "10000000") {
      const q = await sandbox.quoteFunding(context, {
        amount,
        idempotencyKey: randomUUID(),
      });
      await sandbox.confirmSimulatedFunding(context, { requestId: q.id });
    }
    // Clock advancement is a privileged fixture action in a disposable database.
    // Runtime cannot change terms/cutoff or disable this trigger (asserted below).
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
    async function withEmptyTreasury(context, callback) {
      // Real runtime SQL in an outer rollback-only fixture transaction. Other
      // suites never see depleted shared treasury balances. Savepoints let the
      // unchanged repository own its normal BEGIN/ROLLBACK scope inside it.
      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          context.userId,
        ]);
        const buckets = await ensureSandboxBuckets(client, context.userId);
        const accounts = (
          await client.query(
            "SELECT id,balance::text FROM coin_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [
              [
                buckets.system.center_available,
                buckets.system.promotional_available,
              ],
            ],
          )
        ).rows;
        const total = accounts.reduce((n, a) => n + BigInt(a.balance), 0n);
        if (total)
          await postCoinJournal(client, {
            id: randomUUID(),
            environment: "sandbox",
            asset: "USDC",
            operation: "reserve",
            reference: randomUUID(),
            postings: [
              ...accounts
                .filter((a) => a.balance !== "0")
                .map((a) => ({
                  accountId: a.id,
                  amount: String(-BigInt(a.balance)),
                })),
              {
                accountId: buckets.system.correction_available,
                amount: String(total),
              },
            ],
          });
        const nestedPool = {
          async connect() {
            return {
              query(sql, values) {
                if (sql === "BEGIN")
                  return client.query("SAVEPOINT empty_treasury_test");
                if (sql === "COMMIT")
                  return client.query("RELEASE SAVEPOINT empty_treasury_test");
                if (sql === "ROLLBACK")
                  return client.query(
                    "ROLLBACK TO SAVEPOINT empty_treasury_test",
                  );
                return client.query(sql, values);
              },
              release() {},
            };
          },
        };
        await callback(createCoinDebateSandbox(nestedPool, "simulation"));
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    async function waitForBlocked(pid, minimum) {
      for (let attempt = 0; attempt < 150; attempt++) {
        const count = (
          await owner.query(
            `WITH RECURSIVE waiters AS (
              SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))
              UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid))
            ) SELECT count(*)::int n FROM waiters`,
            [pid],
          )
        ).rows[0].n;
        if (count >= minimum) return;
        await owner.query("SELECT pg_sleep(0.01)");
      }
      assert.fail(
        "concurrent operations did not reach the controlled account-lock barrier",
      );
    }
    async function withdrawalAuthorization(context) {
      const quote = await sandbox.quoteWithdrawal(context, {
          idempotencyKey: randomUUID(),
          gross: "5000000",
          destination: "synthetic-external-wallet",
        }),
        { id, approval } = await confirmedApproval(runtime, {
          userId: context.userId,
          sessionTokenHash: context.sessionTokenHash,
          subject: context.subject,
          purpose: "withdrawal.request",
          terms: withdrawalApprovalTerms(quote),
        });
      return { quote, operation: { id }, approval };
    }
    it("opens the sandbox automatically on an account's first debate request (Decision 0013)", async () => {
      const newcomer = await actor({ opened: false }),
        host = await actor(),
        debateId = await debate(),
        openings = async () =>
          (
            await owner.query(
              "SELECT operation_id FROM coin_sandbox_openings WHERE user_id=$1",
              [newcomer.userId],
            )
          ).rows;
      assert.equal((await sandbox.summary(newcomer)).opened, false);
      assert.deepEqual(await openings(), []);
      const round = await a4.create(host, debateId, randomUUID());
      // Joining the open round is the newcomer's first request: no refusal and
      // no confirmation, just an automatic opening.
      assert.equal(
        (await a4.create(newcomer, debateId, randomUUID())).id,
        round.id,
      );
      assert.deepEqual(await openings(), [{ operation_id: null }]);
      await sandbox.initialize(newcomer);
      await seed(newcomer, "center", "1000000");
      await seed(newcomer, "promotional", "1000000");
      await a4.submit(newcomer, round.id, randomUUID(), {
        side: "YES",
        limit: "1",
        quantity: 1,
      });
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_debate_orders WHERE user_id=$1",
            [newcomer.userId],
          )
        ).rows[0].n,
        1,
      );
    });
    it("serializes purchased A4 stakes against fresh-authorized withdrawals without partial reservations in either lock order", async () => {
      const financialCounts = async (userId) =>
        (
          await owner.query(
            `SELECT
        (SELECT count(*)::int FROM coin_sandbox_events WHERE user_id=$1) AS events,
        (SELECT count(DISTINCT p.journal_id)::int FROM coin_postings p JOIN coin_accounts a ON a.id=p.account_id WHERE a.user_id=$1) AS journals`,
            [userId],
          )
        ).rows[0];
      for (const first of ["stake", "withdrawal"]) {
        const context = await actor(),
          debateId = await debate();
        await fund(context, "5000000");
        await seed(context, "center", "1000000");
        const round = await a4.create(context, debateId, randomUUID()),
          { quote, operation, approval } =
            await withdrawalAuthorization(context),
          before = await financialCounts(context.userId);
        const attempt = {
          stake: () =>
            a4Other.submit(context, round.id, randomUUID(), {
              side: "YES",
              limit: "1",
              quantity: 100,
            }),
          withdrawal: () =>
            sandbox.requestWithdrawal(context, {
              requestId: quote.id,
              approval,
            }),
        };
        const guarded = (kind) =>
          attempt[kind]().then(
            (value) => ({ status: "fulfilled", value }),
            (reason) => ({ status: "rejected", reason }),
          );
        const gate = await owner.connect();
        let winner, loser;
        try {
          await gate.query("BEGIN");
          await gate.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            context.userId,
          ]);
          const pid = (await gate.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          winner = guarded(first);
          await waitForBlocked(pid, 1);
          loser = guarded(first === "stake" ? "withdrawal" : "stake");
          await waitForBlocked(pid, 2);
        } finally {
          await gate.query("COMMIT");
          gate.release();
        }
        const results = await Promise.all([winner, loser]);
        assert.equal(results[0].status, "fulfilled");
        assert.equal(results[1].status, "rejected");
        assert.match(results[1].reason.message, /insufficient/);
        const stakeWon = first === "stake",
          reserved = stakeWon ? 1000000n : 5000000n,
          summary = await sandbox.summary(context),
          after = await financialCounts(context.userId);
        assert.equal(
          summary.book.grants.length,
          0,
          "no grant may hide purchased overspending",
        );
        assert.equal(
          summary.balances.cashAvailable,
          String(5000000n - reserved),
        );
        assert.equal(summary.balances.reserved, String(reserved));
        assert.equal(summary.balances.pending, "0");
        assert.equal(summary.balances.promotionalPrincipal, "0");
        assert.equal(
          summary.book.purchased.reduce(
            (total, source) => total + BigInt(source.balance),
            0n,
          ),
          5000000n - reserved,
        );
        assert.deepEqual(after, {
          events: before.events + 1,
          journals: before.journals + 1,
        });
        const orderCount = (
          await owner.query(
            "SELECT count(*)::int n FROM coin_debate_orders WHERE round_id=$1",
            [round.id],
          )
        ).rows[0].n;
        assert.equal(orderCount, stakeWon ? 1 : 0);
        const requestState = (
          await owner.query(
            "SELECT status FROM coin_sandbox_requests WHERE id=$1",
            [quote.id],
          )
        ).rows[0].status;
        assert.equal(requestState, stakeWon ? "quoted" : "review");
        const consumed = (
          await owner.query(
            "SELECT consumed_at IS NOT NULL AS consumed FROM account_operations WHERE id=$1",
            [operation.id],
          )
        ).rows[0].consumed;
        assert.equal(
          consumed,
          !stakeWon,
          "a failed financial reservation must not consume its fresh proof",
        );
        const events = (
          await owner.query(
            "SELECT kind FROM coin_sandbox_events WHERE user_id=$1 AND kind IN ('debate.reserved','withdrawal.reserved')",
            [context.userId],
          )
        ).rows.map((row) => row.kind);
        assert.deepEqual(events, [
          stakeWon ? "debate.reserved" : "withdrawal.reserved",
        ]);
        await reconcile();
        if (stakeWon)
          await createCoinDebateSandbox(owner, "simulation").voidRound(
            round.id,
            "operator_cancelled",
          );
        else
          await operator.review({
            userId: context.userId,
            requestId: quote.id,
            decision: "reject",
            idempotencyKey: randomUUID(),
          });
        const restored = await sandbox.summary(context);
        assert.equal(restored.balances.cashAvailable, "5000000");
        assert.equal(restored.balances.reserved, "0");
        assert.equal(
          restored.book.purchased.reduce(
            (total, source) => total + BigInt(source.balance),
            0n,
          ),
          5000000n,
        );
      }
    });
    it("rolls back ordered settlements when a create caller expires during ledger waits on either existing-round return path", async () => {
      const context = await actor(),
        other = await actor(),
        debateId = await debate(),
        key = randomUUID();
      await a4.create(context, debateId, key);
      await fund(other);
      await seed(other, "center", "1000000");
      const due = await a4.create(other, await debate(), randomUUID());
      await a4.submit(other, due.id, randomUUID(), {
        side: "YES",
        limit: "1",
        quantity: 1,
      });
      await close(due.id);
      const before = (await sandbox.summary(other)).book,
        account = (
          await owner.query(
            "SELECT id FROM coin_accounts WHERE user_id=$1 AND asset='USDC' AND kind='available'",
            [context.userId],
          )
        ).rows[0].id;
      const expireFunction = `fixture_expiry_${randomUUID().replaceAll("-", "")}`,
        fixture = await owner.connect();
      assert.match(context.userId, /^[1-9][0-9]*$/);
      try {
        await fixture.query("BEGIN");
        await fixture.query(`CREATE FUNCTION yaparena.${expireFunction}(bigint)
          RETURNS integer LANGUAGE sql SECURITY DEFINER
          SET search_path=pg_catalog,yaparena,pg_temp AS $$
          WITH expired AS (UPDATE yaparena.sessions
            SET expires_at=clock_timestamp()-interval '1 second'
            WHERE id=$1 AND user_id=${context.userId} RETURNING id)
          SELECT count(*)::integer FROM expired $$`);
        await fixture.query(
          `REVOKE ALL ON FUNCTION yaparena.${expireFunction}(bigint) FROM PUBLIC`,
        );
        await fixture.query(
          `GRANT EXECUTE ON FUNCTION yaparena.${expireFunction}(bigint) TO yaparena_runtime`,
        );
        await fixture.query("COMMIT");
      } catch (error) {
        await fixture.query("ROLLBACK");
        throw error;
      } finally {
        fixture.release();
      }
      let inFlight;
      try {
        for (const existingReference of [false, true]) {
          const token = createSessionToken(),
            generation = (
              await owner.query(
                "SELECT auth_generation FROM users WHERE id=$1",
                [context.userId],
              )
            ).rows[0].auth_generation,
            session = await createSessionRepository(runtime).create(
              context.userId,
              token.tokenHash,
              new Date(Date.now() + 3600000),
              { authGeneration: generation },
            ),
            shortContext = {
              ...context,
              sessionTokenHash: token.tokenHash,
              expectedSessionId: session.id,
            },
            gate = await owner.connect();
          let initialSessionAuthorized = false,
            ledgerBarrierObserved = false,
            expirations = 0;
          const expiringCaller = createCoinDebateSandbox(
            {
              query: (...args) => runtime.query(...args),
              async connect() {
                const client = await runtime.connect();
                return {
                  release: () => client.release(),
                  async query(sql, values) {
                    const result = await client.query(sql, values);
                    if (
                      typeof sql === "string" &&
                      sql.includes("FOR UPDATE OF s") &&
                      result.rows.some((row) => row.id === session.id)
                    )
                      initialSessionAuthorized = true;
                    if (
                      expirations === 0 &&
                      typeof sql === "string" &&
                      sql.includes("FROM coin_accounts") &&
                      sql.includes("FOR UPDATE") &&
                      result.rows.some((row) => row.id === account)
                    ) {
                      assert.equal(initialSessionAuthorized, true);
                      assert.equal(ledgerBarrierObserved, true);
                      // Runtime owns the session row lock. The temporary,
                      // exact-user fixture function changes expiry on this same
                      // connection without granting runtime UPDATE(expires_at).
                      const expired = await client.query(
                        `SELECT yaparena.${expireFunction}($1::bigint) AS expired`,
                        [session.id],
                      );
                      assert.equal(expired.rows[0].expired, 1);
                      expirations++;
                    }
                    return result;
                  },
                };
              },
            },
            "simulation",
          );
          let pending;
          try {
            await gate.query("BEGIN");
            await gate.query(
              "SELECT id FROM coin_accounts WHERE id=$1 FOR UPDATE",
              [account],
            );
            const pid = (await gate.query("SELECT pg_backend_pid() AS pid"))
              .rows[0].pid;
            pending = inFlight = expiringCaller.create(
              shortContext,
              debateId,
              existingReference ? key : randomUUID(),
            );
            pending.catch(() => {});
            await waitForBlocked(pid, 1);
            ledgerBarrierObserved = true;
          } finally {
            await gate.query("COMMIT");
            gate.release();
          }
          await assert.rejects(pending, /session/);
          assert.equal(initialSessionAuthorized, true);
          assert.equal(ledgerBarrierObserved, true);
          assert.equal(expirations, 1);
          assert.equal(
            (
              await owner.query(
                "SELECT state FROM coin_debate_rounds WHERE id=$1",
                [due.id],
              )
            ).rows[0].state,
            "open",
          );
          assert.deepEqual((await sandbox.summary(other)).book, before);
        }
      } finally {
        await inFlight?.catch(() => {});
        await owner.query(`DROP FUNCTION yaparena.${expireFunction}(bigint)`);
      }
      assert.equal((await a4.advance()).completed, 1);
      await reconcile();
    });
    it("locks every due account before shared ledger rows so unrelated payout reconciliation remains available", async () => {
      const one = await actor(),
        two = await actor(),
        payee = await actor(),
        rounds = [];
      for (const context of [one, two]) {
        await fund(context);
        await seed(context, "center", "1000000");
        const round = await a4.create(context, await debate(), randomUUID());
        await a4.submit(context, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 100,
        });
        rounds.push(round);
      }
      await fund(payee, "5000000");
      const { quote, approval } = await withdrawalAuthorization(payee);
      await sandbox.requestWithdrawal(payee, { requestId: quote.id, approval });
      await operator.review({
        userId: payee.userId,
        requestId: quote.id,
        decision: "approve",
        idempotencyKey: randomUUID(),
      });
      for (const round of rounds) await close(round.id);
      const gate = await owner.connect();
      let advancing, payout, timer;
      try {
        await gate.query("BEGIN");
        await gate.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          two.userId,
        ]);
        const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        advancing = a4.advance();
        // Attach rejection immediately: a failed assertion must still release
        // the gate and join every in-flight mutation before the test exits.
        advancing.catch(() => {});
        await waitForBlocked(pid, 1);
        assert.deepEqual(
          (
            await owner.query(
              "SELECT state FROM coin_debate_rounds WHERE id=ANY($1::uuid[]) ORDER BY closes_at,id",
              [rounds.map((r) => r.id)],
            )
          ).rows.map((r) => r.state),
          ["open", "open"],
        );
        const transactionId = `synthetic-batch-${randomUUID()}`;
        payout = operator.observe({
          userId: payee.userId,
          requestId: quote.id,
          event: {
            id: randomUUID(),
            externalId: quote.id,
            termsDigest: quote.termsDigest,
            source: "reconciliation",
            status: "completed",
            finalNoTransfer: false,
            transactionId,
          },
          receipt: {
            network: "simulation:usdc",
            transactionId,
            locator: "transfer:0",
            amount: "4900000",
            evidenceDigest: digest(transactionId),
          },
        });
        const result = await Promise.race([
          payout,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error(
                    "batch held shared ledger locks while waiting for a later account",
                  ),
                ),
              1500,
            );
          }),
        ]);
        assert.equal(result.status, "completed");
      } finally {
        clearTimeout(timer);
        await gate.query("COMMIT");
        gate.release();
        await Promise.allSettled([advancing, payout]);
      }
      assert.equal((await advancing).completed, 2);
      assert.equal((await sandbox.summary(payee)).balances.pending, "0");
      await reconcile();
    });
    it("applies grant qualification in closing order even when the later debate asks to open its next round first", async () => {
      for (const sameCutoff of [false, true]) {
        const context = await actor(),
          opponent = await actor(),
          debates = [await debate(), await debate()];
        await sandbox.initialize(context);
        await fund(opponent);
        await seed(context, "center", "1000000");
        await seed(context, "promotional", "100000000");
        const rounds = [];
        for (const debateId of debates) {
          const round = await a4.create(context, debateId, randomUUID());
          for (const [actor, side, limit] of [
            [context, "YES", "1"],
            [opponent, "NO", "0"],
          ])
            await a4.submit(actor, round.id, randomUUID(), {
              side,
              limit,
              quantity: 1,
            });
          rounds.push({ ...round, debateId });
        }
        if (sameCutoff)
          rounds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const population = [
          {
            participant: context.userId,
            kind: "human",
            side: "YES",
            limit: "1",
            quantity: 1,
          },
          {
            participant: opponent.userId,
            kind: "human",
            side: "NO",
            limit: "0",
            quantity: 1,
          },
        ];
        function selectedSeed(sign) {
          for (let i = 0; i < 1000; i++) {
            const seed = digest(["qualification-order-fixture", i]),
              outcome = executeRound(
                population,
                COIN_DEBATE_TERMS,
                priceRound(
                  population,
                  COIN_DEBATE_TERMS,
                  randomWord(seed, "branch"),
                  randomWord(seed, "price"),
                ),
                COIN_DEBATE_FACE,
              )[0];
            if (sign * BigInt(outcome.net) > 0n) return { seed, outcome };
          }
          assert.fail(
            "deterministic fixture did not find the requested result sign",
          );
        }
        const loss = selectedSeed(-1n),
          gain = selectedSeed(1n),
          fixture = await owner.connect();
        let target, initial;
        try {
          await fixture.query("BEGIN");
          await fixture.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            context.userId,
          ]);
          const before = await lockSandboxBook(fixture, context.userId),
            buckets = await ensureSandboxBuckets(fixture, context.userId),
            grant = before.book.grants[0];
          target = BigInt(grant.principal);
          initial = target - BigInt(gain.outcome.net);
          // Balanced simulation-only prior-profit fixture. This is never a user
          // grant or historical balance conversion, and the funded journal/event
          // explicitly records the artificial pre-existing net-profit baseline.
          const journal = await postCoinJournal(fixture, {
            id: randomUUID(),
            environment: "sandbox",
            asset: "USDC",
            operation: "payout",
            reference: randomUUID(),
            postings: [
              {
                accountId: buckets.system.promotional_available,
                amount: String(-initial),
              },
              { accountId: buckets.cashAvailable, amount: String(initial) },
            ],
          });
          await fixture.query(
            "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'sandbox','USDC',$3)",
            [grant.id, journal.id, String(initial)],
          );
          await appendSandboxBookEvent(fixture, {
            userId: context.userId,
            snapshot: before,
            book: {
              ...before.book,
              grants: before.book.grants.map((g) => ({
                ...g,
                profitRemaining: String(initial),
                netProfit: String(initial),
                peakNetProfit: String(initial),
              })),
            },
            kind: "fixture.backed-prior-profit",
            reference: digest(randomUUID()),
            termsDigest: digest(["fixture", initial.toString()]),
            cashJournalId: journal.id,
          });
          await fixture.query(
            "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
          );
          const cutoff = Date.now() - 4000;
          for (const [index, chosen] of [loss, gain].entries())
            await fixture.query(
              "UPDATE coin_debate_rounds SET seed=$2,seed_commitment=$3,opens_at=$4,closes_at=$5 WHERE id=$1",
              [
                rounds[index].id,
                chosen.seed,
                digest(chosen.seed),
                new Date(cutoff - 1000),
                new Date(cutoff + (sameCutoff ? 0 : index * 1000)),
              ],
            );
          await fixture.query(
            "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
          );
          await fixture.query("COMMIT");
        } catch (error) {
          await fixture.query("ROLLBACK");
          throw error;
        } finally {
          fixture.release();
        }
        assert.equal(
          initial + BigInt(gain.outcome.net),
          target,
          "processing the later gain first would incorrectly hit the permanent target",
        );
        await assert.rejects(
          a4.advance(20, {
            ...context,
            expectedSessionId: "999999999999999999",
          }),
          /account context changed/,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM coin_debate_rounds WHERE id=ANY($1::uuid[]) AND state='open'",
              [rounds.map((r) => r.id)],
            )
          ).rows[0].n,
          2,
        );
        await a4.create(context, rounds[1].debateId, randomUUID());
        const posted = (
          await owner.query(
            "SELECT metadata->>'roundId' AS round_id FROM coin_sandbox_events WHERE user_id=$1 AND kind='debate.settled' ORDER BY sequence",
            [context.userId],
          )
        ).rows.map((r) => r.round_id);
        assert.deepEqual(
          posted,
          rounds.map((r) => r.id),
        );
        const summary = await sandbox.summary(context),
          grant = summary.book.grants[0],
          expected =
            initial + BigInt(loss.outcome.net) + BigInt(gain.outcome.net);
        assert.equal(grant.netProfit, String(expected));
        assert.equal(
          grant.peakNetProfit,
          String(expected > initial ? expected : initial),
        );
        assert.ok(BigInt(grant.peakNetProfit) < target);
        assert.equal(summary.projection.grants[0].qualified, false);
        await reconcile();
      }
    });
    it("voids only through a guarded operator command and restores exact sources without profit", async () => {
      const context = await actor(),
        debateId = await debate();
      await sandbox.initialize(context);
      await fund(context);
      await seed(context, "center", "1000000");
      await seed(context, "promotional", "1000000");
      const before = await sandbox.summary(context),
        round = await a4.create(context, debateId, randomUUID());
      await assert.rejects(
        a4.submit(
          { ...context, expectedSessionId: "999999999999999999" },
          round.id,
          randomUUID(),
          { side: "YES", limit: "1", quantity: 10 },
        ),
        /account context changed/,
      );
      await a4.submit(context, round.id, randomUUID(), {
        side: "YES",
        limit: "1",
        quantity: 10,
      });
      await assert.rejects(
        a4.voidRound(round.id, "operator_cancelled"),
        /operator ownership/,
      );
      const operatorA4 = createCoinDebateSandbox(owner, "simulation");
      assert.equal(
        (await operatorA4.voidRound(round.id, "operator_cancelled")).created,
        true,
      );
      assert.equal(
        (await operatorA4.voidRound(round.id, "operator_cancelled")).created,
        false,
      );
      assert.deepEqual((await sandbox.summary(context)).book, before.book);
      const view = (await a4.view(context, debateId))[0];
      assert.equal(view.state, "void");
      assert.equal(view.seed, undefined);
      assert.equal(view.pricing, undefined);
      await reconcile();
    });
    it("reserves independent center/promo backing, fixes first commitment, and never reveals pre-cutoff information", async () => {
      const context = await actor(),
        debateId = await debate();
      await sandbox.initialize(context);
      const openKey = randomUUID(),
        round = await a4.create(context, debateId, openKey);
      assert.equal((await a4.create(context, debateId, openKey)).id, round.id);
      await withEmptyTreasury(context, (unfunded) =>
        assert.rejects(
          unfunded.submit(context, round.id, randomUUID(), {
            side: "YES",
            limit: "1",
            quantity: 100,
          }),
          /insufficient funds/,
        ),
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_debate_orders WHERE round_id=$1",
            [round.id],
          )
        ).rows[0].n,
        0,
      );
      await seed(context, "center", "1000000");
      await seed(context, "promotional", "1000000");
      const key = randomUUID(),
        input = { side: "YES", limit: "1", quantity: 100 };
      const results = await Promise.all([
        a4.submit(context, round.id, key, input),
        a4Other.submit(context, round.id, key, input),
      ]);
      assert.equal(new Set(results.map((r) => r.id)).size, 1);
      assert.equal(results.filter((r) => r.created).length, 1);
      await assert.rejects(
        a4.submit(context, round.id, key, { ...input, quantity: 1 }),
        /different participation/,
      );
      await assert.rejects(
        a4.submit(context, round.id, randomUUID(), input),
        /first commitment/,
      );
      const view = (await a4.view(context, debateId))[0];
      assert.ok(view.own);
      assert.equal(view.seed, undefined);
      assert.equal(view.pricing, undefined);
      assert.equal(view.outcome, undefined);
      assert.equal(view.snapshotHash, undefined);
      assert.equal((await a4.advance()).completed, 0);
      const summary = await sandbox.summary(context);
      assert.equal(summary.balances.cashAvailable, "0");
      assert.equal(summary.balances.promotionalPrincipal, "24000000");
      await assert.rejects(
        runtime.query(
          "UPDATE coin_debate_rounds SET closes_at=clock_timestamp() WHERE id=$1",
          [round.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query(
          "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
        ),
        /must be owner/,
      );
      await close(round.id);
      await a4.advance();
      const after = await sandbox.summary(context);
      assert.equal(after.balances.promotionalPrincipal, "25000000");
      assert.equal(after.balances.cashAvailable, "0");
      assert.equal(after.book.grants[0].netProfit, "0");
      await reconcile();
    });
    it("settles the real A4 algorithm using actual charged source weights and isolates historical play, virtual principal and backed profit", async () => {
      const one = await actor(),
        two = await actor(),
        debateId = await debate();
      await sandbox.initialize(one);
      await sandbox.initialize(two);
      await fund(one);
      await seed(one, "center", "10000000");
      await seed(one, "promotional", "50000000");
      // Explicitly consume most virtual principal in a balanced fixture event to
      // exercise a mixed stake without silently giving the grant any cash value.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        const before = await lockSandboxBook(client, one.userId),
          buckets = await ensureSandboxBuckets(client, one.userId);
        const burned = BigInt(before.book.grants[0].principalRemaining) - 5000n;
        const journal = await postCoinJournal(client, {
          id: randomUUID(),
          environment: "sandbox",
          asset: "YC_PROMO",
          operation: "payout",
          reference: randomUUID(),
          postings: [
            { accountId: buckets.promoAvailable, amount: String(-burned) },
            { accountId: buckets.system.grant_issuer, amount: String(burned) },
          ],
        });
        await appendSandboxBookEvent(client, {
          userId: one.userId,
          snapshot: before,
          book: {
            ...before.book,
            grants: before.book.grants.map((g) => ({
              ...g,
              principalRemaining: "5000",
            })),
          },
          kind: "fixture.virtual-spend",
          reference: digest(randomUUID()),
          termsDigest: digest("fixture"),
          promoJournalId: journal.id,
        });
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      const historyBefore = (
        await owner.query(
          "SELECT count(*)::int n FROM a4_postings p JOIN a4_accounts a ON a.id=p.account_id WHERE a.user_id=ANY($1::bigint[])",
          [[one.userId, two.userId]],
        )
      ).rows[0].n;
      const round = await a4.create(one, debateId, randomUUID());
      await a4.submit(one, round.id, randomUUID(), {
        side: "YES",
        limit: "1",
        quantity: 10,
      });
      await a4.submit(two, round.id, randomUUID(), {
        side: "NO",
        limit: "0",
        quantity: 10,
      });
      await close(round.id);
      const row = (
        await owner.query("SELECT * FROM coin_debate_rounds WHERE id=$1", [
          round.id,
        ])
      ).rows[0];
      const orders = (
        await owner.query(
          "SELECT * FROM coin_debate_orders WHERE round_id=$1 ORDER BY user_id",
          [round.id],
        )
      ).rows;
      const snapshot = orders.map((o) => ({
        participant: o.user_id,
        kind: "human",
        side: o.side,
        limit: o.limit_value,
        quantity: o.quantity,
      }));
      const expected = executeRound(
        snapshot,
        row.terms,
        priceRound(
          snapshot,
          row.terms,
          randomWord(row.seed, "branch"),
          randomWord(row.seed, "price"),
        ),
        COIN_DEBATE_FACE,
      );
      const advances = await Promise.all([a4.advance(), a4Other.advance()]);
      assert.equal(
        advances.reduce((n, r) => n + r.completed, 0),
        1,
      );
      const views = await a4.view(one, debateId);
      assert.deepEqual(
        views[0].outcome,
        expected.find((o) => o.participant === one.userId),
      );
      assert.equal(digest(views[0].seed), views[0].seedCommitment);
      const receipt = (
        await owner.query(
          "SELECT metadata FROM coin_sandbox_events WHERE request_id=$1 AND kind='debate.settled'",
          [orders.find((o) => o.user_id === one.userId).request_id],
        )
      ).rows[0].metadata;
      assert.equal(
        receipt.committedFunding.amount,
        String(BigInt(views[0].outcome.premium) + BigInt(views[0].outcome.fee)),
      );
      assert.equal(
        receipt.sources.reduce((n, s) => n + BigInt(s.netResult), 0n),
        BigInt(views[0].outcome.net),
      );
      assert.equal(
        receipt.sources.reduce((n, s) => n + BigInt(s.returned), 0n),
        BigInt(views[0].outcome.payout),
      );
      const summary = await sandbox.summary(one);
      const sourceCash =
        summary.book.purchased.reduce((n, s) => n + BigInt(s.balance), 0n) +
        summary.book.grants.reduce((n, g) => n + BigInt(g.profitRemaining), 0n);
      assert.equal(BigInt(summary.balances.cashAvailable), sourceCash);
      assert.equal(
        BigInt(summary.balances.promotionalPrincipal),
        summary.book.grants.reduce(
          (n, g) => n + BigInt(g.principalRemaining),
          0n,
        ),
      );
      assert.equal(summary.balances.reserved, "0");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM a4_postings p JOIN a4_accounts a ON a.id=p.account_id WHERE a.user_id=ANY($1::bigint[])",
            [[one.userId, two.userId]],
          )
        ).rows[0].n,
        historyBefore,
      );
      await reconcile();
      assert.equal((await a4.advance()).completed, 0);
    });
    it("rejects late or revoked commitments and preserves fixed terms and closed receipts", async () => {
      const context = await actor(),
        debateId = await debate();
      await sandbox.initialize(context);
      await seed(context, "center", "1000000");
      await seed(context, "promotional", "1000000");
      const round = await a4.create(context, debateId, randomUUID());
      await assert.rejects(
        owner.query("UPDATE coin_debate_rounds SET seed=$2 WHERE id=$1", [
          round.id,
          "a".repeat(64),
        ]),
        /immutable sandbox debate/,
      );
      await close(round.id);
      const before = await sandbox.summary(context);
      await assert.rejects(
        a4.submit(context, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 1,
        }),
        /past cutoff/,
      );
      assert.deepEqual((await sandbox.summary(context)).book, before.book);
      await a4.advance();
      await assert.rejects(
        a4.submit(context, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 1,
        }),
        /closed/,
      );
      const second = await a4.create(context, debateId, randomUUID());
      await createSessionRepository(runtime).deleteByTokenHash(
        context.sessionTokenHash,
      );
      await assert.rejects(
        a4.submit(context, second.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 1,
        }),
        /session|account/,
      );
      await reconcile();
    });
    // F11: the debate's ending, as the media clock records it.
    async function end(debateId, endedAgo) {
      await owner.query(
        `UPDATE debates SET status='ended',
          live_started_at=clock_timestamp()-$2::interval-INTERVAL '1 hour',
          live_ended_at=clock_timestamp()-$2::interval WHERE id=$1`,
        [debateId, endedAgo],
      );
    }
    it("locks five-day rounds at the cutoff and settles them only at the 120-hour close", async () => {
      const one = await actor(),
        two = await actor(),
        debateId = await debate({ reveal: "five_day" });
      for (const context of [one, two]) {
        await sandbox.initialize(context);
        await seed(context, "center", "1000000");
        await seed(context, "promotional", "1000000");
      }
      const round = await a4.create(one, debateId, randomUUID());
      const stored = (
        await owner.query(
          "SELECT reveal_mode FROM coin_debate_rounds WHERE id=$1",
          [round.id],
        )
      ).rows[0];
      assert.equal(stored.reveal_mode, "five_day", "the default mode");
      await a4.submit(one, round.id, randomUUID(), {
        side: "YES",
        limit: "0.6",
        quantity: 10,
      });
      await a4.submit(two, round.id, randomUUID(), {
        side: "NO",
        limit: "0.6",
        quantity: 10,
      });
      let [view] = await a4.view(one, debateId);
      assert.equal(view.revealMode, "five_day");
      assert.equal(view.revealAt, null, "unknown until the debate ends");
      assert.equal(view.participants, 2, "a count, never side totals");
      assert.deepEqual(view.eligibility, {
        canTakePosition: false,
        reason: "committed",
      });
      await close(round.id);
      await a4.advance();
      assert.equal(
        (
          await owner.query(
            "SELECT state FROM coin_debate_rounds WHERE id=$1",
            [round.id],
          )
        ).rows[0].state,
        "open",
        "locked, not settled",
      );
      const late = await actor();
      await sandbox.initialize(late);
      await assert.rejects(
        a4.submit(late, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 1,
        }),
        /past cutoff/,
      );
      [view] = await a4.view(late, debateId);
      assert.equal(view.eligibility.reason, "closed");
      assert.equal(view.pricing, undefined, "no price before the reveal");
      // The locked round no longer holds back a new manual round.
      const next = await a4.create(one, debateId, randomUUID());
      assert.notEqual(next.id, round.id);
      assert.equal(
        (await a4.create(two, debateId, randomUUID())).id,
        next.id,
        "only one manual round takes orders",
      );
      const forge = () =>
        runtime.query(
          `UPDATE coin_debate_rounds SET state='settled',revealed_at=clock_timestamp(),
            result='{"snapshot":[]}'::jsonb WHERE id=$1`,
          [round.id],
        );
      await assert.rejects(forge(), /unauthorized outcome/);
      // Ended an hour ago: the close is 119 hours away.
      await end(debateId, "1 hour");
      await a4.advance();
      [view] = (await a4.view(one, debateId)).filter((r) => r.id === round.id);
      assert.equal(view.state, "open");
      assert.ok(
        Math.abs(
          new Date(view.revealAt).getTime() - (Date.now() + 119 * 3600_000),
        ) < 120_000,
      );
      await assert.rejects(forge(), /unauthorized outcome/);
      await end(debateId, "121 hours");
      await a4.advance();
      [view] = (await a4.view(one, debateId)).filter((r) => r.id === round.id);
      assert.equal(view.state, "settled");
      assert.ok(view.pricing, "the drawn price appears at the reveal");
      assert.ok(view.seed);
      assert.ok(new Date(view.revealAt) <= new Date());
      await reconcile();
    });
    it("records per-round reveal only by the owner and only before a debate's first round", async () => {
      const ownerSandbox = createCoinDebateSandbox(owner, "simulation");
      const debateId = await debate({ reveal: "five_day" });
      await assert.rejects(
        runtime.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,'per_round','Runtime attempt')",
          [debateId],
        ),
        /permission denied/,
      );
      await assert.rejects(
        a4.setRevealMode(debateId, "per_round", "Runtime attempt"),
        /operator ownership/,
      );
      await assert.rejects(
        ownerSandbox.setRevealMode(debateId, "weekly", "Unknown mode"),
        /invalid reveal mode/,
      );
      await assert.rejects(
        ownerSandbox.setRevealMode(debateId, "per_round", " x "),
        /5-500 characters/,
      );
      await assert.rejects(
        ownerSandbox.setRevealMode(randomUUID(), "per_round", "Missing debate"),
        /not found/,
      );
      assert.deepEqual(
        await ownerSandbox.setRevealMode(
          debateId,
          "per_round",
          "Founder-created launch debate",
        ),
        { created: true },
      );
      assert.deepEqual(
        await ownerSandbox.setRevealMode(debateId, "per_round", "Repeated"),
        { created: false },
      );
      await assert.rejects(
        ownerSandbox.setRevealMode(debateId, "five_day", "Changed my mind"),
        /already recorded/,
      );
      await assert.rejects(
        owner.query(
          "UPDATE coin_debate_reveal_modes SET mode='five_day' WHERE debate_id=$1",
          [debateId],
        ),
      );
      const context = await actor();
      await sandbox.initialize(context);
      const round = await a4.create(context, debateId, randomUUID());
      assert.equal(
        (
          await owner.query(
            "SELECT reveal_mode FROM coin_debate_rounds WHERE id=$1",
            [round.id],
          )
        ).rows[0].reveal_mode,
        "per_round",
      );
      // The owner command records it for another debate.
      const commanded = await debate({ reveal: "five_day" });
      const command = (body) =>
        runCoinSandboxOperator({
          command: "set-reveal-mode",
          body,
          environment: {
            COIN_SANDBOX_OWNER_DATABASE_URL: ownerUrl,
            COIN_SANDBOX_RAIL: "simulation",
          },
        });
      const reason = "Founder-created launch debate";
      assert.equal(
        (await command({ debateId: commanded, mode: "per_round", reason }))
          .status,
        "recorded",
      );
      assert.equal(
        (await command({ debateId: commanded, mode: "per_round", reason }))
          .status,
        "unchanged",
      );
      await assert.rejects(
        command({ debateId: commanded, mode: "weekly", reason }),
        /per_round or five_day/,
      );
      // The first round locks the mode, in the command and in the database.
      const locked = await debate({ reveal: "five_day" });
      await a4.create(context, locked, randomUUID());
      await assert.rejects(
        ownerSandbox.setRevealMode(locked, "per_round", "Too late now"),
        /locked once a round opens/,
      );
      await assert.rejects(
        owner.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,'per_round','Too late now')",
          [locked],
        ),
        /locked once a round opens/,
      );
      // Inserting code cannot choose a round's mode.
      const forged = randomUUID();
      await runtime.query(
        `INSERT INTO coin_debate_rounds(id,debate_id,creator_id,proposition,rail,reference,terms,
          seed,seed_commitment,closes_at,reveal_mode)
        SELECT $1,$2,$3,'Forged',rail,$4,terms,seed,seed_commitment,
          clock_timestamp()+INTERVAL '1 minute','per_round'
        FROM coin_debate_rounds WHERE id=$5`,
        [
          forged,
          await debate({ reveal: "five_day" }),
          context.userId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          round.id,
        ],
      );
      assert.equal(
        (
          await owner.query(
            "SELECT reveal_mode FROM coin_debate_rounds WHERE id=$1",
            [forged],
          )
        ).rows[0].reveal_mode,
        "five_day",
      );
    });
    it("refuses a debater's position in their own debate (F14) and says why", async () => {
      const debater = await actor(),
        viewer = await actor();
      const profile = (
        await owner.query(
          "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,$2,'Debater','published') RETURNING id",
          [debater.userId, `debater-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id;
      const debateId = await debate({ speaker: profile });
      for (const context of [debater, viewer]) {
        await sandbox.initialize(context);
        await seed(context, "center", "1000000");
        await seed(context, "promotional", "1000000");
      }
      const round = await a4.create(viewer, debateId, randomUUID());
      const before = await sandbox.summary(debater);
      await assert.rejects(
        a4.submit(debater, round.id, randomUUID(), {
          side: "YES",
          limit: "1",
          quantity: 1,
        }),
        (error) =>
          error.status === 403 && /cannot take a position/.test(error.message),
      );
      assert.deepEqual((await sandbox.summary(debater)).book, before.book);
      const [own] = await a4.view(debater, debateId);
      assert.deepEqual(own.eligibility, {
        canTakePosition: false,
        reason: "debater",
      });
      let [other] = await a4.view(viewer, debateId);
      assert.deepEqual(other.eligibility, {
        canTakePosition: true,
        reason: null,
      });
      assert.equal(other.participants, 0);
      // The database refuses it too, before any other check.
      await assert.rejects(
        runtime.query(
          `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,
            funding,center_reservation,promotional_reservation)
          VALUES($1,$2,$3,'YES','1',1,'{}'::jsonb,1,0)`,
          [round.id, debater.userId, randomUUID()],
        ),
        /cannot take a position in their own debate/,
      );
      await a4.submit(viewer, round.id, randomUUID(), {
        side: "YES",
        limit: "1",
        quantity: 1,
      });
      [other] = await a4.view(viewer, debateId);
      assert.equal(other.participants, 1);
      assert.equal(other.eligibility.reason, "committed");
      await owner.query("UPDATE debates SET status='cancelled' WHERE id=$1", [
        debateId,
      ]);
      const third = await actor();
      const [unavailable] = await a4.view(third, debateId);
      assert.equal(unavailable.eligibility.reason, "debate_unavailable");
      await a4.voidUnavailable(20, [debateId]);
      await reconcile();
    });
  },
);
