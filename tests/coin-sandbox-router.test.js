import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";
import { CoinOperationError } from "../dist/features/account-wallet/external-operations.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";

// Yap Coins launch mode: the simulated purchase, withdrawal and error-report
// flows exist only where COIN_SANDBOX_TRANSFERS_ENABLED asks for them, and
// every refusal carries a code the browser turns into its own words.
const origin = "https://arena.example";
const roundId = "44444444-4444-4444-8444-444444444444";
const debateId = "33333333-3333-4333-8333-333333333333";

function app(options = {}, debates = {}) {
  const calls = [];
  const server = express();
  server.use(express.json(), cookieParser());
  server.use((req, _res, next) => {
    req.user = { id: "7" };
    next();
  });
  const record =
    (name, value = {}) =>
    async () => {
      calls.push(name);
      return value;
    };
  server.use(
    "/coins",
    createCoinSandboxRouter({
      sandbox: {
        summary: record("summary", { sessionId: "9", initialized: true }),
        quoteFunding: record("quoteFunding", { id: roundId }),
        confirmSimulatedFunding: record("confirmSimulatedFunding"),
        quoteWithdrawal: record("quoteWithdrawal", { id: roundId }),
        getRequest: record("getRequest", { kind: "withdrawal", terms: {} }),
      },
      debates: {
        submit: record("submit", { id: roundId, created: true }),
        ...debates,
      },
      reports: {
        list: record("reports.list", []),
        submit: record("reports.submit", {}),
      },
      operations: { create: record("create"), prepare: record("prepare") },
      environment: "test",
      applicationOrigin: origin,
      ...options,
    }),
  );
  return { server, calls };
}
const get = (server, path) =>
  request(server).get(path).set("Cookie", "session=synthetic-session");
const post = (server, path, body = {}) =>
  request(server)
    .post(path)
    .set("Cookie", "session=synthetic-session")
    .set("Origin", origin)
    .set("X-YapArena-Session", "9")
    .set("Idempotency-Key", "key-1")
    .send(body);

describe("simulated Yap Coins purchases and withdrawals", () => {
  it("are refused, and reported unavailable, unless the deployment enables them", async () => {
    const { server, calls } = app();
    const summary = await get(server, "/coins/summary");
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.features, {
      transfers: false,
      manualRounds: true,
    });
    for (const [path, body] of [
      ["/coins/funding/quotes", { amount: "1000000" }],
      [`/coins/funding/${roundId}/confirm`, {}],
      ["/coins/withdrawals/quotes", { gross: "5000000", destination: "x" }],
      [`/coins/withdrawals/${roundId}/operations`, {}],
      [`/coins/withdrawals/${roundId}`, { approval: { id: roundId } }],
      ["/coins/reports", { requestId: roundId, description: "lost" }],
    ]) {
      const response = await post(server, path, body);
      assert.equal(response.status, 404, path);
      assert.equal(response.body.code, "unavailable", path);
    }
    const reports = await get(server, "/coins/reports");
    assert.equal(reports.status, 404);
    assert.deepEqual(calls, ["summary"]);
  });

  it("reach the sandbox when enabled, and report manual rounds off with turn windows", async () => {
    const { server, calls } = app({
      transfersEnabled: true,
      manualRounds: false,
    });
    assert.deepEqual((await get(server, "/coins/summary")).body, {
      sessionId: "9",
      initialized: true,
      features: { transfers: true, manualRounds: false },
    });
    assert.equal(
      (await post(server, "/coins/funding/quotes", { amount: "1000000" }))
        .status,
      201,
    );
    assert.equal((await get(server, "/coins/reports")).status, 200);
    assert.deepEqual(calls, ["summary", "quoteFunding", "reports.list"]);
  });
});

describe("Yap Coins refusals", () => {
  const submit = (server) =>
    post(server, `/coins/rounds/${roundId}/submit`, {
      side: "YES",
      ceiling: "0.54",
      quantity: 10,
    });
  it("send a code and safe details with each refusal", async () => {
    for (const [error, status, body] of [
      [
        new CoinOperationError(
          "answers are paused while Yap Coins are topped up; nothing was reserved",
          503,
          "answers_paused",
        ),
        503,
        {
          error:
            "answers are paused while Yap Coins are topped up; nothing was reserved",
          code: "answers_paused",
        },
      ],
      [
        new CoinOperationError(
          "not enough Yap Coins",
          409,
          "insufficient_balance",
          { available: "25000000" },
        ),
        409,
        {
          available: "25000000",
          error: "not enough Yap Coins",
          code: "insufficient_balance",
        },
      ],
      [
        new CoinOperationError(
          "this turn's window closed",
          409,
          "window_closed",
        ),
        409,
        { error: "this turn's window closed", code: "window_closed" },
      ],
      [
        new CoinOperationError("sandbox debate uses unsupported terms", 503),
        503,
        { error: "sandbox debate uses unsupported terms" },
      ],
      [
        new SessionUnavailableError("account unavailable"),
        401,
        { error: "sign in again", code: "signed_out" },
      ],
    ]) {
      const { server } = app(
        {},
        {
          async submit() {
            throw error;
          },
        },
      );
      const response = await submit(server);
      assert.equal(response.status, status, error.message);
      assert.deepEqual(response.body, body);
    }
  });
  it("name a changed account context", async () => {
    const { server } = app();
    const response = await request(server)
      .post(`/coins/debates/${debateId}/rounds`)
      .set("Cookie", "session=synthetic-session")
      .set("Origin", origin)
      .set("Idempotency-Key", "key-1")
      .send({});
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "session_changed");
  });
});
