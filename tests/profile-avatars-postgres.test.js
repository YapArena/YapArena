import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { defaultAvatarId } from "../dist/features/identity/avatars.js";

// Avatar choices on public_profiles (Decision 0014): NULL until chosen, and
// only well-formed ids reach the column.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "profile avatars in PostgreSQL",
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
    const handle = () => `avatar-${randomUUID().slice(0, 8)}`;
    const stored = async (userId) =>
      (
        await owner.query(
          "SELECT avatar_id FROM public_profiles WHERE user_id=$1",
          [userId],
        )
      ).rows[0].avatar_id;

    it("stores the chosen avatar and changes it later", async () => {
      const userId = await user();
      const created = await identity.createProfile(
        userId,
        handle(),
        "Avatar Person",
        null,
        "published",
        { version: "2026-10-30", minimumAge: 18 },
        "yap-owl",
      );
      assert.equal(created.avatarId, "yap-owl");
      assert.equal(await stored(userId), "yap-owl");
      const updated = await identity.updateProfile(userId, {
        avatarId: "yap-crab",
      });
      assert.equal(updated.avatarId, "yap-crab");
      assert.equal((await identity.getProfile(userId)).avatarId, "yap-crab");
      assert.equal(
        (await identity.exportData(userId)).profile.avatarId,
        "yap-crab",
      );
      // Other edits leave the choice alone.
      await identity.updateProfile(userId, { bio: "Still me" });
      assert.equal(await stored(userId), "yap-crab");
    });

    it("keeps NULL until someone chooses, showing the handle's default", async () => {
      const userId = await user();
      const name = handle();
      const created = await identity.createProfile(userId, name, "New", null);
      assert.equal(await stored(userId), null);
      assert.equal(created.avatarId, defaultAvatarId(name));
      assert.equal(
        (await identity.getProfile(userId)).avatarId,
        defaultAvatarId(name),
      );
    });

    it("rejects malformed ids in the database", async () => {
      const userId = await user();
      await identity.createProfile(userId, handle(), "Checked", null);
      for (const value of ["../x", "YAP-OWL", "yap-", "owl"])
        await assert.rejects(
          runtime.query(
            "UPDATE public_profiles SET avatar_id=$2 WHERE user_id=$1",
            [userId, value],
          ),
          { code: "23514" },
        );
      assert.equal(await stored(userId), null);
    });
  },
);
