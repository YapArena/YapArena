import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";

import { createMatchingRouter } from "../dist/features/matching/router.js";
import {
  MatchConflictError,
  MatchNotFoundError,
  notifyStartingMessage,
} from "../dist/features/matching/repository.js";
import { renderDebate } from "../dist/features/discovery/web.js";
import { renderPrivacy } from "../dist/features/discovery/legal-web.js";
import {
  notifyEndpoint,
  notifyError,
  notifyFailure,
  notifyLabel,
  notifyMessage,
  untilStart,
} from "../public/debate-notify-logic.js";
import { connectDebateNotify } from "../public/debate-notify.js";
import { FakeElement } from "./helpers/fake-dom.js";
import { debate, origin } from "./page-fixtures.js";

// "Notify me" on a scheduled debate (first-run build plan PR 9).
const id = "11111111-1111-4111-8111-111111111111";

describe("notify-me routes", () => {
  function fixture({
    liveQueue = true,
    roles = ["participant"],
    restricted = false,
    outcome = "created",
  } = {}) {
    const calls = [];
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: "7" };
      next();
    });
    app.use(
      "/api/matching",
      createMatchingRouter({
        liveQueue,
        identity: {
          getRoles: async () => roles,
          restriction: async () =>
            restricted ? { expiresAt: new Date("2026-12-01") } : null,
        },
        matching: {
          isNotifying: async (userId, debateId) => {
            calls.push(["read", userId, debateId]);
            return true;
          },
          requestNotify: async (userId, debateId) => {
            calls.push(["add", userId, debateId]);
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
          cancelNotify: async (userId, debateId) => {
            calls.push(["remove", userId, debateId]);
          },
        },
      }),
    );
    const path = `/api/matching/events/${id}/notify`;
    return { app, calls, path };
  }

  it("reads, saves and removes the signed-in account's own request", async () => {
    const { app, calls, path } = fixture();
    const read = await request(app).get(path);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { notifying: true });
    assert.equal(read.headers["cache-control"], "no-store");
    assert.equal((await request(app).put(path)).status, 201);
    assert.equal((await request(app).delete(path)).status, 204);
    assert.deepEqual(calls, [
      ["read", "7", id],
      ["add", "7", id],
      ["remove", "7", id],
    ]);
    assert.equal(
      (await request(fixture({ outcome: "exists" }).app).put(path)).status,
      204,
    );
  });

  it("refuses a missing, started or soon-starting debate with the reason", async () => {
    const missing = fixture({
      outcome: new MatchNotFoundError("event not found"),
    });
    assert.equal((await request(missing.app).put(missing.path)).status, 404);
    const soon = fixture({
      outcome: new MatchConflictError("This debate starts in a few minutes."),
    });
    const refused = await request(soon.app).put(soon.path);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "This debate starts in a few minutes.");
  });

  it("keeps the follow rules: participant to change, unrestricted to add", async () => {
    const restricted = fixture({ restricted: true });
    const refused = await request(restricted.app).put(restricted.path);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "account_restricted");
    // A restricted account can still read and remove its request.
    assert.equal(
      (await request(restricted.app).get(restricted.path)).status,
      200,
    );
    assert.equal(
      (await request(restricted.app).delete(restricted.path)).status,
      204,
    );
    const viewer = fixture({ roles: [] });
    assert.equal((await request(viewer.app).get(viewer.path)).status, 200);
    for (const method of ["put", "delete"])
      assert.equal(
        (await request(viewer.app)[method](viewer.path)).status,
        403,
      );
    assert.deepEqual(
      viewer.calls.map(([kind]) => kind),
      ["read"],
    );
  });

  it("accepts only event ids and exists only while the live queue runs", async () => {
    const { app, calls } = fixture();
    for (const method of ["get", "put", "delete"])
      assert.equal(
        (await request(app)[method]("/api/matching/events/not-an-id/notify"))
          .status,
        404,
      );
    assert.deepEqual(calls, []);
    const off = fixture({ liveQueue: false });
    for (const method of ["get", "put", "delete"])
      assert.equal((await request(off.app)[method](off.path)).status, 404);
    assert.deepEqual(off.calls, []);
  });
});

