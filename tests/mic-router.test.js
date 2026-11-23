import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "../scripts/test-http-request.ts";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { createMicRouter } from "../dist/features/mic/router.js";
import { MicError } from "../dist/features/mic/rules.js";
import { CoinOperationError } from "../dist/features/account-wallet/external-operations.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";

// Decision 0018, PR 2a: the mic's routes, with a stubbed repository.
const origin = "https://arena.example";
const debateId = "33333333-3333-4333-8333-333333333333";
const questionId = "44444444-4444-4444-8444-444444444444";
const pledgeId = "55555555-5555-4555-8555-555555555555";
const list = { debateId, list: null, mics: [] };

function stub(overrides = {}) {
  const calls = [];
  const record =
    (name, value) =>
    async (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  return {
    calls,
    mic: {
      read: record("read", list),
      submitQuestion: record("submitQuestion", {
        questionId,
        pledgeId,
        created: true,
      }),
      pledge: record("pledge", { questionId, pledgeId, created: true }),
      withdraw: record("withdraw", { pledgeId, created: true }),
      fire: record("fire", { micId: pledgeId, state: "live", created: true }),
      ...overrides,
    },
  };
}
function app(mic, { signedIn = true, turns } = {}) {
  const server = express();
  server.use(express.json(), cookieParser());
  server.use(
    createMicRouter({
      mic,
      turns,
      requireAuth: (req, res, next) => {
        if (!signedIn)
          return res.status(401).json({ error: "authentication required" });
        req.user = { id: "7" };
        next();
      },
      environment: "test",
      applicationOrigin: origin,
    }),
  );
  // Anything the router passes on is the application's 500.
  server.use((_error, _req, res, _next) => {
    void _next;
    return res.status(500).json({ error: "internal error" });
  });
  return server;
}
const write = (server, method, path, body) => {
  const test = request(server)
    [method](path)
    .set("Cookie", "session=synthetic-session")
    .set("Origin", origin)
    .set("X-YapArena-Session", "9");
  return body === undefined ? test : test.send(body);
};
const questions = `/api/debates/${debateId}/mic/questions`;
const pledges = `${questions}/${questionId}/pledges`;
const firing = `${questions}/${questionId}/fire`;
const withdrawal = `/api/debates/${debateId}/mic/pledges/${pledgeId}`;

describe("the mic switch", () => {
  const logger = createLogger({ enabled: false });
  const base = {
    messages: { isReady: async () => {}, list: async () => [] },
    database: { query: async () => ({ rows: [] }) },
    users: { create: async () => ({}), findByEmail: async () => null },
    sessions: {
      create: async () => ({}),
      findUserByTokenHash: async () => ({ id: "7" }),
      deleteByTokenHash: async () => false,
    },
    logger,
  };

  it("leaves every mic route unmounted when MIC_ENABLED is off", async () => {
    const { mic, calls } = stub();
    const off = createApp(base);
    assert.equal(
      (await request(off).get(`/api/debates/${debateId}/mic`)).status,
      404,
    );
    for (const [method, path, body] of [
      ["post", questions, { target: "A", text: "Why?", wager: 1 }],
      ["post", pledges, { amount: 1, requestId: "r" }],
      ["post", firing, { requestId: "r" }],
      ["delete", withdrawal],
    ])
      assert.equal(
        (await write(off, method, path, body)).status,
        404,
        `${method} ${path}`,
      );
    assert.deepEqual(calls, []);
    const on = createApp({ ...base, mic });
    const response = await request(on).get(`/api/debates/${debateId}/mic`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, list);
  });
});

describe("the mic routes", () => {
  it("serve the public list without signing in, and 404 an unknown debate", async () => {
    const { mic, calls } = stub();
    const server = app(mic, { signedIn: false });
    const response = await request(server).get(`/api/debates/${debateId}/mic`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body, list);
    assert.equal(
      (await request(server).get("/api/debates/not-a-debate/mic")).status,
      404,
    );
    const missing = app(stub({ read: async () => null }).mic);
    assert.equal(
      (await request(missing).get(`/api/debates/${debateId}/mic`)).status,
      404,
    );
    assert.deepEqual(calls, [["read", debateId]]);
  });

  it("require a signed-in account, this origin and the current session for writes", async () => {
    const { mic, calls } = stub();
    assert.equal(
      (
        await write(app(mic, { signedIn: false }), "post", firing, {
          requestId: "r",
        })
      ).status,
      401,
    );
    const server = app(mic);
    const foreign = await request(server)
      .post(firing)
      .set("Origin", "https://elsewhere.example")
      .set("X-YapArena-Session", "9")
      .send({ requestId: "r" });
    assert.equal(foreign.status, 403);
    const stale = await request(server)
      .post(firing)
      .set("Origin", origin)
      .send({ requestId: "r" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "session_changed");
    assert.deepEqual(calls, []);
  });

  it("pass whole Yap Coins as atoms with the caller's session", async () => {
    const { mic, calls } = stub();
    const server = app(mic);
    const submitted = await write(server, "post", questions, {
      target: "B",
      text: "Why now?",
      wager: 3,
      requestId: "q-1",
    });
    assert.equal(submitted.status, 201);
    assert.deepEqual(submitted.body, { questionId, pledgeId, created: true });
    assert.equal(
      (
        await write(server, "post", pledges, {
          amount: 2,
          add: "Answer this",
          requestId: "p-1",
        })
      ).status,
      201,
    );
    assert.equal(
      (await write(server, "post", pledges, { amount: 1, requestId: "p-2" }))
        .status,
      201,
    );
    assert.equal((await write(server, "delete", withdrawal)).status, 200);
    assert.equal(
      (await write(server, "post", firing, { requestId: "f-1" })).status,
      201,
    );
    const context = {
      userId: "7",
      sessionTokenHash: calls[0][1].sessionTokenHash,
      expectedSessionId: "9",
    };
    assert.match(context.sessionTokenHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls, [
      [
        "submitQuestion",
        context,
        debateId,
        { target: "B", text: "Why now?", wager: 30000n, requestId: "q-1" },
      ],
      [
        "pledge",
        context,
        debateId,
        questionId,
        { amount: 20000n, add: "Answer this", requestId: "p-1" },
      ],
      [
        "pledge",
        context,
        debateId,
        questionId,
        { amount: 10000n, add: null, requestId: "p-2" },
      ],
      ["withdraw", context, debateId, pledgeId],
      ["fire", context, debateId, questionId, "f-1"],
    ]);
  });

  it("refuse malformed requests before reaching the repository", async () => {
    const { mic, calls } = stub();
    const server = app(mic);
    for (const [method, path, body, status] of [
      ["post", questions, { target: "C", text: "x", wager: 1, requestId: "r" }],
      ["post", questions, { target: "A", text: 5, wager: 1, requestId: "r" }],
      [
        "post",
        questions,
        { target: "A", text: "x", wager: 1.5, requestId: "r" },
      ],
      [
        "post",
        questions,
        { target: "A", text: "x", wager: "1", requestId: "r" },
      ],
      ["post", questions, { target: "A", text: "x", wager: 0, requestId: "r" }],
      ["post", questions, { target: "A", text: "x", wager: 1 }],
      ["post", questions, { target: "A", text: "x", wager: 1, requestId: "" }],
      [
        "post",
        questions,
        { target: "A", text: "x", wager: 1, requestId: "r", extra: true },
      ],
      ["post", pledges, { amount: -1, requestId: "r" }],
      ["post", pledges, { amount: 1, add: 7, requestId: "r" }],
      ["post", pledges, { amount: 1, requestId: "x".repeat(201) }],
      ["post", firing, {}],
      ["post", firing, ["r"]],
      [
        "post",
        `/api/debates/${debateId}/mic/questions/nope/fire`,
        { requestId: "r" },
        404,
      ],
      ["delete", `/api/debates/${debateId}/mic/pledges/nope`, undefined, 404],
      ["post", "/api/debates/nope/mic/questions", { requestId: "r" }, 404],
    ]) {
      const response = await write(server, method, path, body);
      assert.equal(response.status, status ?? 400, JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  it("map the rules', the ledger's and the session's refusals to statuses", async () => {
    const cases = [
      [new MicError("only the camp's #1 can fire"), 409, {}],
      [new MicError("join the live debate first", 403), 403, {}],
      [new MicError("nothing to withdraw", 404), 404, {}],
      [
        new CoinOperationError(
          "insufficient Yap Coins for this pledge",
          409,
          "insufficient_balance",
        ),
        409,
        { code: "insufficient_balance" },
      ],
      [
        new CoinOperationError("Yap Coins are busy", 503, "busy"),
        503,
        { code: "busy" },
      ],
      [
        new SessionUnavailableError("session is unavailable"),
        401,
        { code: "signed_out" },
      ],
    ];
    for (const [error, status, extra] of cases) {
      const fail = async () => {
        throw error;
      };
      const server = app(stub({ fire: fail }).mic);
      const response = await write(server, "post", firing, { requestId: "r" });
      assert.equal(response.status, status, error.message);
      for (const [key, value] of Object.entries(extra))
        assert.equal(response.body[key], value);
      assert.equal(typeof response.body.error, "string");
    }
    const crash = app(
      stub({
        fire: async () => {
          throw new Error("boom");
        },
      }).mic,
    );
    assert.equal(
      (await write(crash, "post", firing, { requestId: "r" })).status,
      500,
    );
  });
});

// Decision 0018, PR 2b: the asker's own turn controls.
describe("the asker's turn routes", () => {
  const turn = `/api/debates/${debateId}/mic/turn`;
  const text = `${turn}/text`;
  function turns(overrides = {}) {
    const calls = [];
    return {
      calls,
      turns: {
        endAskerTurn: async (...args) => {
          calls.push(["endAskerTurn", ...args]);
          return { ended: false, side: "A" };
        },
        setAskerText: async (...args) => {
          calls.push(["setAskerText", ...args]);
          return { turnNumber: 8, text: args[2].trim() };
        },
        ...overrides,
      },
    };
  }

  it("stay unmounted without the turn engine", async () => {
    const server = app(stub().mic);
    assert.equal(
      (await write(server, "post", turn, { action: "end" })).status,
      404,
    );
    assert.equal(
      (await write(server, "post", text, { text: "Why?" })).status,
      404,
    );
  });

  it("end the asker's turn and show their text, with the caller's session", async () => {
    const { turns: engine, calls } = turns();
    const server = app(stub().mic, { turns: engine });
    const ended = await write(server, "post", turn, { action: "end" });
    assert.equal(ended.status, 200);
    assert.deepEqual(ended.body, { ended: false, side: "A" });
    const shown = await write(server, "post", text, { text: " Why now? " });
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body, { turnNumber: 8, text: "Why now?" });
    const context = {
      userId: "7",
      sessionTokenHash: calls[0][1].sessionTokenHash,
      expectedSessionId: "9",
    };
    assert.deepEqual(calls, [
      ["endAskerTurn", context, debateId],
      ["setAskerText", context, debateId, " Why now? "],
    ]);
  });

  it("refuse other requests, other origins and signed-out callers", async () => {
    const { turns: engine, calls } = turns();
    const server = app(stub().mic, { turns: engine });
    for (const [path, body, status] of [
      [turn, { action: "pass" }, 400],
      [turn, {}, 400],
      [turn, { action: "end", extra: 1 }, 400],
      [text, { text: 5 }, 400],
      [text, {}, 400],
      [`/api/debates/nope/mic/turn`, { action: "end" }, 404],
    ])
      assert.equal(
        (await write(server, "post", path, body)).status,
        status,
        JSON.stringify(body),
      );
    const foreign = await request(server)
      .post(turn)
      .set("Origin", "https://elsewhere.example")
      .set("X-YapArena-Session", "9")
      .send({ action: "end" });
    assert.equal(foreign.status, 403);
    assert.equal(
      (
        await write(
          app(stub().mic, { turns: engine, signedIn: false }),
          "post",
          text,
          {
            text: "Why?",
          },
        )
      ).status,
      401,
    );
    assert.deepEqual(calls, []);
    const refused = app(stub().mic, {
      turns: turns({
        endAskerTurn: async () => {
          throw new MicError("only the asker can do this in their turn", 403);
        },
      }).turns,
    });
    assert.equal(
      (await write(refused, "post", turn, { action: "end" })).status,
      403,
    );
  });
});
