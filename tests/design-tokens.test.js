// The debate page shares the landing page's design values (direction BC1,
// docs/debate-page-design.md). landing.css stands alone, so both files carry
// them; this keeps them equal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const read = (name) =>
  readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const landing = read("landing.css");
const site = read("site.css");

// Every custom property declared in a file's :root rules.
function tokens(css) {
  const found = new Map();
  for (const [, body] of css.matchAll(/:root\s*\{([^}]*)\}/g))
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      found.set(name, value.replace(/\s+/g, " ").trim());
  return found;
}
const landingTokens = tokens(landing);
const siteTokens = tokens(site);

// site.css's --line has always been the divider (#202020); the landing's
// --line is the control border, which site.css calls --control-border.
const differentMeaning = new Set(["--line"]);
const renamed = { "--control-border": "--line" };

it("keeps every token shared with the landing at the landing's value", () => {
  let shared = 0;
  for (const [name, value] of siteTokens) {
    if (differentMeaning.has(name)) continue;
    const landingName = renamed[name] ?? name;
    if (!landingTokens.has(landingName)) continue;
    shared++;
    assert.equal(value, landingTokens.get(landingName), `${name} differs`);
  }
  // Colours, the rest opacity, eight spaces and the easing at least.
  assert.ok(shared >= 15, `only ${shared} shared tokens found`);
  for (const name of [
    "--bg",
    "--text",
    "--muted",
    "--acid",
    "--rest-opacity",
    "--ease-expo",
    "--space-1",
    "--space-8",
  ])
    assert.ok(siteTokens.has(name), `site.css lacks ${name}`);
});

it("takes the button values from the landing's buttons", () => {
  for (const name of [
    "--primary-gradient",
    "--on-acid",
    "--raised",
    "--button-text",
  ])
    assert.ok(
      landing.includes(siteTokens.get(name)),
      `landing.css has no ${siteTokens.get(name)} (${name})`,
    );
});

it("loads the landing fonts from the same files", () => {
  const faces = (css) =>
    [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
      family: /font-family:\s*"([^"]+)"/.exec(body)[1],
      src: /src:\s*([^;]+);/.exec(body)[1].trim(),
    }));
  assert.deepEqual(faces(site), faces(landing));
});
