import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "../scripts/test-http-request.ts";
import { createApp } from "../dist/app.js";
import { verifyRuntimeIdentity } from "../dist/platform/database.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  ACCOUNT_REVOKED_CHANNEL,
  createSessionRepository,
  insertSession,
  lockAccount,
  revokeAccountSessions,
  SessionUnavailableError,
} from "../dist/platform/auth/sessions.js";
import {
  AccountStatusError,
  changeAccountStatus,
} from "../dist/platform/auth/account-status.js";
import { runCommand } from "../scripts/suspend-account.ts";
import { createAuth0Client } from "../dist/platform/auth/auth0.js";
import {
  createAuth0Accounts,
  SignInError,
} from "../dist/platform/auth/auth0-accounts.js";
import { createSignInState } from "../dist/platform/auth/sign-in-state.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";

const connectionString = process.env.REVOCATION_TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
const origin = "http://localhost:53023";
const issuer = new URL("https://synthetic-issuer.example.test/");
const logger = createLogger({ enabled: false });
const expiresAt = () => new Date(Date.now() + 600000);
const namespace = randomUUID();
let owner, firstPool, secondPool, sessions, appA, appB;
const accounts = [];
let counter = 0;
function app(pool, overrides = {}) {
  return createApp({
    messages: { isReady: async () => {} },
    sessions: createSessionRepository(pool),
    environment: "production",
    applicationOrigin: origin,
    authRateLimit: 1000,
    apiRateLimit: 10000,
    logger,
    // Only the provider's logout URL is built here, locally. Sign-in goes
    // through the post-callback account mapping, so no issuer is contacted.
    auth0: {
      client: createAuth0Client(
        {
          issuer,
          clientId: "synthetic-client",
          clientSecret: "synthetic-secret",
        },
        { redirectUri: `${origin}/api/auth/callback` },
      ),
      accounts: createAuth0Accounts(pool),
      state: createSignInState(pool),
    },
    ...overrides,
  });
}
function post(instance, path, cookie) {
  const call = request(instance)
    .post(`/api/auth/${path}`)
    .set("Origin", origin);
  return cookie ? call.set("Cookie", cookie) : call;
}
const me = (instance, cookie) =>
  request(instance).get("/api/auth/me").set("Cookie", cookie);
const generationOf = async (user) =>
  (
    await owner.query(
      "SELECT auth_generation::text AS generation FROM users WHERE id=$1",
      [user.id],
    )
  ).rows[0].generation;
const sessionCount = async (user) =>
  (
    await owner.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
      [user.id],
    )
  ).rows[0].n;
// An account with one Auth0 email-code subject, as a first sign-in leaves it.
async function account() {
  const user = (
    await owner.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation AS "authGeneration"`,
    )
  ).rows[0];
  accounts.push(user.id);
  user.email = `f03-${namespace}-${counter++}@example.test`;
  user.subject = `email|${randomUUID()}`;
  await owner.query(
    `INSERT INTO provider_identities(provider,subject,user_id,email,methods)
     VALUES('auth0',$1,$2,$3,'["email"]'::jsonb)`,
    [user.subject, user.id, user.email],
  );
  return user;
}
const identity = (user, subject = user.subject) => ({
  subject,
  email: user.email,
  method: "email",
  authTime: Math.floor(Date.now() / 1000),
});
// The verified-callback sign-in path, on the instance that owns `pool`.
async function login(user, pool = firstPool) {
  const { token, tokenHash } = createSessionToken();
  const result = await createAuth0Accounts(pool).signIn(
    identity(user),
    { purpose: "sign_in" },
    { tokenHash, expiresAt: expiresAt() },
  );
  assert.equal(result.kind, "session");
  assert.equal(result.user.id, user.id);
  assert.equal(result.created, false);
  return `__Host-session=${token}`;
}
async function waitForLock(applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await firstPool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected database lock wait for ${applicationName}`);
}

