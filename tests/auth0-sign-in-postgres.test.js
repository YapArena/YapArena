import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { SignInError } from "../dist/platform/auth/auth0-accounts.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import request from "../scripts/test-http-request.ts";
import {
  clientId,
  continueTarget,
  createAuth0TestApp,
  me,
  origin,
  sessionCookie,
  signIn,
  startSignIn,
} from "./helpers/auth0-app.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;

const address = () => `${randomUUID()}@example.test`;
const emailIdentity = (
  email = address(),
  subject = `email|${randomUUID()}`,
) => ({
  subject,
  email,
});
const googleIdentity = (
  email = address(),
  subject = `google-oauth2|${randomUUID()}`,
) => ({ subject, email });

describe(
  "Auth0 sign-in callback, mapping and linking in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, context;
    before(async () => {
      for (const input of [ownerUrl, runtimeUrl]) {
        const url = new URL(input);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      context = await createAuth0TestApp(runtime);
    });
    after(async () => {
      await context?.issuer.close();
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    const mappings = async (email) =>
      (
        await owner.query(
          `SELECT subject,user_id::text AS "userId",methods->>0 AS method
           FROM provider_identities WHERE provider='auth0' AND email=$1 ORDER BY subject`,
          [email],
        )
      ).rows;
    const accountCount = async (email) =>
      Number(
        (
          await owner.query(
            `SELECT count(DISTINCT user_id) AS count FROM provider_identities
             WHERE provider='auth0' AND email=$1`,
            [email],
          )
        ).rows[0].count,
      );
    // Moves a one-use row into the past. Only the owner may bypass the
    // one-use guard, and only inside this transaction.
    async function expire(table, where, values) {
      const trigger = {
        auth_login_transactions: "auth_login_transaction_guard",
        auth_pending_links: "auth_pending_link_guard",
      }[table];
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        const updated = await client.query(
          `UPDATE ${table} SET created_at=clock_timestamp()-interval '11 minutes',
             expires_at=clock_timestamp()-interval '10 minutes' WHERE ${where}`,
          values,
        );
        assert.equal(updated.rowCount, 1);
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const page = (response) =>
      response.text.replaceAll("&#39;", "'").replaceAll("&amp;", "&");

    it("creates an account for a new verified email and signs in with a rotated session", async () => {
      const identity = emailIdentity();
      const { agent, callback, location } = await signIn(context, identity, {
        query: "connection=email&return=%2Fdebates%3Fq%3Dai",
      });
      const authorization = new URL(location);
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert.equal(authorization.searchParams.get("client_id"), clientId);
      assert.equal(authorization.searchParams.get("connection"), "email");
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        `${origin}/api/auth/callback`,
      );
      for (const key of ["state", "nonce", "code_challenge"])
        assert.ok(authorization.searchParams.get(key)?.length >= 43);
      assert.equal(authorization.searchParams.has("prompt"), false);
      assert.equal(callback.status, 200);
      assert.equal(callback.headers["cache-control"], "no-store");
      assert.equal(continueTarget(callback), "/debates?q=ai");
      assert.match(sessionCookie(callback), /HttpOnly; SameSite=Strict/);
      const user = await me(agent);
      assert.ok(user);
      assert.deepEqual(await mappings(identity.email), [
        { subject: identity.subject, userId: user.id, method: "email" },
      ]);
      const methods = await agent.get("/api/auth/methods").expect(200);
      assert.deepEqual(
        methods.body.methods.map(({ method, email }) => ({ method, email })),
        [{ method: "email", email: identity.email }],
      );
      // The same subject signs in to the same account and refreshes the
      // email snapshot without creating another account.
      const again = await signIn(context, {
        ...identity,
        email: identity.email.toUpperCase(),
      });
      assert.equal((await me(again.agent)).id, user.id);
      assert.equal(await accountCount(identity.email), 1);
    });

    it("keeps an existing session instead of signing in again", async () => {
      const { agent } = await signIn(context, emailIdentity());
      const before = context.issuer.requests.length;
      const response = await agent
        .get("/api/auth/login?connection=google&return=%2Flive")
        .expect(303);
      assert.equal(response.headers.location, "/live");
      assert.equal(context.issuer.requests.length, before);
    });

    it("refuses a bad, replayed, expired or foreign-browser state", async () => {
      const agent = request.agent(context.app);
      const identity = emailIdentity();
      const location = await startSignIn(agent);
      const forged = await agent.get(
        context.issuer.authorize(location, identity, { state: "x".repeat(43) }),
      );
      assert.equal(forged.status, 400);
      assert.match(page(forged), /expired or was already used/);
      assert.equal(sessionCookie(forged), undefined);

      const fresh = await startSignIn(agent);
      const callback = context.issuer.authorize(fresh, identity);
      const stranger = await request(context.app).get(callback);
      assert.equal(stranger.status, 400, "no binding cookie");
      assert.equal((await agent.get(callback)).status, 200);
      const replay = await agent.get(callback);
      assert.equal(replay.status, 400, "a state is consumed once");
      assert.equal(sessionCookie(replay), undefined);

      const later = request.agent(context.app);
      const stale = await startSignIn(later);
      const state = new URL(stale).searchParams.get("state");
      const digest = (
        await owner.query(
          "SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS digest",
          [state],
        )
      ).rows[0].digest;
      await expire("auth_login_transactions", "state_digest=$1", [digest]);
      const expired = await later.get(
        context.issuer.authorize(stale, emailIdentity()),
      );
      assert.equal(expired.status, 400);
      assert.equal(sessionCookie(expired), undefined);
    });

    for (const [name, tamper] of [
      ["a nonce mismatch", { claims: { nonce: "a".repeat(43) } }],
      ["the wrong issuer", { claims: { iss: "https://issuer.example.test/" } }],
      ["the wrong audience", { claims: { aud: "another-client-0123" } }],
      [
        "an expired token",
        {
          claims: {
            exp: Math.floor(Date.now() / 1000) - 300,
            iat: Math.floor(Date.now() / 1000) - 900,
          },
        },
      ],
      ["a signature from another key", { foreignKey: true }],
    ])
      it(`refuses ${name} without creating an account`, async () => {
        const agent = request.agent(context.app);
        const identity = emailIdentity();
        const location = await startSignIn(agent);
        const response = await agent.get(
          context.issuer.authorize(location, identity, tamper),
        );
        assert.equal(response.status, 401);
        assert.match(page(response), /couldn't verify this sign-in/);
        assert.equal(sessionCookie(response), undefined);
        assert.deepEqual(await mappings(identity.email), []);
      });

    it("requires a verified email", async () => {
      const identity = { ...emailIdentity(), emailVerified: false };
      const { callback } = await signIn(context, identity);
      assert.equal(callback.status, 401);
      assert.match(page(callback), /isn't verified/);
      assert.match(page(callback), /support/);
      assert.equal(sessionCookie(callback), undefined);
      assert.deepEqual(await mappings(identity.email), []);
    });

    it("refuses connections other than email codes and Google", async () => {
      const identity = { subject: `github|${randomUUID()}`, email: address() };
      const { callback } = await signIn(context, identity);
      assert.equal(callback.status, 401);
      assert.match(page(callback), /Google and email-code sign-in only/);
    });

    it("reports a cancelled sign-in without creating anything", async () => {
      const agent = request.agent(context.app);
      const location = await startSignIn(agent, "connection=google");
      const response = await agent.get(context.issuer.deny(location));
      assert.equal(response.status, 400);
      assert.match(page(response), /cancelled/);
      assert.equal(sessionCookie(response), undefined);
    });

    it("rejects an unknown method and serves safe return paths only", async () => {
      await request(context.app)
        .get("/api/auth/login?connection=github")
        .expect(400);
      for (const unsafe of [
        "//evil.example/path",
        "https://evil.example/",
        "/\\evil.example",
        "/api/auth/logout",
        "javascript:alert(1)",
        "/%0d%0aSet-Cookie:x=y",
      ]) {
        const { callback } = await signIn(context, emailIdentity(), {
          query: `connection=email&return=${encodeURIComponent(unsafe)}`,
        });
        assert.equal(callback.status, 200);
        const target = continueTarget(callback);
        assert.ok(
          target === "/home" || target === "/%0d%0aSet-Cookie:x=y",
          `${unsafe} -> ${target}`,
        );
        assert.equal(new URL(target, origin).origin, origin);
      }
    });

    it("refuses a suspended account", async () => {
      const identity = emailIdentity();
      const { agent } = await signIn(context, identity);
      const user = await me(agent);
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [user.id],
      );
      assert.equal(await me(agent), null, "suspension ends sessions");
      const again = await signIn(context, identity);
      assert.equal(again.callback.status, 403);
      assert.match(page(again.callback), /can't sign in/);
      assert.equal(sessionCookie(again.callback), undefined);
      // Another method for the same address cannot reach it either.
      const google = await signIn(context, googleIdentity(identity.email));
      assert.equal(google.callback.status, 403);
      assert.deepEqual(
        (await mappings(identity.email)).map((row) => row.method),
        ["email"],
      );
    });

    it("reports an unavailable provider without signing in", async () => {
      const agent = request.agent(context.app);
      const location = await startSignIn(agent);
      context.issuer.setAvailable(false);
      try {
        const response = await agent.get(
          context.issuer.authorize(location, emailIdentity()),
        );
        assert.equal(response.status, 503);
        assert.match(page(response), /temporarily unavailable/);
      } finally {
        context.issuer.setAvailable(true);
      }
    });

    it("signs out this device and returns the provider logout address", async () => {
      const { agent } = await signIn(context, emailIdentity());
      const other = await signIn(context, emailIdentity());
      const response = await agent
        .post("/api/auth/logout")
        .set("Origin", origin)
        .expect(200);
      const logout = new URL(response.body.redirectTo);
      assert.equal(`${logout.origin}/`, context.issuer.issuer);
      assert.equal(logout.pathname, "/v2/logout");
      assert.equal(logout.searchParams.get("client_id"), clientId);
      assert.equal(logout.searchParams.get("returnTo"), `${origin}/`);
      assert.equal(await me(agent), null);
      assert.ok(await me(other.agent), "other devices stay signed in");
      const ended = await agent.post("/api/auth/logout").expect(401);
      assert.equal(ended.body.redirectTo, response.body.redirectTo);
    });

    describe("linking Google and email codes", () => {
      it("sends a Google match through an email code before linking or signing in", async () => {
        const email = address();
        const original = emailIdentity(email);
        const account = await me((await signIn(context, original)).agent);
        const google = googleIdentity(email);
        const agent = request.agent(context.app);
        const location = await startSignIn(
          agent,
          "connection=google&return=%2Flive",
        );
        const step = await agent.get(
          context.issuer.authorize(location, google),
        );
        assert.equal(step.status, 303, "no account and no session yet");
        assert.equal(sessionCookie(step), undefined);
        assert.equal(await me(agent), null);
        assert.equal(await accountCount(email), 1);
        const code = new URL(step.headers.location);
        assert.equal(code.searchParams.get("connection"), "email");
        assert.equal(code.searchParams.get("login_hint"), email);
        assert.equal(code.searchParams.get("prompt"), "login");
        assert.notEqual(
          code.searchParams.get("state"),
          new URL(location).searchParams.get("state"),
        );
        const done = await agent.get(
          context.issuer.authorize(step.headers.location, original),
        );
        assert.equal(done.status, 200);
        assert.equal(continueTarget(done), "/live");
        assert.equal((await me(agent)).id, account.id);
        assert.deepEqual(
          (await mappings(email)).map(({ method, userId }) => [method, userId]),
          [
            ["email", account.id],
            ["google", account.id],
          ],
        );
        const audit = await owner.query(
          `SELECT subject_id AS method,metadata->>'verifiedBy' AS via FROM identity_audit_events
           WHERE user_id=$1 AND event_type='sign_in.method_linked'`,
          [account.id],
        );
        assert.deepEqual(audit.rows, [{ method: "google", via: "email_code" }]);
        const notices = await owner.query(
          "SELECT message FROM account_notifications WHERE user_id=$1 AND event_type='sign_in.method_linked'",
          [account.id],
        );
        assert.equal(notices.rowCount, 1);
        assert.match(notices.rows[0].message, /^Google sign-in was linked/);
        // Google now signs in directly.
        const direct = await signIn(context, google);
        assert.equal((await me(direct.agent)).id, account.id);
      });

      it("links nothing when the email code is abandoned or expires", async () => {
        const email = address();
        const original = emailIdentity(email);
        await signIn(context, original);
        const google = googleIdentity(email);
        const agent = request.agent(context.app);
        const step = await agent.get(
          context.issuer.authorize(
            await startSignIn(agent, "connection=google"),
            google,
          ),
        );
        assert.equal(step.status, 303);
        const pending = (
          await owner.query(
            "SELECT id FROM auth_pending_links WHERE google_subject=$1",
            [google.subject],
          )
        ).rows[0];
        await expire("auth_pending_links", "id=$1", [pending.id]);
        const late = await agent.get(
          context.issuer.authorize(step.headers.location, original),
        );
        assert.equal(late.status, 409);
        assert.match(page(late), /nothing was changed/);
        assert.equal(sessionCookie(late), undefined);
        assert.deepEqual(
          (await mappings(email)).map((row) => row.method),
          ["email"],
        );
      });

      it("links nothing for a reused link or a code for another address", async () => {
        const email = address();
        const original = emailIdentity(email);
        const account = await me((await signIn(context, original)).agent);
        const google = googleIdentity(email);
        const agent = request.agent(context.app);
        const step = await agent.get(
          context.issuer.authorize(
            await startSignIn(agent, "connection=google"),
            google,
          ),
        );
        const elsewhere = emailIdentity();
        const wrong = await agent.get(
          context.issuer.authorize(step.headers.location, elsewhere),
        );
        assert.equal(wrong.status, 409);
        assert.equal(sessionCookie(wrong), undefined);
        assert.deepEqual(await mappings(elsewhere.email), []);
        const pendingLinkId = (
          await owner.query(
            "SELECT id FROM auth_pending_links WHERE google_subject=$1",
            [google.subject],
          )
        ).rows[0].id;
        const grant = () => ({
          tokenHash: hashSessionToken(randomUUID()),
          expiresAt: new Date(Date.now() + 60_000),
        });
        await assert.rejects(
          context.accounts.signIn(
            { ...original, method: "email", authTime: null },
            { purpose: "link", pendingLinkId },
            grant(),
          ),
          (error) =>
            error instanceof SignInError && error.code === "link_failed",
          "a refused attempt still spends the pending link",
        );
        assert.deepEqual(
          (await mappings(email)).map(({ method, userId }) => [method, userId]),
          [["email", account.id]],
        );
      });

      it("refuses a link when the email code belongs to another account", async () => {
        const email = address();
        await signIn(context, emailIdentity(email));
        const google = googleIdentity(email);
        const agent = request.agent(context.app);
        const step = await agent.get(
          context.issuer.authorize(
            await startSignIn(agent, "connection=google"),
            google,
          ),
        );
        const other = emailIdentity(address());
        const otherAccount = await me((await signIn(context, other)).agent);
        // The other account's subject now claims this address at Auth0.
        const response = await agent.get(
          context.issuer.authorize(step.headers.location, {
            subject: other.subject,
            email,
          }),
        );
        assert.equal(response.status, 409);
        assert.deepEqual(
          (await mappings(email)).map((row) => row.method),
          ["email"],
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS count FROM provider_identities WHERE user_id=$1",
              [otherAccount.id],
            )
          ).rows[0].count,
          1,
        );
      });

      it("attaches an email code to an account created through Google", async () => {
        const email = address();
        const google = googleIdentity(email);
        const created = await signIn(context, google);
        assert.equal(created.callback.status, 200);
        const account = await me(created.agent);
        const code = emailIdentity(email);
        const { agent, callback } = await signIn(context, code);
        assert.equal(callback.status, 200);
        assert.equal((await me(agent)).id, account.id);
        assert.deepEqual(
          (await mappings(email)).map(({ method, userId }) => [method, userId]),
          [
            ["email", account.id],
            ["google", account.id],
          ],
        );
        const audit = await owner.query(
          `SELECT subject_id AS method,metadata->>'verifiedBy' AS via FROM identity_audit_events
           WHERE user_id=$1 AND event_type='sign_in.method_linked'`,
          [account.id],
        );
        assert.deepEqual(audit.rows, [{ method: "email", via: "sign_in" }]);
      });

      it("attaches a re-created email identity to the account with that address", async () => {
        const email = address();
        const account = await me(
          (await signIn(context, emailIdentity(email))).agent,
        );
        const recreated = await signIn(context, emailIdentity(email));
        assert.equal((await me(recreated.agent)).id, account.id);
        assert.equal(await accountCount(email), 1);
        assert.equal((await mappings(email)).length, 2);
      });

      it("refuses an address shared by several accounts", async () => {
        const email = address();
        for (const method of ["email", "google"]) {
          const user = (
            await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
          ).rows[0];
          await owner.query(
            `INSERT INTO provider_identities(provider,subject,user_id,email,methods)
             VALUES('auth0',$1,$2,$3,$4::jsonb)`,
            [
              `${method === "google" ? "google-oauth2" : "email"}|${randomUUID()}`,
              user.id,
              email,
              JSON.stringify([method]),
            ],
          );
        }
        for (const identity of [emailIdentity(email), googleIdentity(email)]) {
          const { callback } = await signIn(context, identity);
          assert.equal(callback.status, 409);
          assert.match(page(callback), /more than one account/);
          assert.equal(sessionCookie(callback), undefined);
        }
        assert.equal(await accountCount(email), 2);
      });

      it("links at most once when attempts race", async () => {
        const email = address();
        const original = emailIdentity(email);
        const account = await me((await signIn(context, original)).agent);
        const google = googleIdentity(email);
        const grant = () => ({
          tokenHash: hashSessionToken(randomUUID()),
          expiresAt: new Date(Date.now() + 60_000),
        });
        const pending = await Promise.all(
          [1, 2, 3].map(() =>
            context.accounts.signIn(
              { ...google, method: "google", authTime: null },
              { purpose: "sign_in" },
              grant(),
            ),
          ),
        );
        assert.ok(pending.every((result) => result.kind === "link_required"));
        const results = await Promise.all(
          pending.map((result) =>
            context.accounts.signIn(
              { ...original, method: "email", authTime: null },
              { purpose: "link", pendingLinkId: result.pendingLinkId },
              grant(),
            ),
          ),
        );
        assert.ok(results.every((result) => result.user.id === account.id));
        assert.equal(
          results.filter((result) => result.linked.includes("google")).length,
          1,
        );
        assert.equal(
          (
            await owner.query(
              `SELECT count(*)::int AS count FROM identity_audit_events
               WHERE user_id=$1 AND event_type='sign_in.method_linked'`,
              [account.id],
            )
          ).rows[0].count,
          1,
        );
        // Two first sign-ins for a new address create one account.
        const fresh = address();
        const raced = await Promise.all([
          context.accounts.signIn(
            { ...emailIdentity(fresh), method: "email", authTime: null },
            { purpose: "sign_in" },
            grant(),
          ),
          context.accounts.signIn(
            { ...googleIdentity(fresh), method: "google", authTime: null },
            { purpose: "sign_in" },
            grant(),
          ),
        ]);
        assert.equal(
          raced.filter((result) => result.kind === "session" && result.created)
            .length,
          1,
        );
        assert.equal(await accountCount(fresh), 1);
      });
    });
  },
);
