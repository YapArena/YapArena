import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";

import { createMatchingRouter } from "../dist/features/matching/router.js";
import {
  createPushDelivery,
  createPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS,
  PUSH_DELIVERY_ATTEMPTS,
  PUSH_DELIVERY_MINUTES,
  pruneExpiredPushDeliveries,
  pushMessage,
  queuePushDeliveries,
} from "../dist/features/matching/push.js";
import { createRuntime } from "../dist/platform/runtime.js";
import { renderDebate } from "../dist/features/discovery/web.js";
import { notifyMessage } from "../public/debate-notify-logic.js";
import { connectDebateNotify } from "../public/debate-notify.js";
import {
  browserPushDevice,
  keyBytes,
  pushSubscriptionEndpoint,
  startPush,
} from "../public/web-push.js";
import { FakeElement } from "./helpers/fake-dom.js";
import { debate, origin } from "./page-fixtures.js";

// Web push for "Notify me" (first-run build plan PR 10): saving subscriptions, sending on the
// reminder, the button's permission request and the service worker's notifications.
const browserKey = (() => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
})();
const subscriptionJson = {
  endpoint: "https://web.push.apple.com/QGxV9tq",
  expirationTime: null,
  keys: {
    p256dh: browserKey,
    auth: Buffer.from("0123456789abcdef").toString("base64url"),
  },
};
const saved = {
  endpoint: subscriptionJson.endpoint,
  p256dh: subscriptionJson.keys.p256dh,
  auth: subscriptionJson.keys.auth,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("push subscription routes", () => {
  function fixture({
    liveQueue = true,
    roles = ["participant"],
    store = true,
    result = "created",
  } = {}) {
    const calls = [];
    const app = express();
    app.use(express.json());
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
          restriction: async () => ({ expiresAt: new Date("2026-12-01") }),
        },
        matching: {},
        pushSubscriptions: store
          ? {
              save: async (userId, subscription) => {
                calls.push(["save", userId, subscription]);
                return result;
              },
              remove: async (userId, endpoint) => {
                calls.push(["remove", userId, endpoint]);
              },
            }
          : undefined,
      }),
    );
    return { app, calls };
  }
  const path = "/api/matching/push-subscription";

  it("saves and removes the signed-in account's subscription, even while restricted", async () => {
    const { app, calls } = fixture();
    const created = await request(app).put(path).send(subscriptionJson);
    assert.equal(created.status, 201);
    assert.equal(created.headers["cache-control"], "no-store");
    const again = fixture({ result: "updated" });
    assert.equal(
      (await request(again.app).put(path).send(subscriptionJson)).status,
      204,
    );
    assert.equal(
      (
        await request(app)
          .delete(path)
          .send({ endpoint: subscriptionJson.endpoint })
      ).status,
      204,
    );
    assert.deepEqual(calls, [
      ["save", "7", saved],
      ["remove", "7", subscriptionJson.endpoint],
    ]);
  });

  it("refuses malformed subscriptions and addresses outside the push services", async () => {
    const { app, calls } = fixture();
    for (const body of [
      {},
      { ...subscriptionJson, endpoint: "https://example.com/push" },
      { ...subscriptionJson, keys: { p256dh: "x", auth: "y" } },
    ]) {
      const refused = await request(app).put(path).send(body);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error, "invalid push subscription");
    }
    for (const body of [{}, { endpoint: "http://169.254.169.254/" }])
      assert.equal((await request(app).delete(path).send(body)).status, 400);
    assert.equal((await request(app).delete(path)).status, 400);
    assert.deepEqual(calls, []);
  });

  it("needs the participant role to save, and exists only with push and the live queue", async () => {
    const viewer = fixture({ roles: [] });
    assert.equal(
      (await request(viewer.app).put(path).send(subscriptionJson)).status,
      403,
    );
    assert.equal(
      (
        await request(viewer.app)
          .delete(path)
          .send({ endpoint: subscriptionJson.endpoint })
      ).status,
      204,
    );
    for (const off of [
      fixture({ store: false }),
      fixture({ liveQueue: false }),
    ])
      for (const method of ["put", "delete"])
        assert.equal(
          (await request(off.app)[method](path).send(subscriptionJson)).status,
          404,
        );
  });
});

