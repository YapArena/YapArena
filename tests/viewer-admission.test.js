import assert from "node:assert/strict";
import { it } from "node:test";
import { createHmac } from "node:crypto";
import {
  createViewerAdmission,
  mediaDeliveryLane,
} from "../dist/platform/viewer-admission.js";

const id = "33333333-3333-4333-8333-333333333333";
const path = `/api/media/events/${id}`;
const secret = "synthetic-admission-secret-for-tests";
function fixture(options = {}) {
  let time = 1791380000000;
  const refusals = [];
  const middleware = createViewerAdmission({
    secret,
    now: () => time,
    refused: (reason) => refusals.push(reason),
    ...options,
  });
  function call({
    cookie,
    ip = "127.0.0.1",
    method = "GET",
    url = path,
    finish = true,
  } = {}) {
    const state = { status: 200, next: false };
    const handlers = {};
    const response = {
      once(event, fn) {
        handlers[event] = fn;
      },
      cookie(name, value, flags) {
        state.cookie = `${name}=${value}`;
        state.flags = flags;
        return this;
      },
      set(name, value) {
        state[name] = value;
        return this;
      },
      status(code) {
        state.status = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    };
    middleware(
      { method, path: url, ip, headers: cookie ? { cookie } : {} },
      response,
      () => {
        state.next = true;
      },
    );
    state.finish = () => {
      handlers.finish?.();
      handlers.close?.();
    };
    if (finish) state.finish();
    return state;
  }
  return {
    call,
    refusals,
    advance(ms) {
      time += ms;
    },
    time: () => time,
  };
}
it("admits 500 independent viewers behind one IP for reads, join bursts and reports", () => {
  const f = fixture();
  for (let viewer = 0; viewer < 500; viewer++) {
    const initial = f.call();
    assert.equal(initial.next, true);
    assert.deepEqual(initial.flags, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 900000,
      path: "/",
    });
    for (let poll = 0; poll < 65; poll++)
      assert.equal(f.call({ cookie: initial.cookie }).next, true);
    assert.equal(
      f.call({
        cookie: initial.cookie,
        method: "POST",
        url: `${path}/viewer-token`,
      }).next,
      true,
    );
    for (let report = 0; report < 20; report++)
      assert.equal(
        f.call({
          cookie: initial.cookie,
          method: "POST",
          url: `${path}/playback`,
        }).next,
        true,
      );
  }
  assert.deepEqual(f.refusals, []);
});
it("bounds simultaneous work and releases pressure on close or finish without double release", () => {
  const f = fixture({ maxInFlight: 1 });
  const active = f.call({ finish: false });
  const refused = f.call();
  assert.equal(refused.status, 503);
  assert.equal(refused["Retry-After"], "1");
  active.finish();
  active.finish();
  assert.equal(f.call().next, true);
});
it("throttles one viewer without consuming other viewers' allowances and resets bounded windows", () => {
  const f = fixture();
  const { cookie } = f.call();
  for (let i = 1; i < 90; i++) assert.equal(f.call({ cookie }).next, true);
  assert.equal(f.call({ cookie }).status, 429);
  for (let i = 0; i < 8; i++)
    assert.equal(
      f.call({ cookie, method: "POST", url: `${path}/viewer-token` }).next,
      true,
    );
  assert.equal(
    f.call({ cookie, method: "POST", url: `${path}/viewer-token` }).status,
    429,
  );
  for (let i = 0; i < 30; i++)
    assert.equal(
      f.call({ cookie, method: "POST", url: `${path}/playback` }).next,
      true,
    );
  assert.equal(
    f.call({ cookie, method: "POST", url: `${path}/playback` })["Retry-After"],
    "60",
  );
  assert.equal(f.call().next, true);
  f.advance(60000);
  assert.equal(f.call({ cookie }).next, true);
});
it("does not exempt protected mutations or authentication from their existing controls", () => {
  const f = fixture();
  for (const url of [
    "/api/auth/login",
    "/api/messages",
    `${path}/speaker-token`,
    `${path}/start`,
    `${path}/pause`,
    `${path}/resume`,
    `${path}/end`,
    `${path}/captions`,
  ]) {
    assert.equal(mediaDeliveryLane({ method: "POST", path: url }), undefined);
    const result = f.call({ method: "POST", url });
    assert.equal(result.next, true);
    assert.equal(result.cookie, undefined);
  }
  // Auth0 sign-in, callback and confirmation are GET navigations that keep
  // their own sign-in rate limit instead of a viewer lane.
  for (const url of [
    "/api/auth/login",
    "/api/auth/callback",
    "/api/auth/confirm",
  ]) {
    assert.equal(mediaDeliveryLane({ method: "GET", path: url }), undefined);
    const result = f.call({ method: "GET", url });
    assert.equal(result.next, true);
    assert.equal(result.cookie, undefined);
  }
  for (const url of [
    "/api/me/roles",
    `${path}/speaker-seat`,
    `${path}/captions.vtt`,
    `${path}/replay`,
    `/api/matching/events/${id}/notify`,
  ])
    assert.equal(mediaDeliveryLane({ method: "GET", path: url }), "read");
  // Saving or removing a "Notify me" request keeps the ordinary API budget.
  for (const method of ["PUT", "DELETE"])
    assert.equal(
      mediaDeliveryLane({ method, path: `/api/matching/events/${id}/notify` }),
      undefined,
    );
});
it("rejects tampered/expired/malformed guard values and renews them without authentication privileges", () => {
  const f = fixture({ secure: false });
  const initial = f.call();
  const value = initial.cookie.split("=")[1];
  const future = `0123456789abcdef0123456789abcdef.${f.time() + 900001}`;
  const signedFuture = `${future}.${createHmac("sha256", secret).update(`yaparena-media-admission-v1:${future}`).digest("base64url")}`;
  for (const bad of [
    "x",
    "x".repeat(200),
    `${value}.extra`,
    value.replace(/.$/, "!"),
    value.replace(/.$/, value.at(-1) === "a" ? "b" : "a"),
    signedFuture,
    "0123456789abcdef0123456789abcdef.x.a",
  ])
    assert.ok(f.call({ cookie: `yap_media_guard=${bad}` }).cookie);
  assert.equal(initial.flags.secure, false);
  f.advance(900000);
  assert.ok(f.call({ cookie: initial.cookie }).cookie);
  assert.equal(
    f.call({
      cookie: `other=x; ${f.call().cookie}; extra=y`,
      ip: "::ffff:127.0.0.2",
    }).next,
    true,
  );
});
it("bounds active identities/networks and reclaims expired buckets", () => {
  const f = fixture({ maxViewers: 2, maxNetworks: 1 });
  const first = f.call();
  // The browser and room buckets are full: a new lease is still served,
  // counted against its network and the process only.
  const untracked = f.call();
  assert.equal(untracked.next, true);
  assert.ok(untracked.cookie);
  assert.equal(f.call({ cookie: untracked.cookie }).next, true);
  assert.equal(f.call({ cookie: first.cookie, ip: "127.0.0.2" }).status, 503);
  assert.equal(f.call({ cookie: first.cookie }).next, true);
  f.advance(60000);
  assert.equal(f.call({ ip: "127.0.0.2" }).next, true);
  assert.deepEqual(f.refusals, ["capacity"]);
});
it("keeps serving new visitors while other networks churn leases", () => {
  const f = fixture();
  const existing = f.call({ url: "/about", ip: "198.51.100.10" });
  // Three networks discard every cookie: each mints its own 2,000 leases
  // and is then refused, and the counter buckets fill up.
  for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    for (let i = 0; i < 2000; i++)
      assert.equal(f.call({ url: "/about", ip }).next, true);
    assert.equal(f.call({ url: "/about", ip }).status, 429);
  }
  const visitor = f.call({ url: "/about", ip: "192.0.2.77" });
  assert.equal(visitor.next, true);
  assert.ok(visitor.cookie);
  for (const url of ["/", "/assets/site.css", "/debates"])
    assert.equal(
      f.call({ url, ip: "192.0.2.77", cookie: visitor.cookie }).next,
      true,
    );
  assert.equal(
    f.call({ url: "/about", ip: "198.51.100.10", cookie: existing.cookie })
      .next,
    true,
  );
  assert.deepEqual(f.refusals, ["network", "network", "network"]);
});
it("keeps network budgets for requests served without per-lease counters", () => {
  const f = fixture({ maxViewers: 0 });
  const { cookie } = f.call();
  for (let i = 1; i < 45000; i++) assert.equal(f.call({ cookie }).next, true);
  assert.equal(f.call({ cookie }).status, 429);
  assert.equal(f.refusals.at(-1), "network");
  assert.equal(f.call({ ip: "127.0.0.2" }).next, true);
});
it("bounds anonymous lease churn on one network", () => {
  const f = fixture();
  for (let i = 0; i < 2000; i++) assert.equal(f.call().next, true);
  assert.equal(f.call().status, 429);
  assert.equal(f.call({ ip: "127.0.0.2" }).next, true);
});
it("supports five open event pages and later bootstrap reads within the browser budget", () => {
  const f = fixture();
  const first = f.call({ url: "/debates/synthetic-event" });
  for (let room = 0; room < 5; room++) {
    const roomId = `33333333-3333-4333-8333-${String(room).padStart(12, "0")}`;
    for (let poll = 0; poll < 60; poll++)
      assert.equal(
        f.call({ cookie: first.cookie, url: `/api/media/events/${roomId}` })
          .next,
        true,
      );
  }
  for (let i = 0; i < 149; i++)
    assert.equal(
      f.call({
        cookie: first.cookie,
        url: i % 2 ? "/api/auth/me" : "/assets/site.css",
      }).next,
      true,
    );
  assert.equal(
    f.call({ cookie: first.cookie, url: "/api/auth/me" }).status,
    429,
  );
});
it("bounds aggregate network and process traffic with independently signed viewers", () => {
  const f = fixture();
  const actors = Array.from({ length: 501 }, () => f.call());
  for (let i = 0; i < 45000 - 501; i++)
    assert.equal(f.call({ cookie: actors[i % 501].cookie }).next, true);
  assert.equal(f.call({ cookie: actors[500].cookie }).status, 429);
  assert.equal(f.refusals.at(-1), "network");
  f.advance(60000);
  const second = fixture();
  const other = Array.from({ length: 701 }, (_, i) =>
    second.call({
      ip: `10.${Math.floor(i / 65000)}.${Math.floor(i / 250) % 250}.${(i % 250) + 1}`,
    }),
  );
  for (let i = 0; i < 60000 - 701; i++) {
    const n = i % 701;
    assert.equal(
      second.call({
        cookie: other[n].cookie,
        ip: `10.0.${Math.floor(n / 250)}.${(n % 250) + 1}`,
      }).next,
      true,
    );
  }
  assert.equal(
    second.call({ cookie: other[700].cookie, ip: "10.0.2.201" }).status,
    429,
  );
  assert.equal(second.refusals.at(-1), "process");
});
