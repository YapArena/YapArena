import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createIdentityRepository } from "../dist/features/identity/repository.js";

// The handle pop-up's age and terms confirmation (founder, 2026-10-30) is
// written in the same statement as the profile.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "terms acceptance with the first profile",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, identity;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      identity = createIdentityRepository(runtime);
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    const user = async () =>
      (await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id::text"))
        .rows[0].id;
    const handle = () => `terms-${randomUUID().slice(0, 8)}`;
    const acceptances = async (userId) =>
      (
        await owner.query(
          `SELECT terms_version AS version, minimum_age AS age
           FROM terms_acceptances WHERE user_id=$1 ORDER BY terms_version`,
          [userId],
        )
      ).rows;

    it("records the accepted version and age with the profile", async () => {
      const userId = await user();
      const profile = await identity.createProfile(
        userId,
        handle(),
        "Terms Person",
        null,
        "published",
        { version: "2026-10-30", minimumAge: 18 },
      );
      assert.equal(profile.publicationState, "published");
      assert.deepEqual(await acceptances(userId), [
        { version: "2026-10-30", age: 18 },
      ]);
      const exported = await identity.exportData(userId);
      assert.equal(exported.termsAcceptances.length, 1);
      assert.equal(exported.termsAcceptances[0].termsVersion, "2026-10-30");
      assert.equal(exported.termsAcceptances[0].minimumAge, 18);
      assert.ok(exported.termsAcceptances[0].acceptedAt instanceof Date);
    });

    it("records nothing when the profile is refused", async () => {
      const userId = await user();
      await identity.createProfile(userId, handle(), "First", null, "draft", {
        version: "2026-10-30",
        minimumAge: 18,
      });
      await assert.rejects(
        identity.createProfile(userId, handle(), "Second", null, "draft", {
          version: "2026-11-01",
          minimumAge: 18,
        }),
        { code: "23505" },
      );
      assert.deepEqual(await acceptances(userId), [
        { version: "2026-10-30", age: 18 },
      ]);
    });

    it("keeps acceptances out of reach of edits and other profiles", async () => {
      const userId = await user();
      await identity.createProfile(userId, handle(), "No terms", null);
      assert.deepEqual(await acceptances(userId), []);
      await runtime.query(
        "INSERT INTO terms_acceptances(user_id, terms_version, minimum_age) VALUES($1, '2026-10-30', 18)",
        [userId],
      );
      for (const sql of [
        "UPDATE terms_acceptances SET minimum_age=21 WHERE user_id=$1",
        "DELETE FROM terms_acceptances WHERE user_id=$1",
      ])
        await assert.rejects(runtime.query(sql, [userId]), { code: "42501" });
      await assert.rejects(
        runtime.query(
          "INSERT INTO terms_acceptances(user_id, terms_version, minimum_age) VALUES($1, 'later', 18)",
          [userId],
        ),
        { code: "23514" },
      );
    });
  },
);