describe("push subscription store", () => {
  function pool(created) {
    const queries = [];
    const client = {
      query: async (sql, params) => {
        queries.push([sql.replace(/\s+/g, " ").trim(), params]);
        return /RETURNING \(xmax = 0\)/.test(sql)
          ? { rows: [{ created }] }
          : { rows: [], rowCount: 0 };
      },
      on() {},
      removeListener() {},
      release() {},
    };
    return {
      queries,
      connect: async () => client,
      query: client.query,
    };
  }

  it("moves an address to the account that saved it last and keeps the newest few", async () => {
    const database = pool(true);
    const store = createPushSubscriptions(database);
    assert.equal(await store.save("7", saved), "created");
    const statements = database.queries.map(([sql]) => sql);
    assert.equal(statements[0], "BEGIN");
    assert.match(
      statements[1],
      /^DELETE FROM web_push_subscriptions WHERE endpoint = \$1 AND user_id <> \$2/,
    );
    assert.deepEqual(database.queries[1][1], [saved.endpoint, "7"]);
    assert.match(
      statements[2],
      /ON CONFLICT \(endpoint\) DO UPDATE SET user_id/,
    );
    assert.deepEqual(database.queries[2][1], [
      "7",
      saved.endpoint,
      saved.p256dh,
      saved.auth,
    ]);
    assert.match(
      statements[3],
      new RegExp(
        `ORDER BY updated_at DESC, id DESC LIMIT ${MAX_PUSH_SUBSCRIPTIONS}\\)$`,
      ),
    );
    assert.equal(statements[4], "COMMIT");
    assert.equal(
      await createPushSubscriptions(pool(false)).save("7", saved),
      "updated",
    );
    await store.remove("7", saved.endpoint);
    assert.deepEqual(database.queries.at(-1), [
      "DELETE FROM web_push_subscriptions WHERE user_id = $1 AND endpoint = $2",
      ["7", saved.endpoint],
    ]);
  });

  it("queues one delivery per subscription of the notified accounts, and prunes dead ones", async () => {
    const queries = [];
    const client = {
      query: async (sql, params) => {
        queries.push([sql.replace(/\s+/g, " ").trim(), params]);
        return { rowCount: 3 };
      },
    };
    await queuePushDeliveries(client, "d1", []);
    assert.deepEqual(queries, [], "nobody notified, nothing queued");
    await queuePushDeliveries(client, "d1", ["7", "8"]);
    assert.match(queries[0][0], /^INSERT INTO web_push_deliveries/);
    assert.match(
      queries[0][0],
      /WHERE s.user_id = ANY\(\$2::bigint\[\]\) ON CONFLICT DO NOTHING$/,
    );
    assert.deepEqual(queries[0][1], ["d1", ["7", "8"]]);
    assert.equal(await pruneExpiredPushDeliveries(client), 3);
    assert.match(
      queries[1][0],
      new RegExp(
        `mins => ${PUSH_DELIVERY_MINUTES}\\) OR \\(attempts >= ${PUSH_DELIVERY_ATTEMPTS}`,
      ),
    );
    assert.equal(
      await pruneExpiredPushDeliveries({ query: async () => ({}) }),
      0,
    );
  });
});

