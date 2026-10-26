import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createSandboxErrorReports,
  createSandboxErrorReportOperator,
} from "../dist/features/account-wallet/sandbox-reports.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
  appendSandboxBookEvent,
  ensureSandboxBuckets,
  lockSandboxBook,
  withdrawalApprovalTerms,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
import {
  attachSubject,
  confirmedApproval,
  openSandbox,
} from "./helpers/confirmations.js";
import { postCoinJournal } from "../dist/features/account-wallet/ledger.js";
import { lockLedger } from "../dist/features/account-wallet/debate-sandbox.js";
import { runCoinSandboxOperator } from "../scripts/coin-sandbox-operator.ts";
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
describe(
  "owned error reports and funded original-source corrections in disposable PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner,
      a,
      b,
      reports,
      other,
      reviews,
      otherReviews,
      sandbox,
      operator,
      operations;
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
      a = new pg.Pool({ ...options, connectionString: runtimeUrl });
      b = new pg.Pool({ ...options, connectionString: runtimeUrl });
      reports = createSandboxErrorReports(a, "simulation");
      other = createSandboxErrorReports(b, "simulation");
      reviews = createSandboxErrorReportOperator(owner, "simulation");
      otherReviews = createSandboxErrorReportOperator(owner, "simulation");
      sandbox = createCoinSandboxRepository(a, { rail: "simulation" });
      operator = createCoinSandboxOperatorRepository(owner, {
        rail: "simulation",
      });
      operations = createAccountOperationRepository(a);
    });
    after(async () => {
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });
    // An Auth0 account whose subject confirms operations. Unless told
    // otherwise it already has the automatic opening (Decision 0013).
    async function actor({ opened = true } = {}) {
      const user = (
          await owner.query(
            "INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation",
          )
        ).rows[0],
        token = createSessionToken(),
        session = await createSessionRepository(a).create(
          user.id,
          token.tokenHash,
          new Date(Date.now() + 600000),
          { authGeneration: user.auth_generation },
        );
      const subject = await attachSubject(owner, user.id);
      if (opened) await openSandbox(owner, user.id);
      return {
        userId: user.id,
        sessionTokenHash: token.tokenHash,
        expectedSessionId: session.id,
        subject,
      };
    }
    async function fund(context, amount = "10000000") {
      const quote = await sandbox.quoteFunding(context, {
        amount,
        idempotencyKey: randomUUID(),
      });
      await sandbox.confirmSimulatedFunding(context, { requestId: quote.id });
      return quote;
    }
    async function report(context, requestId) {
      return (
        await reports.submit(context, {
          requestId,
          message: "Synthetic deposit/payout error for isolated acceptance",
          idempotencyKey: randomUUID(),
        })
      ).report;
    }
    async function review(reportId, outcome = "recovery_quote", extra = {}) {
      return (
        await reviews.review({
          reportId,
          outcome,
          idempotencyKey: randomUUID(),
          note: "Private synthetic evidence analysis",
          publicNote: "We reviewed your report.",
          evidenceDigest: digest(randomUUID()),
          ...(outcome === "recovery_quote"
            ? {
                quote: {
                  amount: "100000",
                  network: "simulation:usdc",
                  expiresAt: new Date(Date.now() + 120000).toISOString(),
                  description:
                    "Explicit simulated recovery cost; no charge authorized",
                },
              }
            : {}),
          ...extra,
        })
      ).event;
    }
    async function proof(context, purpose, terms) {
      const { id, approval } = await confirmedApproval(
        a,
        {
          userId: context.userId,
          sessionTokenHash: context.sessionTokenHash,
          subject: context.subject,
          purpose,
          terms,
        },
        operations,
      );
      return { operation: { id }, approval };
    }
    async function reserve(context, gross = "5000000") {
      const quote = await sandbox.quoteWithdrawal(context, {
          gross,
          destination: "synthetic-external-wallet",
          idempotencyKey: randomUUID(),
        }),
        authorized = await proof(
          context,
          "withdrawal.request",
          withdrawalApprovalTerms(quote),
        );
      await sandbox.requestWithdrawal(context, {
        requestId: quote.id,
        approval: authorized.approval,
      });
      return quote;
    }
    async function incorrectDebit(context, requestId, amount) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          context.userId,
        ]);
        const snapshot = await lockSandboxBook(client, context.userId),
          buckets = await ensureSandboxBuckets(client, context.userId),
          journal = await postCoinJournal(client, {
            id: randomUUID(),
            environment: "sandbox",
            asset: "USDC",
            operation: "payout",
            reference: randomUUID(),
            postings: [
              {
                accountId: buckets.cashAvailable,
                amount: String(-BigInt(amount)),
              },
              { accountId: buckets.system.fees, amount },
            ],
          }),
          book = {
            ...snapshot.book,
            purchased: snapshot.book.purchased.map((s) =>
              s.id === requestId
                ? { ...s, balance: String(BigInt(s.balance) - BigInt(amount)) }
                : s,
            ),
          };
        await appendSandboxBookEvent(client, {
          userId: context.userId,
          snapshot,
          book,
          kind: "fixture.operator-incorrect-debit",
          reference: digest(randomUUID()),
          termsDigest: digest([requestId, amount]),
          requestId,
          cashJournalId: journal.id,
          metadata: { notRealMoney: true, fixture: true },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    async function counts(context) {
      return (
        await owner.query(
          `SELECT
    (SELECT count(*)::int FROM coin_sandbox_events WHERE user_id=$1) AS books,
    (SELECT count(DISTINCT p.journal_id)::int FROM coin_postings p JOIN coin_accounts a ON a.id=p.account_id WHERE a.user_id=$1) AS journals,
    (SELECT count(*)::int FROM coin_sandbox_report_events WHERE user_id=$1) AS reports`,
          [context.userId],
        )
      ).rows[0];
    }
    it("accepts completed request reports without a time cutoff, scopes races/idempotency and never holds or debits on submission", async () => {
      const context = await actor(),
        stranger = await actor(),
        funding = await fund(context),
        before = await sandbox.summary(context),
        key = randomUUID(),
        input = {
          requestId: funding.id,
          message: "Delayed discovery of a past deposit error",
          idempotencyKey: key,
        };
      const results = await Promise.all([
        reports.submit(context, input),
        other.submit(context, input),
      ]);
      assert.equal(results.filter((r) => r.created).length, 1);
      assert.equal(new Set(results.map((r) => r.report.id)).size, 1);
      const id = results[0].report.id;
      await assert.rejects(
        reports.submit(context, { ...input, message: "different description" }),
        /idempotency/,
      );
      await assert.rejects(reports.submit(stranger, input), /unavailable/);
      await assert.rejects(reports.get(stranger, id), /unavailable/);
      await assert.rejects(
        reports.submit(context, {
          ...input,
          idempotencyKey: randomUUID(),
          message: "x".repeat(2001),
        }),
        /length/,
      );
      assert.deepEqual((await sandbox.summary(context)).book, before.book);
      assert.deepEqual(
        (await sandbox.summary(context)).balances,
        before.balances,
      );
      assert.equal((await reports.list(context)).length, 1);
      assert.equal((await reports.get(context, id)).description, input.message);
    });
    it("separates owner evidence from public outcomes and makes report/review history immutable", async () => {
      const context = await actor(),
        funding = await fund(context),
        r = await report(context, funding.id),
        privateNote =
          "PRIVATE acceptance evidence must never enter the customer projection",
        evidence = digest(privateNote),
        input = {
          reportId: r.id,
          outcome: "no_error",
          note: privateNote,
          publicNote: "Ordinary trading losses remain final.",
          evidenceDigest: evidence,
          idempotencyKey: randomUUID(),
        };
      await assert.rejects(
        createSandboxErrorReportOperator(a, "simulation").review(input),
        /owner process/,
      );
      const saved = await reviews.review(input);
      assert.equal((await reviews.review(input)).created, false);
      await assert.rejects(
        reviews.review({ ...input, note: "different private finding" }),
        /idempotency/,
      );
      const visible = await reports.get(context, r.id),
        serialized = JSON.stringify(visible);
      assert.ok(!serialized.includes(privateNote));
      assert.ok(!serialized.includes(evidence));
      assert.ok(!serialized.includes("termsDigest"));
      assert.equal(visible.events[0].publicNote, input.publicNote);
      for (const sql of [
        "UPDATE coin_sandbox_reports SET message='changed' WHERE id=$1",
        "DELETE FROM coin_sandbox_reports WHERE id=$1",
      ])
        await assert.rejects(owner.query(sql, [r.id]), /append-only/);
      await assert.rejects(
        owner.query("DELETE FROM coin_sandbox_report_events WHERE id=$1", [
          saved.event.id,
        ]),
        /append-only/,
      );
    });
    it("orders reviews numerically across a sequence digit boundary and refuses an older superseded quote", async () => {
      const context = await actor(),
        funding = await fund(context),
        r = await report(context, funding.id);
      for (let index = 0; index < 12; index++)
        await review(r.id, "evidence_required");

      const writer = await owner.connect(),
        oldQuoteId = randomUUID(),
        supersedingId = randomUUID(),
        quote = {
          amount: "100000",
          network: "simulation:usdc",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          description: "Synthetic quote before numeric sequence boundary",
        };
      let boundary;
      try {
        await writer.query("BEGIN");
        // This disposable fixture only moves the identity forward. The table
        // fence prevents other suites from interleaving these two inserts; it
        // neither rewinds a counter nor relies on global test execution order.
        await writer.query(
          "LOCK TABLE coin_sandbox_report_events IN SHARE ROW EXCLUSIVE MODE",
        );
        const last = BigInt(
          (
            await writer.query(
              "SELECT last_value::text AS value FROM coin_sandbox_report_events_sequence_seq",
            )
          ).rows[0].value,
        );
        boundary = 100n;
        while (boundary <= last + 2n) boundary *= 10n;
        assert.ok(boundary < 9223372036854775807n);
        await writer.query(
          "SELECT setval('coin_sandbox_report_events_sequence_seq',$1::bigint,true)",
          [String(boundary - 2n)],
        );
        for (const [id, outcome, extra] of [
          [oldQuoteId, "recovery_quote", { quote }],
          [supersedingId, "no_error", {}],
        ]) {
          const terms = {
            outcome,
            note: "Private synthetic sequence-order evidence",
            evidenceDigest: digest(id),
            publicNote: "Synthetic review recorded.",
            ...extra,
          };
          await writer.query(
            "INSERT INTO coin_sandbox_report_events(id,report_id,user_id,kind,reference,terms_digest,terms) VALUES($1,$2,$3,'review',$4,$5,$6)",
            [
              id,
              r.id,
              context.userId,
              digest(randomUUID()),
              digest(terms),
              terms,
            ],
          );
        }
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }

      const visible = await reports.get(context, r.id),
        stored = (
          await owner.query(
            "SELECT id,sequence::text AS value FROM coin_sandbox_report_events WHERE id=ANY($1::uuid[]) ORDER BY coin_sandbox_report_events.sequence",
            [[oldQuoteId, supersedingId]],
          )
        ).rows;
      assert.equal(visible.events.length, 14);
      assert.deepEqual(
        stored.map((event) => event.value),
        [String(boundary - 1n), String(boundary)],
      );
      assert.deepEqual(
        visible.events.slice(-2).map((event) => event.id),
        [oldQuoteId, supersedingId],
      );
      await assert.rejects(
        reports.getConsentTerms(context, {
          reportId: r.id,
          quoteId: oldQuoteId,
        }),
        /superseded/,
      );

      const current = await review(r.id),
        currentTerms = await reports.getConsentTerms(context, {
          reportId: r.id,
          quoteId: current.id,
        });
      assert.equal(currentTerms.terms.quoteId, current.id);
      assert.equal(
        (await reports.get(context, r.id)).events.at(-1).id,
        current.id,
      );
      const authorized = await proof(
        context,
        "recovery.cost.consent",
        currentTerms.terms,
      );
      assert.equal(
        (
          await reports.consent(context, {
            reportId: r.id,
            quoteId: current.id,
            idempotencyKey: randomUUID(),
            approval: authorized.approval,
          })
        ).created,
        true,
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT terms->>'quoteId' AS quote FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent'",
            [r.id],
          )
        ).rows,
        [{ quote: current.id }],
      );
    });
    it("consumes exact retained authorization for consent once, without charging, recovery execution or owner-note disclosure", async () => {
      // Opened automatically by its first request (the funding below); the
      // recovery consent still needs a fresh sign-in (Decision 0013).
      const context = await actor({ opened: false }),
        stranger = await actor(),
        funding = await fund(context),
        r = await report(context, funding.id),
        q = await review(r.id),
        current = await reports.getConsentTerms(context, {
          reportId: r.id,
          quoteId: q.id,
        }),
        before = await sandbox.summary(context),
        financial = await counts(context);
      assert.equal(current.terms.authorization, "consent_only_no_charge");
      assert.equal((await reports.get(context, r.id)).events[0].quoteId, q.id);
      await assert.rejects(
        reports.getConsentTerms(stranger, { reportId: r.id, quoteId: q.id }),
        /unavailable/,
      );
      // Without a fresh sign-in the operation cannot be prepared for consent.
      const exact = {
          userId: context.userId,
          sessionTokenHash: context.sessionTokenHash,
          purpose: "recovery.cost.consent",
          terms: current.terms,
        },
        unconfirmed = await operations.create(exact);
      await assert.rejects(
        operations.prepare({ ...exact, id: unconfirmed.id }),
        /confirmation expired or invalid/,
      );
      // Another account's confirmation of the same terms belongs to its session.
      const foreign = await proof(
        stranger,
        "recovery.cost.consent",
        current.terms,
      );
      await assert.rejects(
        reports.consent(context, {
          reportId: r.id,
          quoteId: q.id,
          idempotencyKey: randomUUID(),
          approval: foreign.approval,
        }),
        /confirmation belongs to another session/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT consumed_at FROM account_operations WHERE id=$1",
            [foreign.operation.id],
          )
        ).rows[0].consumed_at,
        null,
      );
      const wrong = await proof(context, "recovery.cost.consent", {
        ...current.terms,
        amount: "100001",
      });
      await assert.rejects(
        reports.consent(context, {
          reportId: r.id,
          quoteId: q.id,
          idempotencyKey: randomUUID(),
          approval: wrong.approval,
        }),
        /exact recovery consent/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT consumed_at FROM account_operations WHERE id=$1",
            [wrong.operation.id],
          )
        ).rows[0].consumed_at,
        null,
      );
      const authorized = await proof(
          context,
          "recovery.cost.consent",
          current.terms,
        ),
        key = randomUUID(),
        accepted = await reports.consent(context, {
          reportId: r.id,
          quoteId: q.id,
          idempotencyKey: key,
          approval: authorized.approval,
        });
      assert.equal(accepted.created, true);
      assert.equal(accepted.authorizesCharge, false);
      assert.equal(accepted.authorizesExternalRecovery, false);
      await assert.rejects(
        reports.consent(context, {
          reportId: r.id,
          quoteId: q.id,
          idempotencyKey: key,
          approval: authorized.approval,
        }),
        /confirmation expired or invalid/,
      );
      const again = await proof(
        context,
        "recovery.cost.consent",
        current.terms,
      );
      assert.equal(
        (
          await reports.consent(context, {
            reportId: r.id,
            quoteId: q.id,
            idempotencyKey: randomUUID(),
            approval: again.approval,
          })
        ).created,
        false,
      );
      assert.equal(
        (await reports.get(context, r.id)).events.filter(
          (e) => e.kind === "recovery_consent",
        ).length,
        1,
      );
      assert.deepEqual((await sandbox.summary(context)).book, before.book);
      assert.deepEqual(
        (await sandbox.summary(context)).balances,
        before.balances,
      );
      const after = await counts(context);
      assert.equal(after.journals, financial.journals);
      assert.equal(after.books, financial.books);
    });
    it("rejects expired or superseded cost quotes and revoked sessions without consuming authorization", async () => {
      for (const failure of ["expired", "superseded", "revoked"]) {
        const context = await actor(),
          funding = await fund(context),
          r = await report(context, funding.id),
          q = await review(
            r.id,
            "recovery_quote",
            failure === "expired"
              ? {
                  quote: {
                    amount: "100000",
                    network: "simulation:usdc",
                    expiresAt: new Date(Date.now() + 1500).toISOString(),
                    description: "Short-lived exact quote",
                  },
                }
              : {},
          ),
          terms = (
            await reports.getConsentTerms(context, {
              reportId: r.id,
              quoteId: q.id,
            })
          ).terms,
          authorized = await proof(context, "recovery.cost.consent", terms);
        if (failure === "expired") await owner.query("SELECT pg_sleep(1.55)");
        else if (failure === "superseded") await review(r.id, "no_error");
        else await endAllAccountSessions(b, context.userId);
        await assert.rejects(
          reports.consent(context, {
            reportId: r.id,
            quoteId: q.id,
            idempotencyKey: randomUUID(),
            approval: authorized.approval,
          }),
          /expired|superseded|session/,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT consumed_at FROM account_operations WHERE id=$1",
              [authorized.operation.id],
            )
          ).rows[0].consumed_at,
          null,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent'",
              [r.id],
            )
          ).rows[0].n,
          0,
        );
      }
    });
    it("restores only evidence-reviewed missing principal from a finite operator reserve exactly once across instances", async () => {
      const context = await actor(),
        funding = await fund(context, "5000000");
      await incorrectDebit(context, funding.id, "3000000");
      const r = await report(context, funding.id),
        decision = await review(r.id, "operator_shortfall", {
          amount: "3000000",
        }),
        before = await sandbox.summary(context),
        input = {
          reportId: r.id,
          reviewId: decision.id,
          amount: "3000000",
          idempotencyKey: randomUUID(),
        };
      // Roll back a temporary depletion fixture so unrelated suites never observe
      // changed treasury balances; a real owner journal still tests insolvency.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          context.userId,
        ]);
        const buckets = await ensureSandboxBuckets(client, context.userId);
        // Lock in the repository's global order before the treasury rows, as
        // the coin debate suite's empty-treasury fixture does.
        await lockLedger(client, [buckets]);
        const locked = await client.query(
            "SELECT id FROM coin_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [
              [
                buckets.system.correction_available,
                buckets.system.center_available,
              ],
            ],
          ),
          cash = (
            await client.query(
              "SELECT balance::text FROM coin_accounts WHERE id=$1 FOR UPDATE",
              [buckets.system.correction_available],
            )
          ).rows[0].balance;
        assert.equal(locked.rowCount, 2);
        if (cash !== "0")
          await postCoinJournal(client, {
            id: randomUUID(),
            environment: "sandbox",
            asset: "USDC",
            operation: "reserve",
            reference: randomUUID(),
            postings: [
              {
                accountId: buckets.system.correction_available,
                amount: String(-BigInt(cash)),
              },
              { accountId: buckets.system.center_available, amount: cash },
            ],
          });
        const nested = {
          async connect() {
            return {
              query(sql, values) {
                if (sql === "BEGIN")
                  return client.query("SAVEPOINT report_insolvency");
                if (sql === "COMMIT")
                  return client.query("RELEASE SAVEPOINT report_insolvency");
                if (sql === "ROLLBACK")
                  return client.query(
                    "ROLLBACK TO SAVEPOINT report_insolvency",
                  );
                return client.query(sql, values);
              },
              release() {},
            };
          },
          query: (sql, values) => client.query(sql, values),
        };
        await assert.rejects(
          createSandboxErrorReportOperator(nested, "simulation").compensate(
            input,
          ),
          /insufficient funds/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      assert.deepEqual((await sandbox.summary(context)).book, before.book);
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose: "correction",
        amount: "3000000",
        idempotencyKey: randomUUID(),
      });
      const results = await Promise.all([
        reviews.compensate(input),
        otherReviews.compensate(input),
      ]);
      assert.equal(results.filter((result) => result.created).length, 1);
      const after = await sandbox.summary(context);
      assert.equal(after.book.purchased.length, 1);
      assert.equal(after.book.purchased[0].id, funding.id);
      assert.equal(after.book.purchased[0].kind, "purchased_principal");
      assert.equal(after.book.purchased[0].balance, "5000000");
      assert.equal(after.book.grants.length, 0);
      await assert.rejects(
        reviews.compensate({
          ...input,
          idempotencyKey: randomUUID(),
          amount: "1",
        }),
        /evidence-reviewed amount|missing original/,
      );
      const another = await report(context, funding.id),
        review2 = await review(another.id, "operator_cost", { amount: "1" });
      await assert.rejects(
        reviews.compensate({
          reportId: another.id,
          reviewId: review2.id,
          amount: "1",
          idempotencyKey: randomUUID(),
        }),
        /missing original/,
      );
    });
    it("partially restores completed payout sources across all reports without converting grant principal or changing qualification", async () => {
      const context = await actor();
      await fund(context, "5000000");
      await sandbox.initialize(context);
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose: "promotional",
        amount: "25000000",
        idempotencyKey: randomUUID(),
      });
      const fixture = await owner.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          context.userId,
        ]);
        const snapshot = await lockSandboxBook(fixture, context.userId),
          buckets = await ensureSandboxBuckets(fixture, context.userId),
          grant = snapshot.book.grants[0],
          journal = await postCoinJournal(fixture, {
            id: randomUUID(),
            environment: "sandbox",
            asset: "USDC",
            operation: "payout",
            reference: randomUUID(),
            postings: [
              {
                accountId: buckets.system.promotional_available,
                amount: "-25000000",
              },
              { accountId: buckets.cashAvailable, amount: "25000000" },
            ],
          });
        // Explicit fully backed simulation fixture; not a hosted earned grant.
        await fixture.query(
          "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'sandbox','USDC','25000000')",
          [grant.id, journal.id],
        );
        await appendSandboxBookEvent(fixture, {
          userId: context.userId,
          snapshot,
          book: {
            ...snapshot.book,
            grants: snapshot.book.grants.map((g) => ({
              ...g,
              profitRemaining: "25000000",
              netProfit: "25000000",
              peakNetProfit: "25000000",
            })),
          },
          kind: "fixture.backed-qualified-profit",
          reference: digest(randomUUID()),
          termsDigest: digest("fixture"),
          cashJournalId: journal.id,
        });
        await fixture.query("COMMIT");
      } catch (error) {
        await fixture.query("ROLLBACK");
        throw error;
      } finally {
        fixture.release();
      }
      const original = (await sandbox.summary(context)).book,
        withdrawal = await reserve(context, "6000000");
      await operator.review({
        userId: context.userId,
        requestId: withdrawal.id,
        decision: "approve",
        idempotencyKey: randomUUID(),
      });
      const transactionId = `synthetic-erroneous-payout-${randomUUID()}`;
      await operator.observe({
        userId: context.userId,
        requestId: withdrawal.id,
        event: {
          id: randomUUID(),
          externalId: withdrawal.id,
          termsDigest: withdrawal.termsDigest,
          source: "reconciliation",
          status: "completed",
          transactionId,
          finalNoTransfer: false,
        },
        receipt: {
          network: "simulation:usdc",
          transactionId,
          locator: "transfer:0",
          amount: "5900000",
          evidenceDigest: digest(transactionId),
        },
      });
      const r = await report(context, withdrawal.id),
        decision = await review(r.id, "operator_shortfall", {
          amount: "6000000",
        });
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose: "correction",
        amount: "6000000",
        idempotencyKey: randomUUID(),
      });
      await reviews.compensate({
        reportId: r.id,
        reviewId: decision.id,
        amount: "1500000",
        idempotencyKey: randomUUID(),
      });
      let current = (await sandbox.summary(context)).book;
      assert.equal(current.purchased[0].balance, "1250000");
      assert.equal(current.grants[0].profitRemaining, "24250000");
      assert.equal(
        current.grants[0].principalRemaining,
        original.grants[0].principalRemaining,
      );
      assert.equal(current.grants[0].netProfit, "25000000");
      assert.equal(current.grants[0].peakNetProfit, "25000000");
      await reviews.compensate({
        reportId: r.id,
        reviewId: decision.id,
        amount: "4500000",
        idempotencyKey: randomUUID(),
      });
      current = (await sandbox.summary(context)).book;
      assert.deepEqual(current, original);
      const duplicateReport = await report(context, withdrawal.id),
        duplicateReview = await review(duplicateReport.id, "operator_cost", {
          amount: "1",
        });
      await assert.rejects(
        reviews.compensate({
          reportId: duplicateReport.id,
          reviewId: duplicateReview.id,
          amount: "1",
          idempotencyKey: randomUUID(),
        }),
        /original debit/,
      );
    });
    it("blocks restoration while original principal remains reserved and requires reviewed evidence in configured correction commands", async () => {
      const context = await actor(),
        funding = await fund(context, "5000000"),
        pending = await reserve(context),
        r = await report(context, funding.id),
        decision = await review(r.id, "operator_shortfall", {
          amount: "1000000",
        });
      await assert.rejects(
        reviews.compensate({
          reportId: r.id,
          reviewId: decision.id,
          amount: "1000000",
          idempotencyKey: randomUUID(),
        }),
        /outstanding original purchase reservations/,
      );
      const environment = {
        COIN_SANDBOX_OWNER_DATABASE_URL: ownerUrl,
        COIN_SANDBOX_RAIL: "simulation",
      };
      await assert.rejects(
        runCoinSandboxOperator({
          command: "correct",
          body: {
            requestId: funding.id,
            reason: "incorrect_funding",
            idempotencyKey: randomUUID(),
          },
          environment,
        }),
        /UUID|resource|identifier|required|invalid/,
      );
      await operator.review({
        userId: context.userId,
        requestId: pending.id,
        decision: "reject",
        idempotencyKey: randomUUID(),
      });
      const evidence = await review(r.id, "erroneous_credit"),
        anotherFunding = await fund(context, "1000000"),
        authorization = await reviews.prepareCorrection({
          reportId: r.id,
          reviewId: evidence.id,
          requestId: funding.id,
          action: "correct",
          idempotencyKey: randomUUID(),
        });
      await assert.rejects(
        operator.correctFunding({
          userId: context.userId,
          requestId: anotherFunding.id,
          reason: "incorrect_funding",
          idempotencyKey: randomUUID(),
          review: authorization,
        }),
        /does not authorize/,
      );
      const key = randomUUID();
      await runCoinSandboxOperator({
        command: "correct",
        body: {
          requestId: funding.id,
          reason: "incorrect_funding",
          idempotencyKey: key,
          reportId: r.id,
          reviewId: evidence.id,
        },
        environment,
      });
      const corrected = (
        await owner.query(
          "SELECT terms FROM coin_sandbox_requests WHERE user_id=$1 AND kind='correction' ORDER BY created_at DESC LIMIT 1",
          [context.userId],
        )
      ).rows[0];
      assert.equal(corrected.terms.reviewId, evidence.id);
      assert.equal(
        (await reports.get(context, r.id)).events.some(
          (e) => e.kind === "correction_authorized",
        ),
        false,
      );
    });
  },
);
