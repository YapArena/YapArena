import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasHiddenCharacters,
  isReservedName,
} from "../dist/features/community/user-text.js";

describe("published text rules", () => {
  it("refuses control and invisible formatting characters", () => {
    for (const value of [
      "Maya\u0000",
      "Maya‮tnemom",
      "May​a",
      "﻿Maya",
      "Ma­ya",
      "Maya⁦Chen⁩",
      "Maya‍Chen",
      "Maya Chen",
      "Maya\u0007",
      "Maya\nChen",
    ])
      assert.equal(hasHiddenCharacters(value), true, JSON.stringify(value));
    for (const value of [
      "Maya Chen",
      "Élodie Tremblay",
      "مايا",
      "🏳️‍🌈 Maya",
      "👩🏽‍💻 builds",
      "❤️‍🔥",
    ])
      assert.equal(hasHiddenCharacters(value), false, value);
  });

  it("keeps line breaks and tabs in multi-line text only", () => {
    assert.equal(
      hasHiddenCharacters("First line\nsecond\r\n\tthird", {
        multiline: true,
      }),
      false,
    );
    assert.equal(hasHiddenCharacters("First\nsecond"), true);
    for (const value of ["a\u0000b", "a‮b", "a\u000Bb", "a b"])
      assert.equal(hasHiddenCharacters(value, { multiline: true }), true);
  });

  it("reserves staff and service names in handles and usernames", () => {
    for (const value of [
      "admin",
      "administrator",
      "moderator",
      "mod",
      "operator",
      "staff",
      "support",
      "official",
      "yaparena",
      "yap-arena",
      "system",
      "root",
      "security",
      "help",
      "admin1",
      "mod-2",
      "the-moderator",
      "official-news",
      "yaparena-fan",
      "YAP Arena Team",
      "Ｍｏｄｅｒａｔｏｒ",
      "Staff",
      "Participant",
    ])
      assert.equal(isReservedName(value), true, value);
    for (const value of [
      "maya-chen",
      "badminton",
      "modern-mike",
      "help-me-debate",
      "supporter",
      "Maya Chen",
      "Yap fan",
    ])
      assert.equal(isReservedName(value), false, value);
  });
});