describe("push delivery", () => {
  it("carries only the debate's title and page", () => {
    assert.deepEqual(
      pushMessage({ proposition: "Cities should ban cars", slug: "cars-1" }),
      { title: "Cities should ban cars", url: "/debates/cars-1" },
    );
    const long = pushMessage({
      proposition: `${"a ".repeat(100)}end`,
      slug: "x y",
    });
    assert.equal(long.title.length, 120);
    assert.ok(long.title.endsWith("…"));
    assert.equal(long.url, "/debates/x%20y");
  });

  function fixture(due, answers = {}) {
    const queries = [];
    const sent = [];
    const logs = [];
    const database = {
      query: async (sql, params) => {
        queries.push([sql.replace(/\s+/g, " ").trim(), params]);
        return /^\s*WITH due AS/.test(sql) ? { rows: due } : { rowCount: 1 };
      },
    };
    const delivery = createPushDelivery({
      database,
      logger: {
        info: (details, message) => logs.push(["info", details, message]),
        warn: (details, message) => logs.push(["warn", details, message]),
      },
      push: {
        send: async (subscription, message, ttl) => {
          sent.push([subscription.endpoint, message, ttl]);
          const answer = answers[subscription.subscriptionId] ?? "sent";
          if (answer instanceof Error) throw answer;
          return {
            outcome: answer,
            status: { gone: 410, refused: 403, retry: 503 }[answer] ?? 201,
          };
        },
      },
    });
    return { delivery, queries, sent, logs };
  }
  const row = (subscriptionId, extra = {}) => ({
    subscriptionId,
    debateId: `d${subscriptionId}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/secret-${subscriptionId}`,
    p256dh: browserKey,
    auth: saved.auth,
    proposition: "Cities should ban cars",
    slug: "cars",
    current: true,
    ...extra,
  });

  it("does nothing more than one claim when nothing is due", async () => {
    const { delivery, queries, sent, logs } = fixture([]);
    assert.deepEqual(await delivery.flush(), {
      sent: 0,
      gone: 0,
      refused: 0,
      retry: 0,
      skipped: 0,
    });
    assert.equal(queries.length, 1);
    assert.match(queries[0][0], /FOR UPDATE SKIP LOCKED/);
    assert.match(
      queries[0][0],
      new RegExp(`attempts < ${PUSH_DELIVERY_ATTEMPTS}`),
    );
    assert.deepEqual([sent, logs], [[], []]);
  });

  it("sends due deliveries, drops gone subscriptions and keeps failures for a retry", async () => {
    const { delivery, queries, sent, logs } = fixture(
      [
        row("1"),
        row("2"),
        row("3"),
        row("4"),
        row("5", { current: false }),
        row("6"),
      ],
      { 2: "gone", 3: "refused", 4: "retry", 6: new Error("bad key") },
    );
    assert.deepEqual(await delivery.flush(), {
      sent: 1,
      gone: 1,
      refused: 2,
      retry: 1,
      skipped: 1,
    });
    // A debate called off since the reminder sends nothing.
    assert.deepEqual(
      sent.map(([endpoint]) => endpoint.at(-1)),
      ["1", "2", "3", "4", "6"],
    );
    assert.deepEqual(sent[0].slice(1), [
      { title: "Cities should ban cars", url: "/debates/cars" },
      PUSH_DELIVERY_MINUTES * 60,
    ]);
    // Sent, refused and skipped deliveries are done; the retry stays claimed until its lease ends.
    assert.match(
      queries[1][0],
      /^DELETE FROM web_push_deliveries w USING unnest/,
    );
    assert.deepEqual(queries[1][1], [
      ["1", "3", "5", "6"],
      ["d1", "d3", "d5", "d6"],
    ]);
    assert.deepEqual(queries[2], [
      "DELETE FROM web_push_subscriptions WHERE id = ANY($1::bigint[])",
      [["2"]],
    ]);
    const warnings = logs.filter(([level]) => level === "warn");
    assert.deepEqual(
      warnings.map(([, details]) => details),
      [
        { outcome: "refused", status: 403, pushService: "fcm.googleapis.com" },
        { outcome: "retry", status: 503, pushService: "fcm.googleapis.com" },
        { outcome: "refused", pushService: "fcm.googleapis.com" },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(logs),
      /secret-/,
      "addresses stay out of logs",
    );
  });

  it("runs every second in the worker and counts toward its heartbeat", async () => {
    const callbacks = new Map();
    const errors = [];
    const cleared = [];
    let flushes = 0;
    let finish;
    const runtime = createRuntime({
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      webPush: {
        flush: () => {
          flushes++;
          if (flushes === 2)
            return Promise.reject(new Error("database unavailable"));
          return flushes === 3
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : Promise.resolve();
        },
      },
      heartbeat: { beat: async () => {} },
      logger: {
        info() {},
        error: ({ jobs, error }, message) =>
          errors.push({ message, jobs, error: error?.message }),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      now: () => 0,
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { interval, unref() {} };
      },
      clearIntervalFn: (timer) => cleared.push(timer.interval),
    });
    await runtime.start();
    const tick = callbacks.get(1000);
    await tick();
    assert.equal(flushes, 1);
    await tick();
    assert.deepEqual(errors, [
      {
        message: "web push delivery failed",
        jobs: undefined,
        error: "database unavailable",
      },
    ]);
    const pending = tick();
    assert.equal(tick(), pending, "a slow pass is never doubled");
    assert.equal(flushes, 3);
    finish();
    await pending;
    await runtime.stop();
    assert.ok(cleared.includes(1000));
    await tick();
    assert.equal(flushes, 3, "no pass starts once stopping");
  });
});

describe("notify-me button with web push", () => {
  const original = { window: globalThis.window, fetch: globalThis.fetch };
  afterEach(() => {
    globalThis.window = original.window;
    globalThis.fetch = original.fetch;
  });
  const id = "11111111-1111-4111-8111-111111111111";

  function page({
    signedIn = true,
    pushKey = "BKey",
    availability = "ready",
    permission = "default",
    answer = "granted",
    subscribe = async () => subscriptionJson,
    pushSave = 201,
  } = {}) {
    const log = [];
    const button = new FakeElement("button");
    button.dataset.debateNotify = id;
    button.dataset.startsAt = new Date(Date.now() + 3_600_000).toISOString();
    if (pushKey) button.dataset.pushKey = pushKey;
    const label = new FakeElement("span");
    label.dataset.debateNotifyLabel = "";
    button.append(label);
    const status = new FakeElement("p");
    const events = new EventTarget();
    globalThis.window = {
      location: { pathname: "/debates/x", search: "", hash: "", assign() {} },
      setTimeout() {},
      addEventListener: (...args) => events.addEventListener(...args),
      dispatchEvent: (event) => events.dispatchEvent(event),
    };
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? "GET";
      log.push(`${method} ${url}`);
      if (url === pushSubscriptionEndpoint) {
        log.push(JSON.parse(options.body));
        return { ok: pushSave < 300, status: pushSave, json: async () => ({}) };
      }
      const status = signedIn ? (method === "GET" ? 200 : 201) : 401;
      return {
        ok: status < 300,
        status,
        json: async () => ({ notifying: false }),
      };
    };
    const device = {
      availability: () => availability,
      permission: () => permission,
      requestPermission: () => {
        log.push("prompt");
        return Promise.resolve(answer);
      },
      subscribe: async (key) => {
        log.push(`subscribe ${key}`);
        return subscribe();
      },
    };
    connectDebateNotify(button, status, device);
    const tap = async (isTrusted = true) => {
      await button.listeners.get("click")({ isTrusted });
      for (let i = 0; i < 5; i++) await settle();
    };
    return { button, label, status, log, tap, events };
  }

  it("never asks on page load, then asks inside the tap and saves the subscription", async () => {
    const view = page();
    await settle();
    assert.deepEqual(view.log, [`GET /api/matching/events/${id}/notify`]);
    await view.tap();
    // The prompt opens before any request, while the tap still counts as a user gesture.
    assert.deepEqual(view.log.slice(1), [
      "prompt",
      `PUT /api/matching/events/${id}/notify`,
      "subscribe BKey",
      `PUT ${pushSubscriptionEndpoint}`,
      subscriptionJson,
    ]);
    assert.equal(view.label.textContent, "Notifying you");
    assert.equal(view.status.textContent, notifyMessage(true, "on"));
    // Turning the notice off asks nothing and keeps the subscription for other debates.
    await view.tap();
    assert.equal(view.log.at(-1), `DELETE /api/matching/events/${id}/notify`);
    assert.equal(view.status.textContent, notifyMessage(false));
  });

  it("subscribes without a prompt once allowed, and asks nothing when blocked", async () => {
    const allowed = page({ permission: "granted" });
    await settle();
    await allowed.tap();
    assert.ok(!allowed.log.includes("prompt"));
    assert.ok(allowed.log.includes(`PUT ${pushSubscriptionEndpoint}`));
    const blocked = page({ permission: "denied" });
    await settle();
    await blocked.tap();
    assert.ok(!blocked.log.includes("prompt"));
    assert.equal(blocked.status.textContent, notifyMessage(true));
  });

  it("keeps today's in-app notice when push is refused, unavailable or fails", async () => {
    for (const options of [
      { answer: "denied" },
      { answer: "default" },
      { availability: "off" },
      { subscribe: async () => Promise.reject(new Error("no worker")) },
      { pushSave: 400 },
    ]) {
      const view = page(options);
      await settle();
      await view.tap();
      assert.equal(view.label.textContent, "Notifying you");
      assert.equal(
        view.status.textContent,
        notifyMessage(true),
        JSON.stringify(options),
      );
      assert.equal(
        notifyMessage(true),
        "You’ll get a notice in your notifications a few minutes before it starts.",
      );
    }
  });

  it("tells an iPhone browser tab that push needs Add to Home Screen", async () => {
    const view = page({ availability: "install" });
    await settle();
    await view.tap();
    assert.ok(!view.log.includes("prompt"));
    assert.equal(view.status.textContent, notifyMessage(true, "install"));
    assert.match(
      view.status.textContent,
      /On iPhone, add YAP Arena to your Home Screen/,
    );
    assert.doesNotMatch(view.status.textContent, /coin/i);
  });

  it("asks nothing without a tap, a signed-in viewer or the public key", async () => {
    const untrusted = page();
    await settle();
    await untrusted.tap(false);
    const signedOut = page({ signedIn: false });
    await settle();
    await signedOut.tap();
    const keyless = page({ pushKey: null });
    await settle();
    await keyless.tap();
    for (const view of [untrusted, signedOut, keyless])
      assert.ok(!view.log.includes("prompt"));
    assert.equal(keyless.status.textContent, notifyMessage(true));
    // After an account change the next tap waits for the new account's request.
    const changed = page();
    await settle();
    changed.events.dispatchEvent(new Event("yap:account-changed"));
    await changed.tap();
    assert.ok(!changed.log.includes("prompt"));
  });
});

