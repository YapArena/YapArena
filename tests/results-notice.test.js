import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";

// Interface 10: the signed-in results read behind the in-app results notice.

describe("results route", () => {
  function app() {
    const calls = [];
    const server = express();
    server.use(cookieParser());
    server.use((req, _res, next) => {
      req.user = { id: "7" };
      next();
    });
    server.use(
      createCoinSandboxRouter({
        sandbox: {},
        debates: {
          async results(context, since) {
            calls.push([context.userId, since]);
            return { serverNow: new Date(0), results: [] };
          },
        },
        operations: {},
        environment: "test",
        applicationOrigin: "http://app.test",
      }),
    );
    const get = (query = "") =>
      request(server).get(`/results${query}`).set("Cookie", "session=token");
    return { get, calls };
  }

  it("reads the viewer's results since a time, privately", async () => {
    const { get, calls } = app();
    const all = await get();
    assert.equal(all.status, 200);
    assert.equal(all.headers["cache-control"], "private, no-store");
    assert.equal(calls[0][0], "7");
    assert.equal(calls[0][1].getTime(), 0);
    await get("?since=2026-10-26T05:00:00.000Z");
    assert.equal(calls[1][1].toISOString(), "2026-10-26T05:00:00.000Z");
  });

  it("refuses a since that is not an ISO time", async () => {
    const { get, calls } = app();
    for (const since of ["yesterday", "2026-10-26", "2026-13-40T99:99:99Z"])
      assert.equal(
        (await get(`?since=${encodeURIComponent(since)}`)).status,
        400,
        since,
      );
    assert.equal((await get("?since=a&since=b")).status, 400);
    assert.equal(calls.length, 0);
  });
});
