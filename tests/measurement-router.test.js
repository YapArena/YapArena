import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import {
  createProductActionRecorder,
  measurementCookie,
} from "../dist/features/measurement/router.js";
import { createLogger } from "../dist/platform/logger.js";

const id = "11111111-1111-4111-8111-111111111111";
const user = { id: "7", email: null, createdAt: new Date("2026-10-01") };

function fixture({
  roles = ["participant"],
  signedIn = true,
  missing = false,
} = {}) {
  const calls = [];
  const consents = new Set();
  const measurement = {
    grant: async (hash) => {
      consents.add(hash);
      calls.push(["grant", hash]);
    },
    hasConsent: async (hash) => consents.has(hash),
    withdraw: async (hash) => {
      consents.delete(hash);
      calls.push(["withdraw", hash]);
      return 1;
    },
    recordDiscovery: async (...args) => {
      calls.push(["discovery", ...args]);
      return !missing;
    },
    startWatch: async (...args) => {
      calls.push(["startWatch", ...args]);
      return !missing;
    },
    progressWatch: async (...args) => {
      calls.push(["progressWatch", ...args]);
      return !missing;
    },
    recordAction: async (...args) => {
      calls.push(["action", ...args]);
      return true;
    },
    summary: async () => ({
      windowDays: 28,
      events: [
        { eventType: "discovery_view", affiliation: "independent", count: 2 },
      ],
      watch: [
        {
          mode: "live",
          affiliation: "independent",
          sessions: 1,
          watchedSeconds: 90,
        },
      ],
    }),
    listAffiliations: async () => [],
    setAffiliation: async (...args) => {
      calls.push(["affiliation", ...args]);
      return !missing;
    },
  };
  const app = createApp({
    measurement,
    identity: { getRoles: async () => roles },
    sessions: {
      findUserByTokenHash: async () => (signedIn ? user : null),
    },
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
  });
  return { app, calls, consents };
}