describe("browser push device", () => {
  function scope({
    push = true,
    standalone,
    permission = "default",
    subscribe,
    previous = null,
    ready = true,
  } = {}) {
    const calls = [];
    const navigator = {
      ...(push
        ? {
            serviceWorker: {
              ready: ready
                ? Promise.resolve({
                    pushManager: {
                      subscribe: async (options) => {
                        calls.push([
                          "subscribe",
                          [...options.applicationServerKey],
                        ]);
                        return subscribe(options);
                      },
                      getSubscription: async () => previous,
                    },
                  })
                : new Promise(() => {}),
            },
          }
        : {}),
      ...(standalone === undefined ? {} : { standalone }),
    };
    return {
      calls,
      navigator,
      setTimeout: (callback) => {
        if (!ready) callback();
      },
      ...(push
        ? {
            PushManager: class {},
            Notification: {
              permission,
              requestPermission: async () => "granted",
            },
          }
        : {}),
    };
  }

  it("tells push, an iPhone browser tab and no push apart", async () => {
    assert.equal(browserPushDevice(scope()).availability(), "ready");
    assert.equal(
      browserPushDevice(
        scope({ push: false, standalone: false }),
      ).availability(),
      "install",
    );
    assert.equal(
      browserPushDevice(
        scope({ push: false, standalone: true }),
      ).availability(),
      "off",
    );
    assert.equal(
      browserPushDevice(scope({ push: false })).availability(),
      "off",
    );
    const device = browserPushDevice(scope({ permission: "granted" }));
    assert.equal(device.permission(), "granted");
    assert.equal(await device.requestPermission(), "granted");
  });

  it("subscribes with the key's bytes and replaces a subscription made with another key", async () => {
    assert.deepEqual([...keyBytes("AQID_-8")], [1, 2, 3, 255, 239]);
    const fresh = scope({
      subscribe: async () => ({ toJSON: () => subscriptionJson }),
    });
    assert.deepEqual(
      await browserPushDevice(fresh).subscribe("AQID"),
      subscriptionJson,
    );
    assert.deepEqual(fresh.calls, [["subscribe", [1, 2, 3]]]);
    let first = true;
    let unsubscribed = 0;
    const rotated = scope({
      subscribe: async () => {
        if (first) {
          first = false;
          throw new Error("InvalidStateError");
        }
        return { toJSON: () => subscriptionJson };
      },
      previous: { unsubscribe: async () => void unsubscribed++ },
    });
    assert.deepEqual(
      await browserPushDevice(rotated).subscribe("AQID"),
      subscriptionJson,
    );
    assert.equal(unsubscribed, 1);
    const stuck = scope({
      subscribe: async () => Promise.reject(new Error("NotAllowedError")),
    });
    await assert.rejects(
      browserPushDevice(stuck).subscribe("AQID"),
      /NotAllowedError/,
    );
    await assert.rejects(
      browserPushDevice(scope({ ready: false })).subscribe("AQID"),
      /service worker unavailable/,
    );
  });

  it("treats a throwing browser as no push", async () => {
    const broken = {
      availability: () => {
        throw new Error("no Notification");
      },
    };
    assert.equal(await startPush(broken, "k"), "off");
  });
});

