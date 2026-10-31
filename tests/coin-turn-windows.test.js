import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { createTurnWindowRouter } from "../dist/features/account-wallet/window-router.js";

// A pool that answers the coin loop's statements without a database: the
// sandbox rail matches and nothing is due. `fail` names steps whose
// statements throw, to check that one failing step never holds back another.
function pool(fail = new Set()) {
  const statements = [];
  const answer = (sql) => {
    statements.push(sql);
    if (fail.has("void") && sql.includes("r.debate_id=ANY($3::uuid[])"))
      throw new Error("void step failed");
    if (fail.has("open") && sql.includes("FROM debate_media m"))
      throw new Error("open step failed");
    if (sql.includes("FROM coin_sandbox_controls"))
      return { rows: [{ rail: "simulation" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return {
    statements,
    async query(sql) {
      return answer(sql);
    },
    async connect() {
      if (fail.has("settle")) throw new Error("settle step failed");
      return {
        async query(sql) {
          return answer(sql);
        },
        release() {},
      };
    },
  };
}

describe("coin loop step", () => {
  // A new turn's window opens before settlement, so a large reveal batch
  // never delays it (PR 2).
  it("voids, opens windows and then settles, in order", async () => {
    const database = pool();
    const loop = createCoinDebateSandbox(database, "simulation", {
      turnWindows: true,
    });
    assert.deepEqual(await loop.tick(), { voided: 0, completed: 0, opened: 0 });
    const order = [
      "r.debate_id=ANY($3::uuid[])",
      "FROM debate_media m",
      "WITH due AS",
    ].map((marker) =>
      database.statements.findIndex((sql) => sql.includes(marker)),
    );
    assert.ok(order.every((index) => index >= 0));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  it("skips window opening when turn windows are disabled", async () => {
    const database = pool();
    await createCoinDebateSandbox(database, "simulation").tick();
    assert.equal(
      database.statements.some((sql) => sql.includes("FROM debate_media m")),
      false,
    );
  });

  it("runs every step and reports one failure as itself", async () => {
    const loop = createCoinDebateSandbox(
      pool(new Set(["void"])),
      "simulation",
      {
        turnWindows: true,
      },
    );
    await assert.rejects(loop.tick(), /void step failed/);
  });

  it("aggregates several failing steps", async () => {
    const loop = createCoinDebateSandbox(
      pool(new Set(["void", "settle", "open"])),
      "simulation",
      { turnWindows: true },
    );
    await assert.rejects(loop.tick(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((e) => e.message),
        ["void step failed", "open step failed", "settle step failed"],
      );
      return true;
    });
  });
});

describe("public turn windows route", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  function app(publicWindows) {
    const server = express();
    server.use(createTurnWindowRouter({ publicWindows }));
    return server;
  }

  it("returns window timing without caching", async () => {
    const body = {
      debateId: id,
      eventStatus: "live",
      serverNow: "2026-10-25T00:00:00.000Z",
      windows: [],
    };
    const response = await request(app(async () => body)).get(
      `/api/public/debates/${id}/windows`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body, body);
  });

  it("answers 404 for an unknown or malformed debate", async () => {
    const server = app(async () => null);
    assert.equal(
      (await request(server).get(`/api/public/debates/${id}/windows`)).status,
      404,
    );
    assert.equal(
      (await request(server).get("/api/public/debates/not-a-uuid/windows"))
        .status,
      404,
    );
  });
});