describe("notify-me notice", () => {
  it("names the debate and fits the notification column", () => {
    assert.equal(
      notifyStartingMessage("Cities should ban cars"),
      "A debate you asked to be notified about starts in a few minutes: “Cities should ban cars”",
    );
    const long = notifyStartingMessage("x".repeat(240));
    assert.equal(long.length, 240);
    assert.ok(long.endsWith("…”"));
    assert.ok(notifyStartingMessage("y".repeat(175)).length <= 240);
  });
});

describe("notify-me button markup", () => {
  const button = /<button[^>]*data-debate-notify="([^"]+)"[^>]*>/;
  it("appears on upcoming public debates while the live queue runs", () => {
    for (const status of ["scheduled", "ready"]) {
      const page = renderDebate(
        origin,
        { ...debate, status },
        false,
        null,
        true,
      );
      const markup = page.match(button);
      assert.ok(markup, status);
      assert.equal(markup[1], debate.id);
      assert.match(markup[0], /data-starts-at="2026-10-01T17:00:00.000Z"/);
      assert.match(markup[0], /aria-pressed="false"/);
      assert.match(page, /<span data-debate-notify-label>Notify me<\/span>/);
      assert.match(
        page,
        /<p class="arena-notify-status" data-debate-notify-status role="status" aria-live="polite"><\/p>/,
      );
      assert.match(
        page,
        /<script type="module" src="\/assets\/debate-notify\.js/,
      );
    }
  });

  it("stays off for started, demo and unscheduled debates, and without the live queue", () => {
    for (const page of [
      renderDebate(origin, debate, false, null, false),
      ...["live", "replay", "finalized", "cancelled", "ended"].map((status) =>
        renderDebate(origin, { ...debate, status }, false, null, true),
      ),
      renderDebate(origin, { ...debate, isDemo: true }, false, null, true),
      renderDebate(origin, { ...debate, scheduledAt: null }, false, null, true),
    ]) {
      assert.doesNotMatch(page, /data-debate-notify/);
      assert.doesNotMatch(page, /debate-notify\.js/);
    }
  });
});

describe("privacy policy", () => {
  it("lists the debates people ask to be notified about", () => {
    assert.match(
      renderPrivacy(origin),
      /the topics and people you follow, the debates you ask to be notified about, and the challenges/,
    );
  });
});

describe("notify-me button logic", () => {
  it("names the endpoint, the states and the messages", () => {
    assert.equal(notifyEndpoint(id), `/api/matching/events/${id}/notify`);
    assert.equal(notifyLabel(false), "Notify me");
    assert.equal(notifyLabel(true), "Notifying you");
    assert.match(notifyMessage(true), /a few minutes before it starts/);
    assert.match(notifyMessage(false), /won’t get a notice/);
    assert.equal(
      notifyError({ error: "This debate starts in a few minutes." }),
      "This debate starts in a few minutes.",
    );
    for (const body of [null, {}, { error: "" }, { error: 4 }, "text"])
      assert.equal(notifyError(body), notifyFailure);
  });

  it("counts down to the start and stops once it has passed", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    assert.equal(untilStart("2026-11-06T12:05:00.000Z", now), 300_000);
    for (const value of [
      "2026-11-06T12:00:00.000Z",
      "2026-11-06T11:00:00.000Z",
      "not a time",
      undefined,
    ])
      assert.equal(untilStart(value, now), null);
  });
});

