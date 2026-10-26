import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEBATER_SETTINGS_URL,
  needsDebaterSettings,
  showSettingsPrompt,
} from "../public/settings-prompt.js";

const original = globalThis.document;
afterEach(() => {
  globalThis.document = original;
});

describe("debater settings prompt", () => {
  it("recognises the server's refusal for missing debater settings", () => {
    const refused = Object.assign(new Error("Choose your debate language"), {
      code: "debater_settings_required",
    });
    assert.equal(needsDebaterSettings(refused), true);
    assert.equal(needsDebaterSettings(new Error("topic not found")), false);
    assert.equal(
      needsDebaterSettings(Object.assign(new Error("x"), { code: "other" })),
      false,
    );
    assert.equal(needsDebaterSettings(null), false);
    assert.equal(needsDebaterSettings("debater_settings_required"), false);
  });

  it("shows the message followed by a link to the account setting", () => {
    globalThis.document = { createElement: (tag) => ({ tag }) };
    let shown;
    const element = {
      replaceChildren: (...children) => {
        shown = children;
      },
    };
    showSettingsPrompt(element, "Choose your debate language.");
    assert.equal(shown[0], "Choose your debate language. ");
    assert.equal(shown[1].tag, "a");
    assert.equal(shown[1].className, "text-link");
    assert.equal(shown[1].href, DEBATER_SETTINGS_URL);
    assert.equal(DEBATER_SETTINGS_URL, "/account#debater-settings");
    assert.equal(shown[1].textContent, "Open your account settings");
  });
});
