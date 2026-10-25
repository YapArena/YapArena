import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { activityLabel } from "../dist/features/identity/activity.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createIdentityRouter } from "../dist/features/identity/router.js";
import { createLogger } from "../dist/platform/logger.js";
import express from "express";

const owned = {
  id: "11111111-1111-4111-8111-111111111111",
  handle: "my-profile",
  displayName: "My Profile",
  bio: null,
  publicationState: "draft",
  createdAt: new Date("2026-09-01"),
  updatedAt: new Date("2026-09-01"),
};

function setup(overrides = {}) {
  const calls = [];
  const identity = {
    getProfile: async () => owned,
    createProfile: async (...args) => {
      calls.push(["createProfile", ...args]);
      return {
        ...owned,
        handle: args[1],
        displayName: args[2],
        bio: args[3],
        publicationState: args[4],
      };
    },
    updateProfile: async (_userId, changes) => ({ ...owned, ...changes }),
    getRoles: async () => ["participant"],
    isHandleTaken: async (handle) => {
      calls.push(["isHandleTaken", handle]);
      return handle === "taken-name";
    },
    ...overrides,
  };
  const app = createApp({
    identity,
    messages: { isReady: async () => {} },
    users: { create: async () => ({}), findByEmail: async () => null },
    sessions: {
      create: async () => ({}),
      findUserByTokenHash: async () => ({
        id: "7",
        email: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      }),
      deleteByTokenHash: async () => false,
    },
    logger: createLogger({ enabled: false }),
  });
  const session = (method, path) =>
    request(app)[method](path).set("Cookie", "session=token");
  return { app, calls, session };
}

describe("profile setup", () => {
  it("creates a public profile in one request when asked", async () => {
    const { calls, session } = setup();
    const response = await session("post", "/api/me/profile").send({
      handle: "maya-chen",
      displayName: " Maya Chen ",
      publicationState: "published",
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.profile.publicationState, "published");
    assert.deepEqual(calls.at(-1), [
      "createProfile",
      "7",
      "maya-chen",
      "Maya Chen",
      null,
      "published",
    ]);
    // Without a choice a profile still starts as a private draft.
    await session("post", "/api/me/profile").send({
      handle: "second-try",
      displayName: "Second",
    });
    assert.equal(calls.at(-1)[5], "draft");
  });

  it("names the field and says what to fix", async () => {
    const { session } = setup();
    for (const [body, field, message] of [
      [
        { handle: "Felix B", displayName: "Felix" },
        "handle",
        /3 to 40 lowercase letters/,
      ],
      [{ handle: "felix-b", displayName: " " }, "displayName", /1 and 80/],
      [
        { handle: "felix-b", displayName: "Felix", bio: "x".repeat(501) },
        "bio",
        /500 characters/,
      ],
      [
        { handle: "felix-b", displayName: "Felix", publicationState: "hidden" },
        "publicationState",
        /public or private/,
      ],
    ]) {
      const response = await session("post", "/api/me/profile").send(body);
      assert.equal(response.status, 400);
      assert.equal(response.body.field, field);
      assert.equal(response.body.code, "invalid_profile");
      assert.match(response.body.error, message);
    }
    const patch = await session("patch", "/api/me/profile").send({
      displayName: "",
    });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.field, "displayName");
    const unknown = await session("patch", "/api/me/profile").send({
      handle: "stolen",
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.field, undefined);
    assert.equal(unknown.body.error, "invalid profile fields");
  });

  it("tells a taken handle apart from an existing profile", async () => {
    for (const [constraint, code, field] of [
      ["public_profiles_handle_key", "handle_taken", "handle"],
      ["public_profiles_user_id_key", "profile_exists", undefined],
    ]) {
      const { session } = setup({
        createProfile: async () => {
          throw Object.assign(new Error("duplicate"), {
            code: "23505",
            constraint,
          });
        },
      });
      const response = await session("post", "/api/me/profile").send({
        handle: "maya-chen",
        displayName: "Maya",
      });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, code);
      assert.equal(response.body.field, field);
    }
    const { session } = setup({
      createProfile: async () => {
        throw new Error("database down");
      },
    });
    assert.equal(
      (
        await session("post", "/api/me/profile").send({
          handle: "maya-chen",
          displayName: "Maya",
        })
      ).status,
      500,
    );
  });

  it("explains moderation and save conflicts in plain words", async () => {
    const hidden = setup({
      getProfile: async () => ({ ...owned, publicationState: "hidden" }),
    });
    const restricted = await hidden
      .session("patch", "/api/me/profile")
      .send({ bio: "New" });
    assert.equal(restricted.status, 403);
    assert.match(restricted.body.error, /Moderators|moderation/);
    const conflict = setup({ updateProfile: async () => null });
    const response = await conflict
      .session("patch", "/api/me/profile")
      .send({ bio: "New" });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /Refresh and try again/);
  });

  it("checks whether a handle is free", async () => {
    const { calls, session } = setup();
    const free = await session("get", "/api/me/handles/maya-chen");
    assert.equal(free.status, 200);
    assert.deepEqual(free.body, { handle: "maya-chen", available: true });
    assert.equal(free.headers["cache-control"], "no-store");
    assert.deepEqual(
      (await session("get", "/api/me/handles/taken-name")).body,
      { handle: "taken-name", available: false, reason: "taken" },
    );
    const before = calls.length;
    assert.deepEqual((await session("get", "/api/me/handles/Ab")).body, {
      handle: "Ab",
      available: false,
      reason: "invalid",
    });
    assert.equal(calls.length, before, "invalid handles skip the database");
    assert.equal(
      (await request(setup().app).get("/api/me/handles/maya-chen")).status,
      401,
    );
  });
});