describe("notify-me button", () => {
  const saved = {
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  });

  function page({ startsIn = 60 * 60 * 1000, responses = [] } = {}) {
    const button = new FakeElement("button");
    button.dataset.debateNotify = id;
    button.dataset.startsAt = new Date(Date.now() + startsIn).toISOString();
    button.disabled = false;
    const label = new FakeElement("span");
    label.dataset.debateNotifyLabel = "";
    label.textContent = "Notify me";
    button.append(label);
    const status = new FakeElement("p");
    const events = new EventTarget();
    const timers = [];
    const assigned = [];
    globalThis.window = {
      location: {
        pathname: "/debates/public-debate",
        search: "",
        hash: "",
        assign: (url) => assigned.push(url),
      },
      setTimeout: (callback, delay) => timers.push([callback, delay]),
      addEventListener: (...args) => events.addEventListener(...args),
      dispatchEvent: (event) => events.dispatchEvent(event),
    };
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push([options.method ?? "GET", url]);
      const next = responses.shift() ?? { status: 204 };
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        json: async () => next.body ?? {},
      };
    };
    return { button, label, status, events, timers, assigned, requests };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const click = async (button) => {
    await button.listeners.get("click")();
    await settle();
  };

  it("shows the saved request, then turns it off and on again", async () => {
    const view = page({
      responses: [{ status: 200, body: { notifying: true } }, { status: 204 }],
    });
    connectDebateNotify(view.button, view.status);
    await settle();
    assert.equal(view.label.textContent, "Notifying you");
    assert.equal(view.button.getAttribute("aria-pressed"), "true");
    await click(view.button);
    assert.equal(view.label.textContent, "Notify me");
    assert.equal(view.button.getAttribute("aria-pressed"), "false");
    assert.equal(view.status.textContent, notifyMessage(false));
    await click(view.button);
    assert.equal(view.label.textContent, "Notifying you");
    assert.equal(view.status.textContent, notifyMessage(true));
    assert.equal(view.button.disabled, false);
    const path = `/api/matching/events/${id}/notify`;
    assert.deepEqual(view.requests, [
      ["GET", path],
      ["DELETE", path],
      ["PUT", path],
    ]);
    // It goes away when the debate starts.
    assert.equal(view.timers.length, 1);
    const [close, delay] = view.timers[0];
    assert.ok(delay > 59 * 60 * 1000 && delay <= 60 * 60 * 1000);
    close();
    assert.equal(view.button.hidden, true);
    assert.equal(view.status.hidden, true);
  });

  it("asks a signed-out viewer to sign in and comes back to the button", async () => {
    const view = page({
      responses: [{ status: 401 }, { status: 401 }, { status: 401 }],
    });
    const asked = [];
    view.events.addEventListener("yap:request-auth", (event) =>
      asked.push(event.detail),
    );
    connectDebateNotify(view.button, view.status);
    await settle();
    assert.equal(view.label.textContent, "Notify me");
    await click(view.button);
    assert.deepEqual(asked, [
      { returnTo: "/debates/public-debate", source: view.button },
    ]);
    assert.deepEqual(view.assigned, [
      "/account?next=%2Fdebates%2Fpublic-debate",
    ]);
    assert.equal(view.label.textContent, "Notify me");
    // The site header can take over the sign-in instead of the page link.
    view.events.addEventListener("yap:request-auth", (event) =>
      event.preventDefault(),
    );
    await click(view.button);
    assert.equal(view.assigned.length, 1);
  });

  it("shows the server's reason or a connection failure without changing state", async () => {
    const view = page({
      responses: [
        { status: 200, body: { notifying: false } },
        {
          status: 409,
          body: { error: "This debate starts in a few minutes." },
        },
      ],
    });
    connectDebateNotify(view.button, view.status);
    await settle();
    await click(view.button);
    assert.equal(
      view.status.textContent,
      "This debate starts in a few minutes.",
    );
    assert.equal(view.label.textContent, "Notify me");
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    await click(view.button);
    assert.equal(view.status.textContent, notifyFailure);
    assert.equal(view.button.getAttribute("aria-pressed"), "false");
  });

  it("re-reads the request when the account changes", async () => {
    const view = page({
      responses: [
        { status: 200, body: { notifying: true } },
        { status: 200, body: { notifying: false } },
      ],
    });
    connectDebateNotify(view.button, view.status);
    await settle();
    assert.equal(view.label.textContent, "Notifying you");
    view.events.dispatchEvent(new Event("yap:account-changed"));
    await settle();
    assert.equal(view.label.textContent, "Notify me");
    assert.equal(view.requests.length, 2);
  });

  it("hides itself on a page opened after the start", async () => {
    const view = page({ startsIn: -1000 });
    connectDebateNotify(view.button, view.status);
    await settle();
    assert.equal(view.button.hidden, true);
    assert.equal(view.status.hidden, true);
    assert.deepEqual(view.requests, []);
    assert.deepEqual(view.timers, []);
  });
});
