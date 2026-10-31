import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createLogger } from "../dist/platform/logger.js";

const owned = {
  id: "11111111-1111-4111-8111-111111111111",
  handle: "my-profile",
  displayName: "My Profile",
  bio: null,
  publicationState: "draft",
  createdAt: new Date("2026-09-01"),
  updatedAt: new Date("2026-09-01"),
};

function setup(overrides = {}, authenticated = true) {
  const calls = [];
  const identity = {
    getProfile: async (userId) => {
      calls.push(["getProfile", userId]);
      return owned;
    },
    createProfile: async (userId, handle, displayName, bio) => {
      calls.push(["createProfile", userId, handle, displayName, bio]);
      return { ...owned, handle, displayName, bio };
    },
    updateProfile: async (userId, changes) => {
      calls.push(["updateProfile", userId, changes]);
      return { ...owned, ...changes };
    },
    getRoles: async (userId) => {
      calls.push(["getRoles", userId]);
      return ["participant"];
    },
    follow: async (userId, type, slug) => {
      calls.push(["follow", userId, type, slug]);
      return "created";
    },
    unfollow: async (userId, type, slug) => {
      calls.push(["unfollow", userId, type, slug]);
    },
    isFollowing: async (userId, type, slug) => {
      calls.push(["isFollowing", userId, type, slug]);
      return true;
    },
    listFollows: async () => ({
      items: [],
      pagination: { limit: 20, offset: 0, hasMore: false },
    }),
    listActivity: async () => ({
      items: [],
      pagination: { limit: 20, offset: 0, hasMore: false },
    }),
    ...overrides,
  };
  const app = createApp({
    identity,
    messages: { isReady: async () => {} },
    users: { create: async () => ({}), findByEmail: async () => null },
    sessions: {
      create: async () => ({}),
      findUserByTokenHash: async () =>
        authenticated ? { id: "7", email: "me@example.com" } : null,
      deleteByTokenHash: async () => false,
    },
    logger: createLogger({ enabled: false }),
  });
  return { app, calls };
}