describe("account data download", () => {
  it("downloads the account's own records as a dated JSON file", async () => {
    const methods = [];
    const identity = {
      getRoles: async () => ["participant"],
      exportData: async (userId) => ({
        profile: { ...owned, userId },
        follows: [{ targetType: "topic", slug: "cities", title: "Cities" }],
        activity: [{ eventType: "sessions.insert", label: "Signed in" }],
        notifications: [],
      }),
    };
    const app = express();
    app.use((request, _response, next) => {
      request.user = {
        id: "7",
        email: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      };
      next();
    });
    app.use(
      "/api/me",
      createIdentityRouter({
        identity,
        now: () => new Date("2026-10-24T12:00:00Z"),
        exportSources: {
          signInMethods: async (userId) => {
            methods.push(userId);
            return [
              {
                method: "email",
                email: "maya@example.com",
                linkedAt: new Date("2026-10-01T00:00:00Z"),
                subject: "never exported",
              },
            ];
          },
        },
      }),
    );
    const response = await request(app).get("/api/me/export");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /application\/json/);
    assert.equal(
      response.headers["content-disposition"],
      'attachment; filename="yaparena-account-2026-10-24.json"',
    );
    assert.equal(response.headers["cache-control"], "no-store");
    const body = JSON.parse(response.text);
    assert.deepEqual(methods, ["7"]);
    assert.equal(body.exportedAt, "2026-10-24T12:00:00.000Z");
    assert.deepEqual(body.account.signInMethods, [
      {
        method: "email",
        email: "maya@example.com",
        linkedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    assert.equal(body.profile.userId, "7");
    assert.equal(body.activity[0].label, "Signed in");
    assert.match(body.notIncluded, /Chat messages/);
    // Without an identity provider the download still lists no methods.
    const plain = express();
    plain.use((request, _response, next) => {
      request.user = { id: "8", email: null, createdAt: new Date() };
      next();
    });
    plain.use("/api/me", createIdentityRouter({ identity }));
    const fallback = JSON.parse(
      (await request(plain).get("/api/me/export")).text,
    );
    assert.deepEqual(fallback.account.signInMethods, []);
  });

  it("reads only the owner's rows, bounded, without record IDs", async () => {
    const queries = [];
    const repository = createIdentityRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes("FROM follows"))
          return {
            rows: [
              {
                id: "f1",
                targetType: "topic",
                slug: "cities",
                title: "Cities",
                createdAt: new Date("2026-10-02"),
              },
            ],
          };
        if (sql.includes("FROM identity_audit_events"))
          return {
            rows: [
              {
                id: "9",
                eventType: "account_roles.insert",
                subject: "participant",
                occurredAt: new Date("2026-10-01"),
              },
            ],
          };
        return { rows: [] };
      },
    });
    const data = await repository.exportData("7");
    assert.equal(data.profile, null);
    assert.deepEqual(data.follows, [
      {
        targetType: "topic",
        slug: "cities",
        title: "Cities",
        createdAt: new Date("2026-10-02"),
      },
    ]);
    assert.deepEqual(data.activity, [
      {
        eventType: "account_roles.insert",
        label: "Created your account",
        occurredAt: new Date("2026-10-01"),
      },
    ]);
    assert.equal(queries.length, 4);
    assert.ok(queries.every(({ values }) => values[0] === "7"));
    // Follows, activity and notifications are bounded; the profile is one row.
    assert.equal(queries.filter(({ sql }) => /LIMIT \$2/.test(sql)).length, 3);
    assert.ok(queries.some(({ sql }) => sql.includes("account_notifications")));
  });
});

