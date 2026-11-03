import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  AVATARS,
  AVATAR_IDS,
  avatarIdPattern,
  avatarName,
  defaultAvatarId,
  isAvatarId,
  resolveAvatarId,
} from "../dist/features/identity/avatars.js";
import { avatarSlot } from "../dist/features/discovery/kit-web.js";
import { siteHeaderMarkup } from "../dist/features/discovery/site-header-web.js";

const folder = new URL("../public/avatars/", import.meta.url);

describe("avatars", () => {
  it("lists the 30 approved Pixel Yappers, one file each", async () => {
    assert.equal(AVATAR_IDS.length, 30);
    assert.equal(new Set(AVATAR_IDS).size, 30);
    assert.equal(new Set(AVATARS.map(([, name]) => name)).size, 30);
    const files = (await readdir(folder)).sort();
    assert.deepEqual(files, AVATAR_IDS.map((id) => `${id}.svg`).sort());
    assert.equal(avatarName("yap-axolotl"), "Axolotl");
  });

  it("keeps every file a small, self-contained 12 × 12 SVG", async () => {
    for (const id of AVATAR_IDS) {
      const svg = await readFile(new URL(`${id}.svg`, folder), "utf8");
      assert.ok(Buffer.byteLength(svg) < 2048, `${id} is under 2 KB`);
      assert.ok(
        svg.startsWith(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges">',
        ),
        id,
      );
      assert.doesNotMatch(svg, /<script|href|url\(|\son\w+=|<image|<style/i);
    }
  });

  it("matches the database's format check", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/1793665232104_add-profile-avatars.js",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      migration,
      /CHECK \(avatar_id ~ '\^yap-\[a-z\]\+\(-\[a-z\]\+\)\*\$'\)/,
    );
    for (const id of AVATAR_IDS) assert.match(id, avatarIdPattern);
    for (const bad of ["../x", "yap-", "YAP-BLOB", "yap-blob.svg", "blob"])
      assert.doesNotMatch(bad, avatarIdPattern);
  });

  it("validates choices against the set, not just the format", () => {
    assert.equal(isAvatarId("yap-blob"), true);
    for (const value of ["yap-unknown", "../x", "", null, undefined, 3])
      assert.equal(isAvatarId(value), false);
  });

  it("gives each handle a stable default from the set", () => {
    // FNV-1a mod 30 (docs/decisions/0014-user-avatars.md).
    assert.equal(defaultAvatarId("maya-chen"), "yap-critter");
    assert.equal(defaultAvatarId("kofi-mensah"), "yap-frog");
    assert.equal(defaultAvatarId("lena-novak"), "yap-crab");
    assert.equal(defaultAvatarId("maya-chen"), defaultAvatarId("maya-chen"));
    const seen = new Set();
    for (let index = 0; index < 600; index += 1) {
      const id = defaultAvatarId(`person-${index}`);
      assert.ok(isAvatarId(id));
      seen.add(id);
    }
    assert.equal(seen.size, 30);
  });

  it("shows the stored choice, otherwise the handle's default", () => {
    assert.equal(resolveAvatarId("yap-owl", "maya-chen"), "yap-owl");
    assert.equal(resolveAvatarId(null, "maya-chen"), "yap-critter");
    assert.equal(resolveAvatarId(undefined, "maya-chen"), "yap-critter");
    // A stored id that left the set falls back instead of breaking the page.
    assert.equal(resolveAvatarId("yap-retired", "maya-chen"), "yap-critter");
  });

  it("draws the avatar in its slot, or the initials without one", () => {
    const withAvatar = avatarSlot(
      "Maya Chen",
      48,
      "/assets/avatars/yap-owl.svg?v=abc",
    ).toString();
    assert.match(
      withAvatar,
      /^<span class="avatar-slot" style="--avatar-size:48px" aria-hidden="true"><img class="avatar-img" src="\/assets\/avatars\/yap-owl\.svg\?v=abc" alt=""><\/span>$/,
    );
    assert.match(avatarSlot("Maya Chen").toString(), />MC</);
    assert.match(
      avatarSlot("Maya", 24, '"><script>').toString(),
      /src="&quot;&gt;&lt;script&gt;"/,
    );
  });

  it("gives the browser the versioned avatar address", () => {
    assert.match(
      siteHeaderMarkup().toString(),
      /data-avatar-src="\/assets\/avatars\/\{id\}\.svg\?v=[0-9a-f]{12}"/,
    );
  });
});