describe("product measurement API", () => {
  it("caps new consents per network but answers a returning browser (YA-14)", async () => {
    const { app } = fixture();
    const returning = request.agent(app);
    const consent = (client) =>
      client.post("/api/measurement/consent").send({ consent: true });
    assert.equal((await consent(returning)).status, 201);
    for (let i = 1; i < 60; i++)
      assert.equal((await consent(request(app))).status, 201);
    const capped = await consent(request(app));
    assert.equal(capped.status, 429);
    // A browser that already consented is answered without a new row.
    const again = await consent(returning);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { consented: true });
  });

  it("requires explicit consent and deletes consented data on withdrawal", async () => {
    const { app, calls, consents } = fixture();
    const agent = request.agent(app);
    assert.equal(
      (await agent.get("/api/measurement/consent")).body.consented,
      false,
    );
    assert.equal(
      (await agent.post("/api/measurement/discovery").send({ surface: "home" }))
        .status,
      403,
    );
    assert.equal(
      (await agent.post("/api/measurement/consent").send({ consent: false }))
        .status,
      400,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/consent")
          .send({ consent: true, extra: 1 })
      ).status,
      400,
    );
    const granted = await agent
      .post("/api/measurement/consent")
      .send({ consent: true });
    assert.equal(granted.status, 201);
    assert.match(granted.headers["set-cookie"][0], /HttpOnly/);
    assert.equal(consents.size, 1);
    assert.equal(
      (await agent.get("/api/measurement/consent")).body.consented,
      true,
    );
    assert.equal(
      (await agent.post("/api/measurement/consent").send({ consent: true }))
        .status,
      200,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/discovery")
          .send({ surface: "debate", id })
      ).status,
      204,
    );
    assert.deepEqual(calls.find((call) => call[0] === "discovery").slice(2), [
      null,
      "debate",
      id,
    ]);
    const consentCookie = granted.headers["set-cookie"][0].split(";")[0];
    assert.equal(
      (
        await request(app)
          .post("/api/measurement/discovery")
          .set("Cookie", [consentCookie, "session=test"])
          .send({ surface: "topic", id })
      ).status,
      204,
    );
    assert.equal(calls.at(-1)[2], "7");
    assert.equal((await agent.delete("/api/measurement/consent")).status, 200);
    assert.equal(consents.size, 0);
    assert.equal(
      (await agent.get("/api/measurement/consent")).body.consented,
      false,
    );
    assert.equal(
      (await agent.post("/api/measurement/discovery").send({ surface: "home" }))
        .status,
      403,
    );
  });

  it("uses a host-only secure cookie name in production", () => {
    assert.equal(measurementCookie("production"), "__Host-measurement");
    assert.equal(measurementCookie("development"), "measurement");
  });

  it("validates browser events and bounds watch phases to a consented session", async () => {
    const { app, calls } = fixture({ signedIn: false });
    const agent = request.agent(app);
    await agent.post("/api/measurement/consent").send({ consent: true });
    assert.equal(
      (await agent.post("/api/measurement/discovery").send({ surface: "bad" }))
        .status,
      400,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/discovery")
          .send({ surface: "home", extra: "raw data" })
      ).status,
      400,
    );
    assert.equal(
      (
        await agent.post("/api/measurement/watch").send({
          sessionId: "bad",
          debateId: id,
          mode: "live",
          phase: "start",
        })
      ).status,
      400,
    );
    const sessionId = "22222222-2222-4222-8222-222222222222";
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ sessionId, debateId: id, mode: "live", phase: "start" })
      ).status,
      204,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ sessionId, debateId: id, mode: "live", phase: "progress" })
      ).status,
      204,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ sessionId, debateId: id, mode: "live", phase: "end" })
      ).status,
      204,
    );
    assert.equal(calls.filter((call) => call[0] === "startWatch").length, 1);
    assert.equal(calls.filter((call) => call[0] === "progressWatch").length, 2);
  });

  it("restricts aggregate dashboards and affiliation reviews to operators", async () => {
    const guest = fixture({ signedIn: false, roles: ["operator"] });
    assert.equal((await request(guest.app).get("/measurement")).status, 401);
    const participant = fixture();
    assert.equal(
      (
        await request(participant.app)
          .get("/api/measurement/dashboard")
          .set("Cookie", "session=test")
      ).status,
      403,
    );
    assert.equal(
      (
        await request(participant.app)
          .put("/api/measurement/affiliations")
          .set("Cookie", "session=test")
          .send({
            handle: "alice",
            affiliation: "founder",
            reason: "Founding team account",
          })
      ).status,
      403,
    );
    const { app, calls } = fixture({ roles: ["operator"] });
    assert.equal(
      (await request(app).get("/measurement").set("Cookie", "session=test"))
        .status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/measurement/dashboard")
          .set("Cookie", "session=test")
      ).body.events[0].count,
      2,
    );
    assert.equal(
      (
        await request(app)
          .put("/api/measurement/affiliations")
          .set("Cookie", "session=test")
          .send({
            handle: "alice",
            affiliation: "unknown",
            reason: "Not reviewed yet",
          })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .put("/api/measurement/affiliations")
          .set("Cookie", "session=test")
          .send({
            handle: "alice",
            affiliation: "founder",
            reason: "Founding team account",
          })
      ).status,
      200,
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "affiliation"),
      ["affiliation", "alice", "founder", "Founding team account", "7"],
    );
  });

  it("records only successful, consented account actions and isolates telemetry failure", async () => {
    const calls = [];
    const token = "a".repeat(64);
    const recorder = createProductActionRecorder({
      measurement: {
        recordAction: async (...args) => {
          calls.push(args);
          throw new Error("telemetry unavailable");
        },
      },
      environment: "development",
    });
    const requestLike = {
      cookies: { measurement: token },
      user,
      log: { warn: () => {} },
    };
    await recorder(requestLike, { type: "match_accepted", debateId: id });
    assert.equal(calls[0][0], createHash("sha256").update(token).digest("hex"));
    assert.equal(calls[0][1], "7");
    await recorder(
      { ...requestLike, cookies: {} },
      { type: "match_accepted", debateId: id },
    );
    await recorder(
      { ...requestLike, user: undefined },
      { type: "match_accepted", debateId: id },
    );
    assert.equal(calls.length, 1);
  });

  it("rejects malformed targets and reports unavailable sessions and affiliation profiles", async () => {
    const { app } = fixture({ roles: ["operator"], missing: true });
    const agent = request.agent(app);
    await agent.post("/api/measurement/consent").send({ consent: true });
    for (const body of [
      { surface: "debate", id: "wrong" },
      { surface: 1 },
      { surface: "home", id: 7 },
    ])
      assert.equal(
        (await agent.post("/api/measurement/discovery").send(body)).status,
        400,
      );
    assert.equal(
      (await agent.post("/api/measurement/discovery").send({ surface: "home" }))
        .status,
      404,
    );
    const watch = { sessionId: id, debateId: id, mode: "live", phase: "start" };
    assert.equal(
      (await agent.post("/api/measurement/watch").send(watch)).status,
      404,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ ...watch, phase: "end" })
      ).status,
      404,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ ...watch, mode: "other" })
      ).status,
      400,
    );
    assert.equal(
      (
        await agent
          .post("/api/measurement/watch")
          .send({ ...watch, phase: "other" })
      ).status,
      400,
    );
    assert.equal(
      (await agent.post("/api/measurement/watch").send({ ...watch, extra: 1 }))
        .status,
      400,
    );
    assert.equal(
      (
        await agent
          .get("/api/measurement/affiliations")
          .set("Cookie", "session=test")
      ).status,
      200,
    );
    assert.equal(
      (
        await agent
          .put("/api/measurement/affiliations")
          .set("Cookie", "session=test")
          .send({
            handle: "alice",
            affiliation: "independent",
            reason: "Reviewed non-founder account",
          })
      ).status,
      404,
    );
    assert.equal(
      (
        await agent
          .put("/api/measurement/affiliations")
          .set("Cookie", "session=test")
          .send({
            handle: "alice",
            affiliation: "independent",
            reason: "short",
          })
      ).status,
      400,
    );
  });
});