describe("readable account activity", () => {
  it("names every audit event in plain words", () => {
    for (const [type, subject, label] of [
      ["sessions.insert", null, "Signed in"],
      ["sessions.delete", null, "Signed out"],
      ["sessions.incident", null, "Signed out everywhere by YapArena"],
      ["public_profiles.insert", null, "Created your profile"],
      ["public_profiles.update", null, "Updated your profile"],
      ["public_profiles.delete", null, "Removed your profile"],
      ["follows.insert", null, "Followed a person or topic"],
      ["follows.delete", null, "Unfollowed a person or topic"],
      ["account.operation_authorized", null, "Confirmed a sensitive action"],
      ["account_roles.insert", "participant", "Created your account"],
      ["account_roles.insert", "moderator", "Added the moderator role"],
      ["account_roles.insert", null, "Added the account role"],
      ["account_roles.delete", "moderator", "Removed the moderator role"],
      ["account_roles.delete", null, "Removed the account role"],
      ["sign_in.method_linked", "google", "Linked Google sign-in"],
      ["sign_in.method_linked", "email", "Linked email-code sign-in"],
      ["sign_in.method_linked", null, "Linked a sign-in method"],
      ["credentials.password_changed", null, "Changed a sign-in method"],
      ["wallet_identities.insert", null, "Changed a sign-in method"],
      ["something.new", null, "Updated your account"],
    ])
      assert.equal(activityLabel(type, subject), label, type);
  });

  it("labels the activity page and hides duplicate sign-out rows", async () => {
    const queries = [];
    const repository = createIdentityRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return {
          rows: [
            {
              id: "2",
              eventType: "sessions.insert",
              subject: null,
              occurredAt: new Date("2026-10-02"),
            },
          ],
        };
      },
    });
    const page = await repository.listActivity("7", 20, 0);
    assert.deepEqual(page.items, [
      {
        id: "2",
        eventType: "sessions.insert",
        label: "Signed in",
        occurredAt: new Date("2026-10-02"),
      },
    ]);
    assert.deepEqual(queries[0].values, ["7", 21, 0, ["sessions.logout_one"]]);
    assert.match(queries[0].sql, /event_type <> ALL\(\$4::text\[\]\)/);
    // Record IDs stay private: only role and method subjects are read.
    assert.match(queries[0].sql, /CASE WHEN event_type IN/);
  });

  it("stores the chosen visibility and checks handles across every profile", async () => {
    const queries = [];
    const repository = createIdentityRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes("INSERT INTO public_profiles"))
          return { rows: [{ ...owned, publicationState: values[4] }] };
        return { rows: [{ taken: values[0] === "alex-rivera" }] };
      },
    });
    assert.equal(
      (await repository.createProfile("7", "maya", "Maya", null, "published"))
        .publicationState,
      "published",
    );
    assert.equal(
      (await repository.createProfile("7", "maya", "Maya", null))
        .publicationState,
      "draft",
    );
    assert.equal(await repository.isHandleTaken("alex-rivera"), true);
    assert.equal(await repository.isHandleTaken("maya-chen"), false);
    assert.doesNotMatch(queries.at(-1).sql, /publication_state/);
    const none = createIdentityRepository({
      query: async () => ({ rows: [] }),
    });
    assert.equal(await none.isHandleTaken("maya-chen"), false);
  });
});
