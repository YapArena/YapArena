import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createChatState,
  compareIds,
  recoverDraft,
  shouldSendOnEnter,
} from "../public/community-state.js";
import { api, CommunityApiError } from "../public/community-transport.js";

const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const message = {
  id: "9007199254740993",
  clientMessageId: key,
  body: "Hello",
  state: "visible",
  revision: "0",
  createdAt: "2026-10-06T12:00:00Z",
};

describe("chat submission state", () => {
  for (const first of ["post", "feed"])
    it(`reconciles ${first}-first delivery, repeats, and late failures once`, () => {
      const state = createChatState();
      const record = state.begin(" Hello ", key, message.createdAt);
      assert.ok(Object.isFrozen(record.submission));
      assert.equal(state.receive(message, first).confirmedNow, true);
      assert.equal(
        state.receive(message, first === "post" ? "feed" : "post").confirmedNow,
        false,
      );
      assert.equal(state.receive(message).inserted, false);
      assert.equal(
        state.fail(record, 1, { status: 0, message: "lost" }),
        false,
      );
      assert.equal(record.state, "confirmed");
      assert.equal(record.serverId, message.id);
      assert.equal(state.server.size, 1);
      assert.equal(state.cursor, "0");
      state.advance([message]);
      state.advance([{ id: "9007199254740992" }]);
      assert.equal(state.cursor, message.id);
      assert.equal(compareIds("9007199254740992", message.id), -1);
      assert.equal(compareIds(message.id, message.id), 0);
    });

  it("keeps uncertain deliveries recoverable, retries the immutable payload, and confirms a lost commit", () => {
    const state = createChatState();
    assert.equal(state.begin(" ", key), null);
    assert.equal(state.begin("x".repeat(501), key), null);
    const record = state.begin("Hello", key, message.createdAt);
    assert.equal(state.retry(record), null);
    assert.equal(
      state.fail(record, 1, { status: 0, message: "offline" }),
      true,
    );
    assert.equal(record.state, "unconfirmed");
    assert.equal(recoverDraft("New draft", record), "New draft\nHello");
    assert.equal(recoverDraft("", record), "Hello");
    assert.equal(state.retry(record), 2);
    assert.equal(
      state.fail(record, 1, { status: 403, message: "stale" }),
      false,
    );
    assert.equal(record.submission.clientMessageId, key);
    assert.equal(record.submission.body, "Hello");
    state.fail(record, 2, { status: 503, message: "uncertain" });
    assert.equal(record.state, "unconfirmed");
    state.receive(message);
    assert.equal(record.state, "confirmed");
    assert.equal(state.retry(record), null);
    state.forget(message.id);
    assert.equal(state.server.size, 1);
    const edited = state.begin("Hello edited", "new-key", message.createdAt);
    assert.notEqual(edited.submission.clientMessageId, key);
  });

  it("distinguishes rejected, cooldown, and ambiguous errors without automatic sending", () => {
    for (const [status, expected] of [
      [401, "rejected"],
      [403, "rejected"],
      [400, "rejected"],
      [409, "rejected"],
      [429, "cooldown"],
      [408, "unconfirmed"],
      [500, "unconfirmed"],
    ]) {
      const state = createChatState();
      const record = state.begin("Hello", key);
      state.fail(record, 1, { status, message: "failure" });
      assert.equal(record.state, expected);
      assert.equal(record.attempt, 1);
    }
  });

  it("gives moderation precedence over delayed acknowledgments and permits versioned restoration", () => {
    const state = createChatState();
    const record = state.begin("Hello", key);
    state.receive(message);
    state.receive({
      ...message,
      state: "removed",
      body: "Never display",
      revision: "1",
    });
    assert.equal(state.server.get(message.id).item.body, null);
    assert.equal(state.receive(message, "post").changed, false);
    assert.equal(state.receive({ ...message, revision: "1" }).changed, false);
    assert.equal(record.state, "removed");
    assert.equal(state.retry(record), null);
    state.receive({ ...message, revision: "2" });
    assert.equal(record.state, "confirmed");
    state.missing(message.id);
    assert.equal(
      state.receive({ ...message, revision: "2" }, "post").changed,
      false,
    );
    state.missing("unknown");
    const remote = { ...message, id: "8", clientMessageId: null };
    assert.equal(state.receive(remote).inserted, true);
    state.forget("8");
    assert.equal(state.server.has("8"), false);
    for (const invalid of [
      {},
      { ...message, id: 1 },
      { ...message, revision: null },
      { ...message, state: "bad" },
    ])
      assert.throws(() => state.receive(invalid), /unconfirmed/);
  });

  it("keeps unresolved submissions during eviction and releases settled confirmations", () => {
    const state = createChatState();
    const record = state.begin("Hello", key);
    state.receive({ ...message, clientMessageId: null });
    assert.equal(state.receive(message, "post").confirmedNow, true);
    assert.equal(state.server.size, 1);
    state.forget(message.id);
    assert.equal(
      state.submissions.size,
      1,
      "an in-flight response still needs moderation precedence",
    );
    record.settled = true;
    state.forget(message.id);
    assert.equal(state.server.size, 0);
    assert.equal(state.submissions.size, 0);
    const failed = state.begin("recover me", "recover-key");
    state.fail(failed, 1, { status: 0, message: "offline" });
    failed.settled = true;
    assert.equal(
      state.submissions.get("recover-key").submission.body,
      "recover me",
    );
  });

  it("protects moderated tombstones during outstanding requests and binds a stale owner acknowledgment", () => {
    const state = createChatState();
    const record = state.begin("Hello", key);
    const finishPost = state.beginRequest();
    const finishHistory = state.beginRequest();
    state.receive({
      ...message,
      clientMessageId: null,
      state: "removed",
      revision: "1",
      body: null,
    });
    state.forget(message.id);
    finishHistory();
    finishHistory();
    assert.equal(state.server.has(message.id), true);
    const ack = state.receive(message, "post");
    assert.equal(ack.changed, true);
    assert.equal(ack.item.body, null);
    assert.equal(record.state, "removed");
    assert.equal(record.serverId, message.id);
    record.settled = true;
    finishPost();
    state.forget(message.id);
    assert.equal(state.server.has(message.id), false);
    const finishRead = state.beginRequest();
    state.receive({
      ...message,
      clientMessageId: null,
      state: "removed",
      revision: "3",
      body: null,
    });
    state.forget(message.id);
    finishRead();
    assert.equal(
      state.server.has(message.id),
      false,
      "unwatched tombstones expire only after old responses settle",
    );
  });

  it("supports Enter, Shift+Enter, and composition guards", () => {
    assert.equal(shouldSendOnEnter({ key: "Enter" }, false), true);
    for (const event of [
      { key: "a" },
      { key: "Enter", shiftKey: true },
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
    ])
      assert.equal(shouldSendOnEnter(event, false), false);
    assert.equal(shouldSendOnEnter({ key: "Enter" }, true), false);
  });
});