describe("notify-me button markup with web push", () => {
  it("carries the public key only when push is on", () => {
    const upcoming = { ...debate, status: "scheduled" };
    const on = renderDebate(
      origin,
      upcoming,
      false,
      null,
      true,
      undefined,
      "BPublicKey",
    );
    assert.match(
      on,
      /<button[^>]*data-debate-notify="[^"]+" data-starts-at="[^"]+" data-push-key="BPublicKey" aria-pressed="false">/,
    );
    assert.doesNotMatch(
      renderDebate(origin, upcoming, false, null, true),
      /data-push-key/,
    );
  });
});

describe("service worker notifications", () => {
  const source = readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  function worker(windows = []) {
    const listeners = new Map();
    const shown = [];
    const opened = [];
    const self = {
      location: { origin: "https://yaparena.test" },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting() {},
      registration: {
        // Copied out of the worker's realm so deepEqual compares plain values.
        showNotification: async (title, options) =>
          shown.push(JSON.parse(JSON.stringify({ title, options }))),
      },
      clients: {
        claim() {},
        matchAll: async (options) => {
          assert.deepEqual(JSON.parse(JSON.stringify(options)), {
            type: "window",
            includeUncontrolled: true,
          });
          return windows;
        },
        openWindow: async (url) => opened.push(url),
      },
    };
    vm.runInNewContext(source, { self, URL });
    async function dispatch(type, event) {
      const waits = [];
      listeners.get(type)({
        ...event,
        waitUntil: (promise) => waits.push(promise),
      });
      await Promise.all(waits);
    }
    return { shown, opened, dispatch };
  }
  const data = (value) => ({
    json: () => (typeof value === "string" ? JSON.parse(value) : value),
  });

  it("shows the debate's title and opens its page", async () => {
    const sw = worker();
    await sw.dispatch("push", {
      data: data({ title: "Cities should ban cars", url: "/debates/cars" }),
    });
    assert.deepEqual(sw.shown, [
      {
        title: "Cities should ban cars",
        options: {
          body: "Starts in a few minutes. Tap to watch.",
          icon: "/assets/icons/icon-192.png",
          tag: "https://yaparena.test/debates/cars",
          data: { url: "https://yaparena.test/debates/cars" },
        },
      },
    ]);
    let closed = 0;
    await sw.dispatch("notificationclick", {
      notification: { data: sw.shown[0].options.data, close: () => closed++ },
    });
    assert.equal(closed, 1);
    assert.deepEqual(sw.opened, ["https://yaparena.test/debates/cars"]);
  });

  it("focuses a window already on the debate", async () => {
    let focused = 0;
    const sw = worker([
      { url: "https://yaparena.test/home", focus: async () => assert.fail() },
      {
        url: "https://yaparena.test/debates/cars",
        focus: async () => focused++,
      },
    ]);
    await sw.dispatch("notificationclick", {
      notification: {
        data: { url: "https://yaparena.test/debates/cars" },
        close() {},
      },
    });
    assert.equal(focused, 1);
    assert.deepEqual(sw.opened, []);
  });

  it("still shows a notification for an unreadable push, and never leaves the site", async () => {
    const sw = worker();
    for (const event of [
      { data: null },
      { data: data("not json") },
      { data: data({ title: "", url: "/debates/x" }) },
    ])
      await sw.dispatch("push", event);
    for (const { title, options } of sw.shown) {
      assert.equal(title, "YAP Arena");
      assert.equal(
        options.body,
        "A debate you asked to be notified about starts in a few minutes.",
      );
    }
    assert.equal(
      sw.shown[2].options.data.url,
      "https://yaparena.test/debates/x",
    );
    const other = worker();
    for (const url of ["//evil.example/x", "https://evil.example/x", 5])
      await other.dispatch("push", { data: data({ title: "T", url }) });
    assert.deepEqual(
      other.shown.map(({ title, options }) => [title, options.data.url]),
      [
        ["T", "https://yaparena.test/"],
        ["T", "https://yaparena.test/"],
        ["T", "https://yaparena.test/"],
      ],
    );
    assert.equal(
      worker().shown.length,
      0,
      "loading the worker shows nothing by itself",
    );
    const opener = worker();
    for (const saved of [
      null,
      { url: "https://evil.example/" },
      { url: "http://[" },
    ])
      await opener.dispatch("notificationclick", {
        notification: { data: saved, close() {} },
      });
    assert.deepEqual(opener.opened, [
      "https://yaparena.test/",
      "https://yaparena.test/",
      "https://yaparena.test/",
    ]);
  });
});
