import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import express from "express";
import cookieParser from "cookie-parser";
import request from "../scripts/test-http-request.ts";
import {
  accountOperationTermsDigest,
  createAccountOperationRepository,
} from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createRequireAuthentication } from "../dist/platform/auth/router.js";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { createSandboxWebhookRouter } from "../dist/features/account-wallet/sandbox-webhooks.js";
import {
  createSandboxErrorReports,
  createSandboxErrorReportOperator,
} from "../dist/features/account-wallet/sandbox-reports.js";
import {
  parseCoinSandboxOwnerDatabaseUrl,
  runCoinSandboxOperator,
} from "../scripts/coin-sandbox-operator.ts";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
  withdrawalApprovalTerms,
  appendSandboxBookEvent,
  ensureSandboxBuckets,
  lockSandboxBook,
  assertSandboxNewPayoutAuthorization,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { postCoinJournal } from "../dist/features/account-wallet/ledger.js";
import {
  attachSubject,
  confirmedApproval,
  openSandbox,
} from "./helpers/confirmations.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const origin = "http://localhost:53024";
const unopened = /this account has not used its coin sandbox/;
const expiredConfirmation = /confirmation expired or invalid/;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const config = { rail: "simulation", withdrawalFee: "100000" };
it("accepts only the dedicated owner or a documented Supabase pooler-scoped owner URL without connecting", async () => {
  const project = "abcdefghijklmnopqrst";
  for (const value of [
    "postgres://yaparena_owner:synthetic@localhost:5432/revocation_test_ci",
    "postgresql://yaparena_owner:synthetic@db.example.supabase.co:5432/postgres",
    `postgresql://yaparena_owner.${project}:synthetic@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
    `postgres://yaparena_owner%2E${project}:synthetic@aws-1-us-east-2.pooler.supabase.com:6543/postgres`,
  ]) {
    const parsed = parseCoinSandboxOwnerDatabaseUrl(value);
    assert.equal(parsed.href, new URL(value).href);
  }
  for (const value of [
    `postgres://yaparena_runtime.${project}:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres`,
    `postgres://postgres.${project}:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres`,
    "postgres://yaparena_runtime:synthetic@localhost/revocation_test_ci",
    "postgres://postgres:synthetic@localhost/revocation_test_ci",
    `postgres://yaparena_owner.${project}:synthetic@localhost/postgres`,
    `postgres://yaparena_owner.${project}:synthetic@db.${project}.supabase.co/postgres`,
    `postgres://yaparena_owner.${project}:synthetic@aws-0-ca-central-1.pooler.supabase.com.example.test/postgres`,
    `postgres://yaparena_owner.${project}:synthetic@pooler.supabase.com/postgres`,
    `postgres://yaparena_owner.${project}:synthetic@aws-0-ca-central-1.attacker.pooler.supabase.com/postgres`,
    "postgres://yaparena_owner.short:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres",
    `postgres://yaparena_owner.${project}x:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres`,
    `postgres://yaparena_owner.${project.toUpperCase()}:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres`,
    `https://yaparena_owner.${project}:synthetic@aws-0-ca-central-1.pooler.supabase.com/postgres`,
  ]) {
    assert.throws(
      () => parseCoinSandboxOwnerDatabaseUrl(value),
      /dedicated owner connection/,
    );
    // The actual command must reject these before constructing its pool.
    await assert.rejects(
      runCoinSandboxOperator({
        command: "review",
        body: {},
        environment: {
          COIN_SANDBOX_RAIL: "simulation",
          COIN_SANDBOX_OWNER_DATABASE_URL: value,
        },
      }),
      /dedicated owner connection/,
    );
  }
});
it("requires an explicit isolated rail and exact server fee", () => {
  for (const invalid of [
    {},
    { rail: "live" },
    { rail: "base-sepolia" },
    { rail: "simulation", withdrawalFee: "0.1" },
  ])
    assert.throws(() => createCoinSandboxRepository({}, invalid));
});