describe("owned profiles and follows", () => {
  it("requires a session for all account routes", async () => {
    const { app } = setup({}, false);
    for (const [method, path] of [
      ["get", "/api/me/profile"],
      ["post", "/api/me/profile"],
      ["put", "/api/me/follows/topics/public-topic"],
      ["get", "/api/me/activity"],
    ]) {
      assert.equal((await request(app)[method](path)).status, 401);
    }
  });

  it("creates a private profile for the authenticated owner", async () => {
    const { app, calls } = setup();
    const response = await request(app)
      .post("/api/me/profile")
      .set("Cookie", "session=token")
      .send({
        handle: "new-handle",
        displayName: "New Person",
        bio: "Hello",
        acceptTerms: true,
      });
    assert.equal(response.status, 201);
    assert.equal(response.body.profile.publicationState, "draft");
    assert.deepEqual(calls.at(-1), [
      "createProfile",
      "7",
      "new-handle",
      "New Person",
      "Hello",
    ]);
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("edits permitted fields without accepting ownership or handle changes", async () => {
    const { app, calls } = setup();
    const session = (method, path) =>
      request(app)[method](path).set("Cookie", "session=token");
    assert.equal(
      (await session("patch", "/api/me/profile").send({ handle: "stolen" }))
        .status,
      400,
    );
    assert.equal(
      (
        await session("post", "/api/me/profile").send({
          handle: "new-handle",
          displayName: "Name",
          userId: "8",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await session("patch", "/api/me/profile").send({
          publicationState: "hidden",
        })
      ).status,
      400,
    );
    const response = await session("patch", "/api/me/profile").send({
      displayName: "Renamed",
      bio: null,
      publicationState: "published",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), [
      "updateProfile",
      "7",
      {
        displayName: "Renamed",
        bio: null,
        publicationState: "published",
      },
    ]);
  });

  it("prevents a restricted profile from being republished", async () => {
    const { app } = setup({
      getProfile: async () => ({ ...owned, publicationState: "hidden" }),
    });
    const response = await request(app)
      .patch("/api/me/profile")
      .set("Cookie", "session=token")
      .send({ publicationState: "published" });
    assert.equal(response.status, 403);
  });

  it("follows and unfollows public targets with the session owner ID", async () => {
    const { app, calls } = setup();
    const session = (method, path) =>
      request(app)[method](path).set("Cookie", "session=token");
    assert.equal(
      (await session("put", "/api/me/follows/topics/public-topic")).status,
      201,
    );
    assert.deepEqual(calls.at(-1), ["follow", "7", "topic", "public-topic"]);
    assert.equal(
      (await session("get", "/api/me/follows/people/alex-public")).body
        .following,
      true,
    );
    assert.equal(
      (await session("delete", "/api/me/follows/people/alex-public")).status,
      204,
    );
    assert.deepEqual(calls.at(-1), ["unfollow", "7", "profile", "alex-public"]);
    assert.deepEqual((await session("get", "/api/me/roles")).body.roles, [
      "participant",
    ]);
  });

  it("returns safe follow outcomes and bounded history pages", async () => {
    const session = (app, path) =>
      request(app).get(path).set("Cookie", "session=token");
    for (const [result, status] of [
      ["missing", 404],
      ["self", 409],
      ["exists", 204],
    ]) {
      const { app } = setup({ follow: async () => result });
      assert.equal(
        (
          await request(app)
            .put("/api/me/follows/people/alex-public")
            .set("Cookie", "session=token")
        ).status,
        status,
      );
    }
    const { app } = setup();
    assert.equal((await session(app, "/api/me/follows?limit=0")).status, 400);
    assert.equal(
      (await session(app, "/api/me/activity?offset=10001")).status,
      400,
    );
    assert.equal(
      (await session(app, "/api/me/activity?limit=20&offset=0")).status,
      200,
    );
  });

  it("handles missing profiles, duplicate handles, and invalid follow paths", async () => {
    const missing = setup({ getProfile: async () => null });
    assert.equal(
      (
        await request(missing.app)
          .get("/api/me/profile")
          .set("Cookie", "session=token")
      ).status,
      404,
    );
    assert.equal(
      (
        await request(missing.app)
          .patch("/api/me/profile")
          .set("Cookie", "session=token")
          .send({ displayName: "Name" })
      ).status,
      404,
    );
    const duplicate = setup({
      createProfile: async () => {
        throw { code: "23505" };
      },
    });
    assert.equal(
      (
        await request(duplicate.app)
          .post("/api/me/profile")
          .set("Cookie", "session=token")
          .send({
            handle: "valid-name",
            displayName: "Name",
            acceptTerms: true,
          })
      ).status,
      409,
    );
    const blocked = setup({ updateProfile: async () => null });
    assert.equal(
      (
        await request(blocked.app)
          .patch("/api/me/profile")
          .set("Cookie", "session=token")
          .send({ bio: "New" })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(blocked.app)
          .put("/api/me/follows/people/BAD")
          .set("Cookie", "session=token")
      ).status,
      404,
    );
    assert.equal(
      (
        await request(blocked.app)
          .delete("/api/me/follows/topics/BAD")
          .set("Cookie", "session=token")
      ).status,
      404,
    );
  });

  it("rejects malformed profile fields without changing records", async () => {
    const { app, calls } = setup();
    const session = (method, body) =>
      request(app)
        [method]("/api/me/profile")
        .set("Cookie", "session=token")
        .send(body);
    for (const body of [
      [],
      {},
      { handle: "BAD", displayName: "Name" },
      { handle: "valid-handle", displayName: " " },
      { handle: "valid-handle", displayName: "Name", bio: "x".repeat(501) },
    ]) {
      assert.equal((await session("post", body)).status, 400);
    }
    for (const body of [
      {},
      { bio: 12 },
      { displayName: " " },
      { publicationState: "hidden" },
      { userId: "8" },
    ]) {
      assert.equal((await session("patch", body)).status, 400);
    }
    assert.ok(calls.every(([name]) => name === "getRoles"));
  });

  it("does not grant participant writes to a sponsor-only role", async () => {
    const { app } = setup({ getRoles: async () => ["sponsor"] });
    assert.equal(
      (
        await request(app)
          .post("/api/me/profile")
          .set("Cookie", "session=token")
          .send({ handle: "new-person", displayName: "New person" })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app)
          .put("/api/me/follows/topics/public-topic")
          .set("Cookie", "session=token")
      ).status,
      403,
    );
  });
});

describe("identity SQL boundaries", () => {
  it("limits private profile reads and writes to the owner", async () => {
    const queries = [];
    const repository = createIdentityRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return {
          rows: sql.includes("AS following") ? [{ following: false }] : [],
          rowCount: 0,
        };
      },
    });
    assert.equal(await repository.getProfile("7"), null);
    assert.equal(await repository.updateProfile("7", { bio: null }), null);
    assert.deepEqual(await repository.getRoles("7"), []);
    assert.equal(
      await repository.isFollowing("7", "topic", "public-topic"),
      false,
    );
    assert.deepEqual(await repository.listFollows("7", 1, 2), {
      items: [],
      pagination: { limit: 1, offset: 2, hasMore: false },
    });
    await repository.unfollow("7", "profile", "alex-public");
    assert.ok(queries.every(({ values }) => values?.[0] === "7"));
    assert.ok(queries[1].sql.includes("publication_state <> 'hidden'"));
    assert.ok(queries[4].sql.includes("publication_state = 'published'"));
  });

  it("stores owned profile fields and paginates public social history", async () => {
    const calls = [];
    const follow = {
      id: "f1",
      targetType: "topic",
      slug: "public-topic",
      title: "Public topic",
    };
    const event = {
      id: "1",
      eventType: "follows.insert",
      occurredAt: new Date(),
    };
    const database = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes("INSERT INTO public_profiles"))
          return { rows: [owned] };
        if (sql.includes("UPDATE public_profiles")) return { rows: [owned] };
        if (sql.includes("DELETE FROM identity_audit_events"))
          return { rowCount: 2 };
        if (sql.includes("FROM identity_audit_events"))
          return { rows: [event, event] };
        if (sql.includes("UNION ALL")) return { rows: [follow, follow] };
        return { rows: [] };
      },
    };
    const repository = createIdentityRepository(database);
    assert.equal(
      (await repository.createProfile("7", "my-profile", "My Profile", null))
        .handle,
      "my-profile",
    );
    assert.equal(
      (
        await repository.updateProfile("7", {
          displayName: "Updated",
          publicationState: "published",
        })
      ).id,
      owned.id,
    );
    assert.deepEqual(calls[1].values, [
      "7",
      true,
      "Updated",
      false,
      null,
      true,
      "published",
    ]);
    assert.equal(
      (await repository.listFollows("7", 1, 0)).pagination.hasMore,
      true,
    );
    assert.equal(
      (await repository.listActivity("7", 1, 10)).items[0].eventType,
      "follows.insert",
    );
    assert.equal(await repository.deleteExpiredAudit(), 2);
  });

  it("uses published targets, handles self-follow, and keeps unfollow idempotent", async () => {
    const calls = [];
    const results = ["created", "exists", "self", "missing"];
    const repository = createIdentityRepository({
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [{ result: results.shift() ?? "missing" }] };
      },
    });
    assert.equal(
      await repository.follow("7", "topic", "public-topic"),
      "created",
    );
    assert.equal(
      await repository.follow("7", "profile", "alex-public"),
      "exists",
    );
    assert.equal(await repository.follow("7", "profile", "my-profile"), "self");
    assert.equal(
      await repository.follow("7", "topic", "missing-topic"),
      "missing",
    );
    assert.ok(calls[0].sql.includes("publication_state = 'published'"));
    assert.ok(calls[1].sql.includes("user_id <> $1"));
    assert.ok(calls[2].sql.includes("public_profiles"));
    await repository.unfollow("7", "topic", "public-topic");
    assert.ok(calls.at(-1).sql.includes("f.topic_id"));
  });
});