describe("chat transport", () => {
  it("preserves HTTP status, machine codes, and retry timing, including invalid bodies", async (context) => {
    const mockFetch = context.mock.method(globalThis, "fetch");
    mockFetch.mock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: "quota",
            code: "CHAT_HOURLY_LIMIT",
            retryAfterSeconds: 200,
          }),
          { status: 429, headers: { "Retry-After": "200" } },
        ),
    );
    await assert.rejects(
      api("/test"),
      (error) =>
        error.status === 429 &&
        error.code === "CHAT_HOURLY_LIMIT" &&
        error.retryAfterSeconds === 200,
    );
    mockFetch.mock.mockImplementation(
      async () => new Response("invalid", { status: 401 }),
    );
    await assert.rejects(
      api("/test"),
      (error) => error.status === 401 && /Sign in/.test(error.message),
    );
    mockFetch.mock.mockImplementation(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "10" } }),
    );
    await assert.rejects(
      api("/test"),
      (error) => error.retryAfterSeconds === 10,
    );
    mockFetch.mock.mockImplementation(
      async () => new Response("{}", { status: 503 }),
    );
    await assert.rejects(api("/test"), (error) => error.status === 503);
    mockFetch.mock.mockImplementation(async () => {
      throw new Error("offline");
    });
    await assert.rejects(
      api("/test"),
      (error) => error instanceof CommunityApiError && error.status === 0,
    );
    mockFetch.mock.mockImplementation(async () => new Response('{"ok":true}'));
    assert.deepEqual(await api("/test"), { ok: true });
  });
  it("aborts timed-out requests as uncertain delivery", async (context) => {
    context.mock.method(globalThis, "setTimeout", (callback) => {
      queueMicrotask(callback);
      return 0;
    });
    context.mock.method(
      globalThis,
      "fetch",
      async (_path, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        ),
    );
    await assert.rejects(
      api("/test", { method: "POST" }),
      (error) => error.status === 0 && error.code === "DELIVERY_UNCONFIRMED",
    );
  });
});