// These tests run against a disposable migrated database, never a staging/production URL.
// Two separate pools and Express instances exercise the shared PostgreSQL boundary.
describe(
  "PostgreSQL account revocation and controlled interleavings",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      const url = new URL(connectionString);
      assert.match(
        url.pathname,
        /^\/(?:yaparena_f03|yaparena_f02|revocation_test)[a-z0-9_]*$/,
      );
      owner = new pg.Pool({ connectionString });
      firstPool = new pg.Pool({
        connectionString:
          process.env.REVOCATION_TEST_RUNTIME_URL || connectionString,
        application_name: "f03-instance-a",
      });
      secondPool = new pg.Pool({
        connectionString:
          process.env.REVOCATION_TEST_RUNTIME_URL || connectionString,
        application_name: "f03-instance-b",
      });
      sessions = createSessionRepository(firstPool);
      appA = app(firstPool);
      appB = app(secondPool);
    });
    after(async () => {
      if (owner) {
        await owner.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [
          accounts,
        ]);
        await owner.query(
          "DELETE FROM identity_audit_events WHERE user_id = ANY($1::bigint[])",
          [accounts],
        );
      }
      await Promise.all([owner?.end(), firstPool?.end(), secondPool?.end()]);
    });

    it("sign out ends only this device across instances; the other device and the account generation are unchanged", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, secondPool);
      const before = await generationOf(user);
      const result = await post(appA, "logout", a);
      assert.equal(result.status, 200);
      // The browser then visits the provider's logout endpoint.
      const redirect = new URL(result.body.redirectTo);
      assert.equal(redirect.href.split("?")[0], `${issuer.href}v2/logout`);
      assert.equal(redirect.searchParams.get("returnTo"), `${origin}/`);
      assert.equal(result.headers["set-cookie"], undefined);
      for (const instance of [appA, appB]) {
        assert.equal((await me(instance, a)).status, 401);
        assert.equal((await me(instance, b)).status, 200);
      }
      assert.equal(await generationOf(user), before);
      assert.equal((await post(appB, "logout", a)).status, 401);
      const fresh = await login(user, secondPool);
      assert.equal((await me(appA, fresh)).status, 200);
      const audit = await owner.query(
        "SELECT event_type AS type, subject_id AS subject, metadata FROM identity_audit_events WHERE user_id = $1 AND event_type IN ('sessions.logout_one','sessions.logout_all','sessions.logout_others','sessions.incident')",
        [user.id],
      );
      assert.deepEqual(
        audit.rows.map((row) => row.type),
        ["sessions.logout_one"],
      );
      assert.equal(
        audit.rows[0].subject,
        audit.rows[0].metadata.actorSessionId,
      );
      assert.equal(audit.rows[0].metadata.actorUserId, user.id);
      assert.equal(audit.rows[0].metadata.outcome, "success");
      assert.ok(audit.rows[0].metadata.requestId);
      assert.doesNotMatch(
        JSON.stringify(audit.rows),
        /token|cookie|password|signature/i,
      );
    });

    it("offers no sign-out-everywhere or sign-out-others routes", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, secondPool);
      for (const path of ["logout-all", "logout-other-sessions"])
        assert.equal((await post(appA, path, a)).status, 404);
      assert.equal((await me(appA, a)).status, 200);
      assert.equal((await me(appB, b)).status, 200);
    });

    it("rejects unauthenticated, cross-account selectors, and foreign sessions even after middleware", async () => {
      const user = await account(),
        other = await account();
      const a = await login(user),
        b = await login(other, secondPool);
      assert.equal((await post(appA, "logout")).status, 401);
      assert.equal(
        (await post(appA, "logout", a).send({ userId: other.id })).status,
        400,
      );
      assert.equal(
        (
          await post(appA, "logout", a).set(
            "Origin",
            "https://attacker.example",
          )
        ).status,
        403,
      );
      await assert.rejects(
        sessions.revokeSession(other.id, hashSessionToken(a.split("=")[1])),
        SessionUnavailableError,
      );
      assert.equal(
        await sessions.revokeSession(
          user.id,
          hashSessionToken(a.split("=")[1]),
          (
            await owner.query(
              "SELECT id::text FROM sessions WHERE token_hash=$1",
              [hashSessionToken(b.split("=")[1])],
            )
          ).rows[0].id,
        ),
        null,
      );
      assert.equal((await me(appB, b)).status, 200);
      assert.equal((await me(appA, a)).status, 200);
    });

    it("an incident revocation is atomic: rollback restores the generation and sessions; commit ends them and a fresh sign-in works", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, secondPool);
      const incidents = async () =>
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.incident'",
            [user.id],
          )
        ).rows[0].n;
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        await revokeAccountSessions(client, user.id, {
          action: "sessions.incident",
        });
        await client.query("ROLLBACK");
        assert.equal(
          await sessionCount(user),
          2,
          "rollback restores both session rows",
        );
        assert.equal(
          await generationOf(user),
          user.authGeneration,
          "rollback restores the generation",
        );
        assert.equal(await incidents(), 0);
        assert.equal((await me(appB, a)).status, 200);
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        const generation = await revokeAccountSessions(client, user.id, {
          action: "sessions.incident",
        });
        await client.query("COMMIT");
        assert.equal(await generationOf(user), generation);
        assert.ok(BigInt(generation) > BigInt(user.authGeneration));
        assert.equal(await incidents(), 1);
        for (const oldCookie of [a, b])
          for (const instance of [appA, appB])
            assert.equal((await me(instance, oldCookie)).status, 401);
        assert.equal(
          (await me(appA, await login(user, secondPool))).status,
          200,
        );
      } finally {
        client.release();
      }
    });

    it("a sign-in waiting behind a locked revocation or suspension reads the committed account state", async () => {
      for (const mutate of ["revocation", "suspension"]) {
        const user = await account();
        const earlier = await login(user);
        const { token, tokenHash } = createSessionToken();
        const client = await owner.connect();
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        const signIn = createAuth0Accounts(secondPool).signIn(
          identity(user),
          { purpose: "sign_in" },
          { tokenHash, expiresAt: expiresAt() },
        );
        const settled = signIn.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await waitForLock("f03-instance-b");
          if (mutate === "revocation")
            await revokeAccountSessions(client, user.id, {
              action: "sessions.incident",
            });
          else
            await client.query(
              "UPDATE users SET account_status='suspended' WHERE id=$1",
              [user.id],
            );
          await client.query("COMMIT");
          const outcome = await settled;
          assert.equal((await me(appA, earlier)).status, 401);
          if (mutate === "revocation") {
            // Ordered after the revocation, the sign-in issues its session
            // at the new generation instead of an obsolete one.
            assert.equal(outcome.value.kind, "session");
            assert.equal(
              outcome.value.user.authGeneration,
              await generationOf(user),
            );
            assert.equal(
              (await me(appA, `__Host-session=${token}`)).status,
              200,
            );
            assert.equal(await sessionCount(user), 1);
          } else {
            assert.ok(outcome.error instanceof SignInError);
            assert.equal(outcome.error.code, "account_unavailable");
            assert.equal(await sessions.findUserByTokenHash(tokenHash), null);
            assert.equal(await sessionCount(user), 0);
          }
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    });

    it("session issuance waiting behind a locked revocation fails with its obsolete snapshot", async () => {
      const user = await account();
      const client = await owner.connect();
      await client.query("BEGIN");
      await lockAccount(client, user.id);
      const issuance = createSessionRepository(secondPool).create(
        user.id,
        hashSessionToken("blocked-issuance"),
        expiresAt(),
        { authGeneration: user.authGeneration },
      );
      const rejected = assert.rejects(issuance, SessionUnavailableError);
      try {
        await waitForLock("f03-instance-b");
        await revokeAccountSessions(client, user.id, {
          action: "sessions.incident",
        });
        await client.query("COMMIT");
        await rejected;
        const incident = await owner.query(
          "SELECT metadata FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.incident'",
          [user.id],
        );
        assert.equal(
          incident.rows[0].metadata.actorUserId,
          undefined,
          "operator incidents must not attribute the action to the affected owner",
        );
        assert.ok(incident.rows[0].metadata.actorDatabaseRole);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("issuance ordered first is deleted by a waiting revocation, including across instances", async () => {
      const user = await account();
      await login(user);
      const client = await owner.connect();
      const token = hashSessionToken("issued-before-revoke");
      await client.query("BEGIN");
      const locked = await lockAccount(client, user.id);
      await insertSession(
        client,
        user.id,
        token,
        expiresAt(),
        locked.authGeneration,
      );
      const revocation = endAllAccountSessions(secondPool, user.id);
      try {
        await waitForLock("f03-instance-b");
        await client.query("COMMIT");
        await revocation;
        assert.equal(await sessions.findUserByTokenHash(token), null);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("revocation and session replacement roll back together; a transaction-local successor is unavailable before commit", async () => {
      const user = await account();
      const cookie = await login(user);
      const client = await owner.connect();
      const successor = hashSessionToken("rollback-successor");
      try {
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        const generation = await revokeAccountSessions(client, user.id, {
          action: "sessions.incident",
        });
        await insertSession(
          client,
          user.id,
          successor,
          expiresAt(),
          generation,
        );
        assert.equal(
          await createSessionRepository(secondPool).findUserByTokenHash(
            successor,
          ),
          null,
        );
        await client.query("ROLLBACK");
        assert.equal(await sessions.findUserByTokenHash(successor), null);
        assert.equal((await me(appB, cookie)).status, 200);
        assert.equal(await generationOf(user), user.authGeneration);
      } finally {
        client.release();
      }
    });

    it("sign-in session-insert failure rolls back a newly linked email subject; a retry links it once", async () => {
      const user = await account();
      // A second email-code subject for the same address joins the account.
      const subject = `email|${randomUUID()}`;
      const brokenPool = {
        async connect() {
          const client = await firstPool.connect();
          return {
            query: async (sql, values) => {
              if (sql.includes("INSERT INTO sessions"))
                throw new Error("synthetic issuance failure");
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      };
      const failed = createSessionToken();
      await assert.rejects(
        createAuth0Accounts(brokenPool).signIn(
          identity(user, subject),
          { purpose: "sign_in" },
          { tokenHash: failed.tokenHash, expiresAt: expiresAt() },
        ),
        /synthetic issuance failure/,
      );
      const linked = async () =>
        (
          await owner.query(
            `SELECT (SELECT count(*)::int FROM provider_identities WHERE provider='auth0' AND subject=$2) AS subjects,
               (SELECT count(*)::int FROM identity_audit_events WHERE user_id=$1 AND event_type='sign_in.method_linked') AS events,
               (SELECT count(*)::int FROM account_notifications WHERE user_id=$1 AND event_type='sign_in.method_linked') AS notices`,
            [user.id, subject],
          )
        ).rows[0];
      assert.deepEqual(await linked(), { subjects: 0, events: 0, notices: 0 });
      assert.equal(await sessions.findUserByTokenHash(failed.tokenHash), null);
      const { token, tokenHash } = createSessionToken();
      const completed = await createAuth0Accounts(firstPool).signIn(
        identity(user, subject),
        { purpose: "sign_in" },
        { tokenHash, expiresAt: expiresAt() },
      );
      assert.equal(completed.user.id, user.id);
      assert.deepEqual(completed.linked, ["email"]);
      assert.deepEqual(await linked(), { subjects: 1, events: 1, notices: 1 });
      assert.equal((await me(appB, `__Host-session=${token}`)).status, 200);
    });

    it("database rejects old-binary inserts and explicit obsolete generations; expiry stays authoritative", async () => {
      const user = await account();
      await assert.rejects(
        owner.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
          [user.id, hashSessionToken("legacy"), expiresAt()],
        ),
        { code: "40001" },
      );
      await assert.rejects(
        owner.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at,auth_generation) VALUES($1,$2,$3,-1)",
          [user.id, hashSessionToken("stale"), expiresAt()],
        ),
        { code: "40001" },
      );
      const token = hashSessionToken("expired");
      await sessions.create(user.id, token, new Date(Date.now() - 1000), user);
      assert.equal(await sessions.findUserByTokenHash(token), null);
      assert.ok(await sessions.deleteExpired());
      await assert.rejects(
        owner.query("UPDATE users SET auth_generation=-1 WHERE id=$1", [
          user.id,
        ]),
        /cannot decrease/,
      );
    });
    it("reports which sessions are still valid for open live streams (YA-09)", async () => {
      const user = await account();
      const first = await login(user);
      const second = await login(user);
      const hash = (cookie) => hashSessionToken(cookie.split("=")[1]);
      const active = async (...hashes) =>
        [...(await sessions.activeTokenHashes(hashes))].sort();
      assert.deepEqual(
        await active(hash(first), hash(second), "0".repeat(64)),
        [hash(first), hash(second)].sort(),
      );
      assert.equal((await post(appA, "logout", first)).status, 200);
      assert.deepEqual(await active(hash(first), hash(second)), [hash(second)]);
      await endAllAccountSessions(firstPool, user.id);
      assert.deepEqual(await active(hash(second)), []);
      assert.deepEqual(await active(), []);
    });

    it("runtime role can revoke but cannot edit account email or execute trigger functions directly", async () => {
      if (!process.env.REVOCATION_TEST_RUNTIME_URL) return;
      await verifyRuntimeIdentity(firstPool);
      const user = await account();
      await assert.rejects(
        firstPool.query(
          "UPDATE users SET email='forbidden@example.test' WHERE id=$1",
          [user.id],
        ),
        { code: "42501" },
      );
      const result = await firstPool.query(
        "SELECT has_function_privilege(current_user, 'enforce_session_generation()', 'EXECUTE') AS executable",
      );
      assert.equal(result.rows[0].executable, false);
      const cookie = await login(user);
      assert.equal((await post(appB, "logout", cookie)).status, 200);
      await login(user);
      await endAllAccountSessions(firstPool, user.id);
      assert.equal(await sessionCount(user), 0);
    });

    it("the owner suspension command ends sessions and streams with a recorded reason; reinstating allows sign-in", async () => {
      // YA-08. The command and the module both require the dedicated owner login.
      if (new URL(connectionString).username !== "yaparena_owner") return;
      const user = await account();
      const cookie = await login(user);
      const listener = await firstPool.connect();
      const notices = [];
      listener.on("notification", (message) => {
        if (message.channel === ACCOUNT_REVOKED_CHANNEL)
          notices.push(message.payload);
      });
      await listener.query(`LISTEN ${ACCOUNT_REVOKED_CHANNEL}`);
      const command = (...argv) => runCommand({ argv, connectionString });
      try {
        // Without --execute the command previews and changes nothing.
        assert.deepEqual(
          await command("suspend", user.id, "Synthetic preview only"),
          {
            changed: true,
            status: "suspended",
            endedSessions: 1,
            executed: false,
          },
        );
        assert.equal(await sessionCount(user), 1);
        assert.equal((await me(appA, cookie)).status, 200);
        assert.deepEqual(
          await command(
            "suspend",
            user.id,
            "Synthetic abuse report",
            "--execute",
          ),
          {
            changed: true,
            status: "suspended",
            endedSessions: 1,
            executed: true,
          },
        );
        assert.equal(await sessionCount(user), 0);
        assert.equal((await me(appA, cookie)).status, 401);
        await assert.rejects(login(user));
        const deadline = Date.now() + 5000;
        while (!notices.length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        // Only the committed suspension reached the web processes' streams.
        assert.deepEqual(notices, [user.id]);
        const audit = async () =>
          (
            await owner.query(
              "SELECT event_type, metadata FROM identity_audit_events WHERE user_id=$1 ORDER BY id",
              [user.id],
            )
          ).rows;
        const suspended = await audit();
        assert.deepEqual(
          suspended.slice(-2).map((event) => event.event_type),
          ["sessions.incident", "account.suspended"],
        );
        assert.deepEqual(suspended.at(-1).metadata, {
          actorDatabaseRole: "yaparena_owner",
          outcome: "success",
          previousStatus: "active",
          reason: "Synthetic abuse report",
        });
        assert.equal(
          (
            await command(
              "suspend",
              user.id,
              "Synthetic repeat request",
              "--execute",
            )
          ).changed,
          false,
        );
        await assert.rejects(
          command("suspend", user.id, "no", "--execute"),
          AccountStatusError,
        );
        if (process.env.REVOCATION_TEST_RUNTIME_URL) {
          const client = await firstPool.connect();
          try {
            await client.query("BEGIN");
            await assert.rejects(
              changeAccountStatus(client, {
                userId: user.id,
                change: "reinstate",
                reason: "Runtime cannot do this",
              }),
              AccountStatusError,
            );
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        }
        assert.equal(
          (
            await command(
              "reinstate",
              user.id,
              "Synthetic appeal upheld",
              "--execute",
            )
          ).status,
          "active",
        );
        assert.equal((await audit()).at(-1).event_type, "account.reinstated");
        const fresh = await login(user);
        assert.equal((await me(appA, fresh)).status, 200);
        assert.deepEqual(notices, [user.id]);
      } finally {
        await listener.query(`UNLISTEN ${ACCOUNT_REVOKED_CHANNEL}`);
        listener.release();
      }
    });
  },
);