describe(
  "persistent financial sandbox in disposable PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b, repo, other, operator;
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
      repo = createCoinSandboxRepository(a, config);
      other = createCoinSandboxRepository(b, config);
      operator = createCoinSandboxOperatorRepository(owner, config);
      assert.equal(
        (
          await owner.query(
            "SELECT rail FROM coin_sandbox_controls WHERE singleton",
          )
        ).rows[0].rail,
        "simulation",
      );
    });
    after(async () => {
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });
    // Every account signs in with an Auth0 subject. An opened account has the
    // automatic opening its first own request records (Decision 0013).
    async function fixture(opened = true) {
      const user = (
        await owner.query(
          "INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation AS generation",
        )
      ).rows[0];
      const token = createSessionToken();
      await createSessionRepository(a).create(
        user.id,
        token.tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration: user.generation },
      );
      const subject = await attachSubject(owner, user.id);
      if (opened) await openSandbox(owner, user.id);
      return {
        userId: user.id,
        sessionTokenHash: token.tokenHash,
        sessionToken: token.token,
        subject,
      };
    }
    function sandboxApp() {
      const server = express();
      server.use(express.json(), cookieParser());
      server.use(
        "/coins",
        createRequireAuthentication({
          sessions: createSessionRepository(a),
          environment: "test",
        }),
        createCoinSandboxRouter({
          sandbox: repo,
          debates: createCoinDebateSandbox(a, "simulation", {
            limits: {
              request: { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 },
            },
          }),
          operations: createAccountOperationRepository(a),
          environment: "test",
          applicationOrigin: origin,
          // These cases exercise the simulated money flows, which a
          // deployment enables explicitly (COIN_SANDBOX_TRANSFERS_ENABLED).
          transfersEnabled: true,
        }),
      );
      return server;
    }
    // Stands in for the provider callback after a fresh sign-in.
    function signIn(operations, context, id, authTime) {
      return operations.confirm({
        id,
        userId: context.userId,
        identity: {
          subject: context.subject,
          authTime: authTime ?? Math.ceil(Date.now() / 1000),
        },
      });
    }
    async function consumed(ids) {
      return (
        await owner.query(
          "SELECT consumed_at IS NOT NULL AS consumed FROM account_operations WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)",
          [ids],
        )
      ).rows.map((row) => row.consumed);
    }
    async function fund(context, amount = "10000000") {
      const quote = await repo.quoteFunding(context, {
        idempotencyKey: randomUUID(),
        amount,
      });
      const result = await repo.confirmSimulatedFunding(context, {
        requestId: quote.id,
      });
      return { quote, result };
    }
    async function proof(
      context,
      quote,
      terms = withdrawalApprovalTerms(quote),
    ) {
      return (
        await confirmedApproval(a, {
          userId: context.userId,
          sessionTokenHash: context.sessionTokenHash,
          subject: context.subject,
          purpose: "withdrawal.request",
          terms,
        })
      ).approval;
    }
    async function reserve(context, gross = "5000000") {
      const quote = await repo.quoteWithdrawal(context, {
        idempotencyKey: randomUUID(),
        gross,
        destination: "synthetic-external-wallet",
      });
      const approval = await proof(context, quote);
      return {
        quote,
        result: await repo.requestWithdrawal(context, {
          requestId: quote.id,
          approval,
        }),
      };
    }
    const event = (quote, changes = {}) => ({
      id: randomUUID(),
      externalId: quote.id,
      termsDigest: quote.termsDigest,
      source: "submission",
      status: "pending",
      finalNoTransfer: false,
      transactionId: null,
      ...changes,
    });
    async function approve(context, quote) {
      return operator.review({
        userId: context.userId,
        requestId: quote.id,
        decision: "approve",
        idempotencyKey: randomUUID(),
      });
    }
    async function counts(context) {
      return (
        await owner.query(
          `SELECT
      (SELECT count(*)::int FROM coin_sandbox_events WHERE user_id=$1) AS events,
      (SELECT count(*)::int FROM coin_external_receipts r JOIN coin_sandbox_requests q ON q.id=r.request_id WHERE q.user_id=$1) AS receipts,
      (SELECT count(*)::int FROM coin_journals j JOIN coin_postings p ON p.journal_id=j.id JOIN coin_accounts a ON a.id=p.account_id WHERE a.user_id=$1) AS postings`,
          [context.userId],
        )
      ).rows[0];
    }
    it("enforces withdrawal operator status and audit authority with real runtime SQL privileges", async () => {
      const context = await fixture();
      await fund(context);
      const quote = await repo.quoteWithdrawal(context, {
        idempotencyKey: randomUUID(),
        gross: "5000000",
        destination: "synthetic-operator-boundary-destination",
      });
      const denied = (promise) =>
        assert.rejects(promise, (error) => error.code === "42501");
      for (const status of [
        "review",
        "reserved",
        "approved",
        "pending",
        "executed",
        "completed",
        "settled",
        "failed",
        "uncertain",
        "void",
      ]) {
        await denied(
          a.query(
            "INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status) VALUES($1,$2,'withdrawal',$3,$4,$5,$6)",
            [
              randomUUID(),
              context.userId,
              digest(randomUUID()),
              quote.termsDigest,
              quote.terms,
              status,
            ],
          ),
        );
        if (status !== "review")
          await denied(
            a.query("UPDATE coin_sandbox_requests SET status=$2 WHERE id=$1", [
              quote.id,
              status,
            ]),
          );
      }
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM coin_sandbox_requests WHERE id=$1",
            [quote.id],
          )
        ).rows[0].status,
        "quoted",
      );
      await repo.requestWithdrawal(context, {
        requestId: quote.id,
        approval: await proof(context, quote),
      });
      const before = await repo.summary(context);
      for (const status of [
        "quoted",
        "reserved",
        "approved",
        "pending",
        "executed",
        "completed",
        "settled",
        "failed",
        "uncertain",
        "void",
      ])
        await denied(
          a.query("UPDATE coin_sandbox_requests SET status=$2 WHERE id=$1", [
            quote.id,
            status,
          ]),
        );
      for (const kind of [
        "withdrawal.approved",
        "withdrawal.rejected",
        "withdrawal.signed",
        "withdrawal.external.pending",
        "withdrawal.external.completed",
        "withdrawal.external.failed",
        "withdrawal.external.uncertain",
      ]) {
        const client = await a.connect();
        try {
          await client.query("BEGIN");
          const snapshot = await lockSandboxBook(client, context.userId);
          await denied(
            appendSandboxBookEvent(client, {
              userId: context.userId,
              snapshot,
              book: snapshot.book,
              kind,
              reference: digest(randomUUID()),
              termsDigest: quote.termsDigest,
              requestId: quote.id,
              metadata: { actorRole: "yaparena_owner" },
            }),
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      const unchanged = await repo.summary(context);
      assert.deepEqual(unchanged.book, before.book);
      assert.deepEqual(unchanged.balances, before.balances);
      assert.equal(unchanged.version, before.version);
      assert.equal((await approve(context, quote)).status, "approved");
      assert.equal((await repo.summary(context)).balances.pending, "5000000");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM coin_sandbox_events WHERE request_id=$1 AND kind='withdrawal.approved'",
            [quote.id],
          )
        ).rows[0].n,
        1,
      );
    });
    it("refuses new payout approval after suspension or without a sandbox opening while permitting safe rejection", async () => {
      for (const state of ["suspended", "unopened"]) {
        const actor = await fixture();
        await fund(actor);
        const { quote } = await reserve(actor);
        if (state === "suspended")
          await owner.query(
            "UPDATE users SET account_status='suspended' WHERE id=$1",
            [actor.userId],
          );
        // Openings are permanent in the product. Removing the record checks
        // that owner approval re-verifies it rather than trusting the request.
        else
          await owner.query(
            "DELETE FROM coin_sandbox_openings WHERE user_id=$1",
            [actor.userId],
          );
        const before = await counts(actor);
        await assert.rejects(
          approve(actor, quote),
          state === "suspended"
            ? /account unavailable for new payout authorization/
            : unopened,
        );
        assert.deepEqual(await counts(actor), before);
        assert.equal(
          (
            await owner.query(
              "SELECT status FROM coin_sandbox_requests WHERE id=$1",
              [quote.id],
            )
          ).rows[0].status,
          "review",
        );
        const rejected = await operator.review({
          userId: actor.userId,
          requestId: quote.id,
          decision: "reject",
          idempotencyKey: randomUUID(),
        });
        assert.equal(rejected.status, "failed");
        assert.equal(
          (
            await owner.query(
              "SELECT balance::text FROM coin_accounts WHERE user_id=$1 AND asset='USDC' AND kind='available'",
              [actor.userId],
            )
          ).rows[0].balance,
          "10000000",
        );
      }
    });
    it("blocks approval and signing authority under an uncertain funding correction but still reconciles an already submitted payout", async () => {
      const actor = await fixture(),
        funding = await fund(actor),
        { quote } = await reserve(actor, "10000000");
      await operator.correctFunding({
        userId: actor.userId,
        requestId: funding.quote.id,
        idempotencyKey: randomUUID(),
        reason: "incorrect_funding",
      });
      const before = await counts(actor);
      await assert.rejects(
        approve(actor, quote),
        /financial activity is paused/,
      );
      assert.deepEqual(await counts(actor), before);
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(
          assertSandboxNewPayoutAuthorization(client, actor.userId),
          /financial activity is paused/,
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      assert.equal(
        (
          await operator.review({
            userId: actor.userId,
            requestId: quote.id,
            decision: "reject",
            idempotencyKey: randomUUID(),
          })
        ).status,
        "failed",
      );
      const submitted = await fixture(),
        original = await fund(submitted),
        reserved = await reserve(submitted, "10000000");
      await approve(submitted, reserved.quote);
      await operator.observe({
        userId: submitted.userId,
        requestId: reserved.quote.id,
        event: event(reserved.quote),
      });
      await operator.correctFunding({
        userId: submitted.userId,
        requestId: original.quote.id,
        idempotencyKey: randomUUID(),
        reason: "incorrect_funding",
      });
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [submitted.userId],
      );
      await owner.query("DELETE FROM coin_sandbox_openings WHERE user_id=$1", [
        submitted.userId,
      ]);
      const reconciled = await operator.observe({
        userId: submitted.userId,
        requestId: reserved.quote.id,
        event: event(reserved.quote, {
          source: "reconciliation",
          status: "failed",
          finalNoTransfer: true,
        }),
      });
      assert.equal(reconciled.status, "failed");
      assert.equal(reconciled.disposition, "release");
      assert.equal(
        (
          await owner.query(
            "SELECT balance::text FROM coin_accounts WHERE user_id=$1 AND asset='USDC' AND kind='available'",
            [submitted.userId],
          )
        ).rows[0].balance,
        "10000000",
      );
    });
    it("opens Yap Coins automatically on an account's first request, with no confirmation (Decision 0013)", async () => {
      const actor = await fixture(false),
        newcomer = await fixture(false),
        server = sandboxApp(),
        sessionId = (await repo.summary(actor)).sessionId,
        post = (path, body = {}) =>
          request(server)
            .post(`/coins${path}`)
            .set("Cookie", `session=${actor.sessionToken}`)
            .set("X-YapArena-Session", sessionId)
            .set("Origin", origin)
            .send(body),
        openings = async (context) =>
          (
            await owner.query(
              "SELECT operation_id FROM coin_sandbox_openings WHERE user_id=$1",
              [context.userId],
            )
          ).rows,
        welcomeGrants = async (context) =>
          (
            await owner.query(
              "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1 AND kind='welcome'",
              [context.userId],
            )
          ).rows[0].n;
      // Reading the summary changes nothing.
      const before = await repo.summary(actor);
      assert.equal(before.opened, false);
      assert.equal(before.initialized, false);
      assert.deepEqual(await openings(actor), []);
      // The opening confirmation routes are gone.
      await post("/opening/operations").expect(404);
      await post("/opening", { approval: { id: randomUUID() } }).expect(404);
      // The first request opens the sandbox and claims the welcome grant once.
      assert.equal((await post("/initialize").expect(200)).body.created, true);
      assert.equal((await post("/initialize").expect(200)).body.created, false);
      assert.deepEqual(await openings(actor), [{ operation_id: null }]);
      assert.equal(await welcomeGrants(actor), 1);
      const after = await repo.summary(actor);
      assert.equal(after.opened, true);
      assert.equal(after.initialized, true);
      assert.equal(after.balances.promotionalPrincipal, "25000000");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM account_operations WHERE user_id=$1",
            [actor.userId],
          )
        ).rows[0].n,
        0,
      );
      // Any first own request opens, here a daily grant without the welcome.
      assert.equal((await repo.claimGrant(newcomer, "daily")).created, true);
      assert.deepEqual(await openings(newcomer), [{ operation_id: null }]);
      assert.equal(await welcomeGrants(newcomer), 0);
    });
    it("runs the authenticated HTTP quote, sign-in confirmation and reservation against the real ledger", async () => {
      // Never opened beforehand: its first request below opens it (Decision
      // 0013), and its withdrawal still needs a fresh sign-in.
      const actor = await fixture(false);
      const intruder = await fixture();
      const app = sandboxApp();
      const operations = createAccountOperationRepository(a);
      const cookie = `session=${actor.sessionToken}`;
      const sessionId = (await repo.summary(actor)).sessionId;
      const intruderSessionId = (await repo.summary(intruder)).sessionId;
      await request(app).get("/coins/summary").expect(401);
      await request(app)
        .post("/coins/funding/quotes")
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .set("Origin", "https://untrusted.example")
        .send({ amount: "10000000" })
        .expect(403);
      await request(app)
        .post("/coins/funding/quotes")
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .set("Origin", origin)
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "10000000", userId: intruder.userId })
        .expect(400);
      const funding = await request(app)
        .post("/coins/funding/quotes")
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .set("Origin", origin)
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "10000000" })
        .expect(201);
      assert.equal(funding.body.terms.rail, "simulation");
      assert.deepEqual(
        (
          await owner.query(
            "SELECT operation_id FROM coin_sandbox_openings WHERE user_id=$1",
            [actor.userId],
          )
        ).rows,
        [{ operation_id: null }],
      );
      await request(app)
        .post(`/coins/funding/${funding.body.id}/confirm`)
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .set("Origin", origin)
        .send({})
        .expect(200);
      const quote = await request(app)
        .post("/coins/withdrawals/quotes")
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .set("Origin", origin)
        .set("Idempotency-Key", randomUUID())
        .send({ gross: "5000000", destination: "synthetic-route-wallet" })
        .expect(201);
      assert.equal(quote.body.terms.net, "4900000");
      const post = (path, body = {}) =>
        request(app)
          .post(`/coins${path}`)
          .set("Cookie", cookie)
          .set("X-YapArena-Session", sessionId)
          .set("Origin", origin)
          .send(body);
      await request(app)
        .post(`/coins/withdrawals/${quote.body.id}/operations`)
        .set("Cookie", `session=${intruder.sessionToken}`)
        .set("X-YapArena-Session", intruderSessionId)
        .set("Origin", origin)
        .send({})
        .expect(404);
      await post(`/withdrawals/${quote.body.id}/operations`, {
        credential: { type: "password" },
      }).expect(400);
      const operation = (
        await post(`/withdrawals/${quote.body.id}/operations`).expect(201)
      ).body;
      assert.deepEqual(operation.terms, quote.body.terms);
      assert.equal(
        operation.confirmPath,
        `/api/auth/confirm?operation=${operation.id}`,
      );
      // Missing, unknown and not yet confirmed confirmations reserve nothing.
      await post(`/withdrawals/${quote.body.id}`).expect(400);
      await post(`/withdrawals/${quote.body.id}`, {
        approval: { id: randomUUID() },
      }).expect(410);
      assert.match(
        (
          await post(`/withdrawals/${quote.body.id}`, {
            approval: { id: operation.id },
          }).expect(410)
        ).body.error,
        expiredConfirmation,
      );
      await assert.rejects(
        signIn(
          operations,
          { ...actor, subject: intruder.subject },
          operation.id,
        ),
        { code: "other_account" },
      );
      await signIn(operations, actor, operation.id);
      // A confirmed operation for other withdrawal terms does not transfer.
      const spare = await post("/withdrawals/quotes", {
        gross: "6000000",
        destination: "synthetic-other-route-wallet",
      })
        .set("Idempotency-Key", randomUUID())
        .expect(201);
      const spareOperation = (
        await post(`/withdrawals/${spare.body.id}/operations`).expect(201)
      ).body;
      await signIn(operations, actor, spareOperation.id);
      await post(`/withdrawals/${quote.body.id}`, {
        approval: { id: spareOperation.id },
      }).expect(410);
      assert.equal(
        (await repo.summary(actor)).balances.reserved,
        "0",
        "no unconfirmed or mismatched confirmation may reserve",
      );
      assert.equal(
        (
          await post(`/withdrawals/${quote.body.id}`, {
            approval: { id: operation.id },
          }).expect(200)
        ).body.status,
        "review",
      );
      // One use: the consumed confirmation cannot be presented again.
      await post(`/withdrawals/${quote.body.id}`, {
        approval: { id: operation.id },
      }).expect(410);
      assert.deepEqual(await consumed([operation.id, spareOperation.id]), [
        true,
        false,
      ]);
      const summary = await request(app)
        .get("/coins/summary")
        .set("Cookie", cookie)
        .set("X-YapArena-Session", sessionId)
        .expect(200);
      assert.equal(summary.headers["cache-control"], "private, no-store");
      assert.equal(summary.body.opened, true);
      assert.equal(summary.body.balances.cashAvailable, "5000000");
      assert.equal(summary.body.balances.reserved, "5000000");
      assert.equal((await repo.summary(intruder)).balances.cashAvailable, "0");
    });
    it("keeps the summary read-only for a new account, and separates rails and owner review and funding authority", async () => {
      const newcomer = await fixture(false);
      const before = await repo.summary(newcomer);
      assert.equal(before.initialized, false);
      assert.equal(before.balances.cashAvailable, "0");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_sandbox_books WHERE user_id=$1",
            [newcomer.userId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(before.opened, false);
      const base = createCoinSandboxRepository(a, {
        rail: "base-sepolia",
        depositDestination: `0x${"11".repeat(20)}`,
      });
      await assert.rejects(base.summary(newcomer), /isolated database/);
      assert.throws(
        () =>
          base.confirmSimulatedFunding(newcomer, { requestId: randomUUID() }),
        /prohibited/,
      );
      await assert.rejects(
        a.query(
          "UPDATE coin_sandbox_controls SET rail='base-sepolia' WHERE singleton",
        ),
        { code: "42501" },
      );
      const member = await fixture();
      const { quote } = await fund(member);
      await assert.rejects(
        createCoinSandboxOperatorRepository(a, config).review({
          userId: member.userId,
          requestId: quote.id,
          decision: "approve",
          idempotencyKey: randomUUID(),
        }),
        /operator ownership/,
      );
      await assert.rejects(
        operator.confirmFunding({
          userId: member.userId,
          requestId: quote.id,
          receipt: {},
        }),
        /simulation ledger/,
      );
      const baseOperator = createCoinSandboxOperatorRepository(owner, {
        rail: "base-sepolia",
        depositDestination: `0x${"11".repeat(20)}`,
      });
      await assert.rejects(
        baseOperator.seedSandboxTreasury({
          userId: member.userId,
          purpose: "promotional",
          amount: "1",
          idempotencyKey: randomUUID(),
        }),
        /invented treasury/,
      );
      // Owner funding also requires the account's own opening, even for a
      // quote the owner placed on an account that never opened the sandbox.
      const template = await repo.quoteFunding(member, {
          amount: "1000000",
          idempotencyKey: randomUUID(),
        }),
        requestId = randomUUID(),
        terms = { ...template.terms, requestId, quoteId: requestId };
      await owner.query(
        `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status,expires_at)
        VALUES($1,$2,'funding',$3,$4,$5::jsonb,'quoted',$6)`,
        [
          requestId,
          newcomer.userId,
          digest(requestId),
          accountOperationTermsDigest(terms),
          JSON.stringify(terms),
          new Date(terms.expiresAt),
        ],
      );
      const unchanged = await counts(newcomer);
      await assert.rejects(
        operator.confirmSimulatedFunding({
          userId: newcomer.userId,
          requestId,
        }),
        unopened,
      );
      assert.deepEqual(await counts(newcomer), unchanged);
      await openSandbox(owner, newcomer.userId);
      assert.equal(
        (
          await operator.confirmSimulatedFunding({
            userId: newcomer.userId,
            requestId,
          })
        ).created,
        true,
      );
      assert.equal(
        (await repo.summary(newcomer)).balances.cashAvailable,
        "1000000",
      );
    });
    it("queues authenticated notifications exactly once and reconciles only in the separate owner process", async () => {
      const context = await fixture();
      await fund(context);
      const { quote } = await reserve(context);
      await approve(context, quote);
      const initial = await counts(context);
      const app = express(),
        secret = "synthetic-PG-only-webhook-key-of-32-bytes";
      app.use(
        "/hook",
        createSandboxWebhookRouter({ database: a, rail: "simulation", secret }),
      );
      const delivery = randomUUID();
      async function deliver(status = "failed", deliveryId = delivery) {
        const payload = JSON.stringify({
            requestId: quote.id,
            status,
            transactionId: null,
          }),
          timestamp = String(Math.floor(Date.now() / 1000)),
          signature = createHmac("sha256", secret)
            .update(`${timestamp}.${deliveryId}.`)
            .update(payload)
            .digest("hex");
        return request(app)
          .post("/hook")
          .set("Content-Type", "application/json")
          .set("x-yap-timestamp", timestamp)
          .set("x-yap-delivery", deliveryId)
          .set("x-yap-signature", signature)
          .send(payload);
      }
      const notifications = await Promise.all(
        Array.from({ length: 8 }, () => deliver()),
      );
      assert.ok(notifications.every((response) => response.status === 202));
      assert.equal(
        notifications.filter((response) => !response.body.duplicate).length,
        1,
      );
      assert.equal((await deliver("completed")).status, 409);
      // A failed notification carries no authority to release a reservation.
      assert.equal((await repo.summary(context)).balances.pending, "5000000");
      assert.deepEqual(await counts(context), initial);
      await assert.rejects(
        a.query(
          "UPDATE coin_sandbox_webhook_inbox SET provider='deterministic-simulation'",
        ),
        { code: "42501" },
      );
      await assert.rejects(a.query("DELETE FROM coin_sandbox_webhook_inbox"), {
        code: "42501",
      });
      await assert.rejects(
        a.query("SELECT * FROM coin_sandbox_webhook_outcomes"),
        { code: "42501" },
      );
      const environment = {
        COIN_SANDBOX_OWNER_DATABASE_URL: ownerUrl,
        COIN_SANDBOX_RAIL: "simulation",
      };
      const result = await runCoinSandboxOperator({
        command: "drain-inbox",
        body: { limit: 20 },
        environment,
      });
      assert.ok(result.processed >= 1);
      assert.equal(result.rail, "simulation");
      assert.equal((await repo.summary(context)).balances.pending, "0");
      assert.equal(
        (await repo.summary(context)).balances.cashAvailable,
        "10000000",
      );
      const outcome = (
        await owner.query(
          `SELECT o.disposition,o.reason_code FROM coin_sandbox_webhook_outcomes o
        JOIN coin_sandbox_webhook_inbox i ON i.id=o.inbox_id WHERE i.delivery_id=$1`,
          [delivery],
        )
      ).rows[0];
      assert.deepEqual(outcome, {
        disposition: "processed",
        reason_code: "applied",
      });
      await deliver("pending", randomUUID());
      await runCoinSandboxOperator({
        command: "drain-inbox",
        body: {},
        environment,
      });
      assert.equal((await repo.getRequest(context, quote.id)).status, "failed");
      assert.equal(
        (await repo.summary(context)).balances.cashAvailable,
        "10000000",
      );
      const seed = {
        userId: context.userId,
        purpose: "promotional",
        amount: "1000000",
        idempotencyKey: randomUUID(),
      };
      await runCoinSandboxOperator({
        command: "seed-simulation",
        body: seed,
        environment,
      });
      const afterSeed = await counts(context);
      await runCoinSandboxOperator({
        command: "seed-simulation",
        body: seed,
        environment,
      });
      assert.deepEqual(await counts(context), afterSeed);
      assert.equal(
        (await repo.summary(context)).balances.cashAvailable,
        "10000000",
      );
      await assert.rejects(
        runCoinSandboxOperator({
          command: "review",
          body: {},
          environment: {
            ...environment,
            COIN_SANDBOX_OWNER_DATABASE_URL: runtimeUrl,
          },
        }),
        /dedicated owner/,
      );
    });
    it("issues welcome and each Toronto day's daily principal exactly once across pools, with no cash backing minted", async () => {
      const context = await fixture();
      const made = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? repo : other).initialize(context),
        ),
      );
      assert.equal(made.filter((result) => result.created).length, 1);
      assert.equal(new Set(made.map((result) => result.grantId)).size, 1);
      const daily = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? repo : other).claimGrant(context, "daily"),
        ),
      );
      for (const day of new Set(daily.map((result) => result.day)))
        assert.equal(
          daily.filter((result) => result.day === day && result.created).length,
          1,
        );
      const summary = await repo.summary(context);
      const days = new Set(daily.map((result) => result.day)).size;
      assert.equal(
        summary.balances.promotionalPrincipal,
        String(25000000 + 5000000 * days),
      );
      assert.equal(summary.balances.cashAvailable, "0");
      assert.equal(summary.projection.withdrawable, "0");
      assert.equal(summary.book.grants.length, 1 + days);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1",
            [context.userId],
          )
        ).rows[0].n,
        1 + days,
      );
      await assert.rejects(
        owner.query(
          "UPDATE coin_sandbox_controls SET rail='base-sepolia' WHERE singleton",
        ),
        /history|immutable|rail/i,
      );
    });
    it("quotes exact simulated conversion and confirms one globally identified receipt across concurrent retries", async () => {
      const context = await fixture(),
        key = randomUUID();
      const quote = await repo.quoteFunding(context, {
        amount: "12345678",
        idempotencyKey: key,
      });
      assert.equal(
        (
          await other.quoteFunding(context, {
            amount: "12345678",
            idempotencyKey: key,
          })
        ).id,
        quote.id,
      );
      await assert.rejects(
        repo.quoteFunding(context, { amount: "12345679", idempotencyKey: key }),
        /different quote/,
      );
      assert.equal(quote.terms.conversionRate, "1");
      assert.equal(quote.terms.yapCoinsPerUsdc, "100");
      assert.equal(quote.terms.rail, "simulation");
      const before = await counts(context);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? repo : other).confirmSimulatedFunding(context, {
            requestId: quote.id,
          }),
        ),
      );
      assert.equal(results.filter((result) => result.created).length, 1);
      const summary = await repo.summary(context);
      assert.equal(summary.balances.cashAvailable, "12345678");
      assert.equal(summary.projection.withdrawable, "12345678");
      assert.equal(summary.book.purchased[0].id, quote.id);
      const after = await counts(context);
      assert.equal(after.receipts - before.receipts, 1);
      assert.equal(after.events - before.events, 1);
      const stranger = await fixture();
      await assert.rejects(
        repo.confirmSimulatedFunding(stranger, { requestId: quote.id }),
        /unavailable/,
      );
      const second = await repo.quoteFunding(context, {
        amount: "12345678",
        idempotencyKey: randomUUID(),
      });
      const assigned = await repo.quoteFunding(context, {
        amount: "12345678",
        idempotencyKey: randomUUID(),
      });
      await owner.query(
        `INSERT INTO coin_external_receipts(id,request_id,network,asset,transaction_id,locator,amount,evidence_digest)
      VALUES($1,$2,'simulation:usdc','USDC',$3,'credit:0',$4,$5)`,
        [
          randomUUID(),
          assigned.id,
          `simulation:${second.id}`,
          second.terms.amount,
          "a".repeat(64),
        ],
      );
      await assert.rejects(
        repo.confirmSimulatedFunding(context, { requestId: second.id }),
        /assigned or conflicts/,
      );
      assert.equal(
        (await repo.summary(context)).balances.cashAvailable,
        "12345678",
      );
    });
    it("caps one simulated purchase at 1,000 USDC, far below numeric(36,0)", async () => {
      const context = await fixture();
      for (const amount of ["1000000001", "9".repeat(36)])
        await assert.rejects(
          repo.quoteFunding(context, { amount, idempotencyKey: randomUUID() }),
          (error) =>
            error.status === 400 && /limited to 1,000 USDC/.test(error.message),
        );
      const quote = await repo.quoteFunding(context, {
        amount: "1000000000",
        idempotencyKey: randomUUID(),
      });
      assert.equal(quote.terms.amount, "1000000000");
    });
    it("rejects expired quote use without trusting application clocks or issuing balances", async () => {
      const context = await fixture(),
        original = await repo.quoteFunding(context, {
          amount: "5000000",
          idempotencyKey: randomUUID(),
        });
      const id = randomUUID(),
        expires = new Date(Date.now() - 60000),
        terms = {
          ...original.terms,
          requestId: id,
          quoteId: id,
          expiresAt: expires.toISOString(),
        };
      await owner.query(
        `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status,expires_at)
      VALUES($1,$2,'funding',$3,$4,$5::jsonb,'quoted',$6)`,
        [
          id,
          context.userId,
          digest(id),
          accountOperationTermsDigest(terms),
          JSON.stringify(terms),
          expires,
        ],
      );
      await assert.rejects(
        repo.confirmSimulatedFunding(context, { requestId: id }),
        /quote expired/,
      );
      assert.equal((await repo.summary(context)).balances.cashAvailable, "0");
    });
    it("rolls back funding and withdrawal quotes that expire during a real ledger lock wait", async () => {
      for (const kind of ["funding", "withdrawal"]) {
        const context = await fixture();
        await fund(context);
        const original =
          kind === "funding"
            ? await repo.quoteFunding(context, {
                amount: "5000000",
                idempotencyKey: randomUUID(),
              })
            : await repo.quoteWithdrawal(context, {
                gross: "5000000",
                destination: "synthetic-expiry-wallet",
                idempotencyKey: randomUUID(),
              });
        const expires = (
          await owner.query(
            "SELECT clock_timestamp()+INTERVAL '3 seconds' AS expires",
          )
        ).rows[0].expires;
        const id = randomUUID(),
          terms = {
            ...original.terms,
            requestId: id,
            quoteId: id,
            expiresAt: expires.toISOString(),
          };
        await owner.query(
          `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status,expires_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,'quoted',$7)`,
          [
            id,
            context.userId,
            kind,
            digest(id),
            accountOperationTermsDigest(terms),
            JSON.stringify(terms),
            expires,
          ],
        );
        const quote = await repo.getRequest(context, id),
          approval = kind === "withdrawal" ? await proof(context, quote) : null,
          before = await counts(context),
          locker = await owner.connect();
        let pending;
        try {
          await locker.query("BEGIN");
          const pid = (await locker.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          await locker.query(
            "SELECT id FROM coin_accounts WHERE user_id=$1 AND environment='sandbox' AND asset='USDC' AND kind='available' FOR UPDATE",
            [context.userId],
          );
          pending = (
            kind === "funding"
              ? repo.confirmSimulatedFunding(context, { requestId: id })
              : repo.requestWithdrawal(context, { requestId: id, approval })
          ).then(
            () => null,
            (error) => error,
          );
          let blocked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            blocked = (
              await owner.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              )
            ).rows[0].blocked;
            if (blocked) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            blocked,
            true,
            "operation must reach the ledger lock while quote is active",
          );
          await owner.query(
            "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp())+0.05))",
            [expires],
          );
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
        }
        const failure = await pending;
        assert.match(failure?.message ?? "", /quote expired/);
        assert.equal(
          (await repo.summary(context)).balances.cashAvailable,
          "10000000",
        );
        assert.equal((await repo.summary(context)).balances.reserved, "0");
        assert.deepEqual(await counts(context), before);
        assert.equal((await repo.getRequest(context, id)).status, "quoted");
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM account_operations WHERE user_id=$1 AND consumed_at IS NOT NULL",
              [context.userId],
            )
          ).rows[0].n,
          0,
        );
      }
    });
    it("binds gross/fee/net/destination to a sign-in confirmation and reserves exactly the gross debit", async () => {
      const context = await fixture();
      await fund(context);
      await assert.rejects(
        repo.quoteWithdrawal(context, {
          gross: "4999999",
          destination: "synthetic",
          idempotencyKey: randomUUID(),
        }),
        /at least 5 USDC/,
      );
      const quote = await repo.quoteWithdrawal(context, {
        gross: "5000000",
        destination: "synthetic",
        idempotencyKey: randomUUID(),
      });
      assert.equal(quote.terms.gross, "5000000");
      assert.equal(quote.terms.fee, "100000");
      assert.equal(quote.terms.net, "4900000");
      const bad = await proof(context, quote, {
        ...quote.terms,
        net: "5000000",
      });
      await assert.rejects(
        repo.requestWithdrawal(context, { requestId: quote.id, approval: bad }),
        /does not authorize/,
      );
      const approval = await proof(context, quote),
        result = await repo.requestWithdrawal(context, {
          requestId: quote.id,
          approval,
        });
      assert.equal(result.status, "review");
      const summary = await repo.summary(context);
      assert.equal(summary.balances.cashAvailable, "5000000");
      assert.equal(summary.balances.reserved, "5000000");
      assert.equal(summary.balances.pending, "0");
      assert.equal(summary.projection.withdrawable, "5000000");
      await assert.rejects(
        repo.requestWithdrawal(context, { requestId: quote.id, approval }),
        /expired or invalid|already submitted/,
      );
    });
    it("prevents concurrent over-reservation and rolls source/proof changes back on failure", async () => {
      const context = await fixture();
      await fund(context);
      const quotes = await Promise.all([
        repo.quoteWithdrawal(context, {
          gross: "7000000",
          destination: "first",
          idempotencyKey: randomUUID(),
        }),
        repo.quoteWithdrawal(context, {
          gross: "7000000",
          destination: "second",
          idempotencyKey: randomUUID(),
        }),
      ]);
      const proofs = await Promise.all(
        quotes.map((quote) => proof(context, quote)),
      );
      const results = await Promise.allSettled(
        quotes.map((quote, index) =>
          (index ? other : repo).requestWithdrawal(context, {
            requestId: quote.id,
            approval: proofs[index],
          }),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failed = results.findIndex(
        (result) => result.status === "rejected",
      );
      assert.match(results[failed].reason.message, /insufficient/);
      const summary = await repo.summary(context);
      assert.equal(summary.balances.cashAvailable, "3000000");
      assert.equal(summary.balances.reserved, "7000000");
      await fund(context, "7000000");
      assert.equal(
        (
          await repo.requestWithdrawal(context, {
            requestId: quotes[failed].id,
            approval: proofs[failed],
          })
        ).status,
        "review",
      );
    });
    it("has no obsolete 100-USDC daily cap and never charges the fee on top", async () => {
      const context = await fixture();
      await fund(context, "300000000");
      await reserve(context, "150000000");
      await reserve(context, "150000000");
      const summary = await repo.summary(context);
      assert.equal(summary.balances.cashAvailable, "0");
      assert.equal(summary.balances.reserved, "300000000");
      assert.equal(
        summary.requests.filter((request) => request.kind === "withdrawal")
          .length,
        2,
      );
    });
    it("keeps uncertain payment reserves, ignores delayed pending events, and releases only final no-transfer reconciliation", async () => {
      const context = await fixture();
      await fund(context);
      const { quote } = await reserve(context);
      await approve(context, quote);
      const uncertain = event(quote, { status: "failed" });
      const observed = await operator.observe({
        userId: context.userId,
        requestId: quote.id,
        event: uncertain,
      });
      assert.equal(observed.status, "uncertain");
      assert.equal(observed.disposition, "retain");
      assert.equal((await repo.summary(context)).balances.pending, "5000000");
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: event(quote, { source: "webhook" }),
          })
        ).status,
        "uncertain",
      );
      await assert.rejects(
        operator.observe({
          userId: context.userId,
          requestId: quote.id,
          event: event(quote, {
            source: "webhook",
            status: "completed",
            transactionId: "unreconciled",
          }),
        }),
        /reconciled transfer evidence/,
      );
      const failed = event(quote, {
        source: "reconciliation",
        status: "failed",
        finalNoTransfer: true,
      });
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: failed,
          })
        ).disposition,
        "release",
      );
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: failed,
          })
        ).created,
        false,
      );
      const summary = await other.summary(context);
      assert.equal(summary.balances.pending, "0");
      assert.equal(summary.balances.cashAvailable, "10000000");
      assert.equal(summary.book.purchased[0].balance, "10000000");
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: event(quote, { source: "webhook" }),
          })
        ).status,
        "failed",
      );
      await assert.rejects(
        operator.observe({
          userId: context.userId,
          requestId: quote.id,
          event: event(quote, {
            source: "reconciliation",
            status: "completed",
            transactionId: "too-late",
          }),
        }),
        /manual reconciliation/,
      );
    });
    it("settles one reconciled transfer, records fees separately and rejects foreign operation or receipt reuse", async () => {
      const context = await fixture();
      await fund(context);
      const { quote } = await reserve(context);
      await approve(context, quote);
      await assert.rejects(
        operator.observe({
          userId: context.userId,
          requestId: quote.id,
          event: event(quote, { externalId: randomUUID() }),
        }),
        /does not match/,
      );
      const tx = `synthetic-${randomUUID()}`,
        completed = event(quote, {
          source: "reconciliation",
          status: "completed",
          transactionId: tx,
        });
      const receipt = {
        network: "simulation:usdc",
        transactionId: tx,
        locator: "transfer:0",
        amount: "4900000",
        evidenceDigest: digest(tx),
      };
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: completed,
            receipt,
          })
        ).disposition,
        "settle",
      );
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: completed,
            receipt,
          })
        ).created,
        false,
      );
      const summary = await repo.summary(context);
      assert.equal(summary.balances.pending, "0");
      assert.equal(summary.balances.cashAvailable, "5000000");
      assert.equal(
        (
          await operator.observe({
            userId: context.userId,
            requestId: quote.id,
            event: event(quote, { source: "webhook" }),
          })
        ).status,
        "completed",
      );
      const next = await reserve(context);
      await approve(context, next.quote);
      await assert.rejects(
        operator.observe({
          userId: context.userId,
          requestId: next.quote.id,
          event: event(next.quote, {
            source: "reconciliation",
            status: "completed",
            transactionId: tx,
          }),
          receipt,
        }),
        /assigned or conflicts/,
      );
      assert.equal((await repo.summary(context)).balances.pending, "5000000");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_external_receipts WHERE transaction_id=$1",
            [tx],
          )
        ).rows[0].n,
        1,
      );
    });
    it("manually rejects an undispatched request exactly once and restores original sources", async () => {
      const context = await fixture();
      await fund(context);
      const { quote } = await reserve(context);
      const key = randomUUID();
      const input = {
        userId: context.userId,
        requestId: quote.id,
        decision: "reject",
        idempotencyKey: key,
      };
      assert.equal((await operator.review(input)).status, "failed");
      assert.equal((await operator.review(input)).created, false);
      await assert.rejects(
        operator.review({ ...input, decision: "approve" }),
        /idempotency conflict/,
      );
      const summary = await repo.summary(context);
      assert.equal(summary.balances.cashAvailable, "10000000");
      assert.equal(summary.balances.reserved, "0");
    });
    it("uses append-only correction reversals and pauses only financial entry if original value has left", async () => {
      const first = await fixture(),
        { quote } = await fund(first);
      const correction = {
        userId: first.userId,
        requestId: quote.id,
        idempotencyKey: randomUUID(),
        reason: "incorrect_funding",
      };
      assert.equal(
        (await operator.correctFunding(correction)).status,
        "completed",
      );
      assert.equal((await operator.correctFunding(correction)).created, false);
      assert.equal((await repo.summary(first)).balances.cashAvailable, "0");
      assert.equal(
        (await repo.confirmSimulatedFunding(first, { requestId: quote.id }))
          .created,
        false,
      );
      assert.equal((await repo.summary(first)).balances.cashAvailable, "0");
      const second = await fixture(),
        funded = await fund(second);
      const pending = await reserve(second);
      const result = await operator.correctFunding({
        userId: second.userId,
        requestId: funded.quote.id,
        idempotencyKey: randomUUID(),
        reason: "operator_error",
      });
      assert.equal(result.financialReviewRequired, true);
      assert.equal((await repo.summary(second)).financialReviewRequired, true);
      await assert.rejects(
        repo.claimGrant(second, "daily"),
        /paused for correction/,
      );
      assert.ok(
        await createSessionRepository(a).findUserByTokenHash(
          second.sessionTokenHash,
        ),
      );
      const retry = {
        userId: second.userId,
        correctionId: result.requestId,
        idempotencyKey: randomUUID(),
      };
      await assert.rejects(
        operator.retryCorrection(retry),
        /unused purchase principal/,
      );
      await operator.review({
        userId: second.userId,
        requestId: pending.quote.id,
        decision: "reject",
        idempotencyKey: randomUUID(),
      });
      const report = await createSandboxErrorReports(a, "simulation").submit(
          second,
          {
            requestId: funded.quote.id,
            message: "Synthetic erroneous credit review",
            idempotencyKey: randomUUID(),
          },
        ),
        reviewed = await createSandboxErrorReportOperator(
          owner,
          "simulation",
        ).review({
          reportId: report.report.id,
          idempotencyKey: randomUUID(),
          outcome: "erroneous_credit",
          note: "Synthetic reviewed wrong credit",
          evidenceDigest: digest("synthetic correction evidence"),
        });
      await runCoinSandboxOperator({
        command: "retry-correction",
        body: {
          correctionId: retry.correctionId,
          idempotencyKey: retry.idempotencyKey,
          reportId: report.report.id,
          reviewId: reviewed.event.id,
        },
        environment: {
          COIN_SANDBOX_OWNER_DATABASE_URL: ownerUrl,
          COIN_SANDBOX_RAIL: "simulation",
        },
      });
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM coin_sandbox_requests WHERE id=$1",
            [retry.correctionId],
          )
        ).rows[0].status,
        "completed",
      );
      assert.equal((await operator.retryCorrection(retry)).created, false);
      assert.equal((await repo.summary(second)).financialReviewRequired, false);
      assert.equal((await repo.summary(second)).balances.cashAvailable, "0");
    });
    it("keeps books/events/ledger history immutable and live financial writes unavailable to runtime", async () => {
      const context = await fixture();
      await fund(context);
      await assert.rejects(
        a.query(
          "UPDATE coin_sandbox_books SET version=version+1 WHERE user_id=$1",
          [context.userId],
        ),
        /append-only event/,
      );
      await assert.rejects(
        owner.query("DELETE FROM coin_sandbox_events WHERE user_id=$1", [
          context.userId,
        ]),
        /append-only/,
      );
      await assert.rejects(
        a.query(
          "INSERT INTO coin_accounts(id,environment,asset,kind,user_id) VALUES($1,'live','USDC','available',$2)",
          [randomUUID(), context.userId],
        ),
        { code: "42501" },
      );
      await createSessionRepository(b).deleteByTokenHash(
        context.sessionTokenHash,
      );
      await assert.rejects(repo.initialize(context), /session is unavailable/);
    });
    it("restores funded qualified grant profit without touching virtual principal or purchased backing", async () => {
      const context = await fixture();
      await repo.initialize(context);
      await fund(context, "3000000");
      await operator.seedSandboxTreasury({
        userId: context.userId,
        purpose: "promotional",
        amount: "50000000",
        idempotencyKey: randomUUID(),
      });
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          context.userId,
        ]);
        const snapshot = await lockSandboxBook(c, context.userId),
          buckets = await ensureSandboxBuckets(c, context.userId),
          j = randomUUID();
        await postCoinJournal(c, {
          id: j,
          environment: "sandbox",
          asset: "USDC",
          operation: "funding",
          reference: digest(j),
          postings: [
            {
              accountId: buckets.system.promotional_available,
              amount: "-25000000",
            },
            { accountId: buckets.cashAvailable, amount: "25000000" },
          ],
        });
        const grant = snapshot.book.grants[0];
        const book = {
          ...snapshot.book,
          grants: [
            {
              ...grant,
              profitRemaining: "25000000",
              netProfit: "25000000",
              peakNetProfit: "25000000",
            },
          ],
        };
        await c.query(
          "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'sandbox','USDC',25000000)",
          [grant.id, j],
        );
        await appendSandboxBookEvent(c, {
          userId: context.userId,
          snapshot,
          book,
          kind: "fixture.funded_profit",
          reference: digest(randomUUID()),
          termsDigest: digest(book),
          cashJournalId: j,
          metadata: { deterministicFixture: true },
        });
        await c.query("COMMIT");
      } catch (failure) {
        await c.query("ROLLBACK");
        throw failure;
      } finally {
        c.release();
      }
      const initial = await repo.summary(context),
        { quote } = await reserve(context);
      await approve(context, quote);
      assert.equal(
        (await repo.summary(context)).balances.promotionalPrincipal,
        "25000000",
      );
      await operator.observe({
        userId: context.userId,
        requestId: quote.id,
        event: event(quote, {
          source: "reconciliation",
          status: "failed",
          finalNoTransfer: true,
        }),
      });
      const restored = await repo.summary(context);
      assert.deepEqual(restored.book, initial.book);
      assert.equal(restored.projection.withdrawable, "28000000");
      assert.equal(restored.projection.grants[0].qualified, true);
    });
  },
);
