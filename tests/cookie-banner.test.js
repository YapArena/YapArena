import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const script = await read("../public/measurement.js");
const css = await read("../public/site.css");

// The banner and its settings are one panel that frontend/measurement.ts
// adds to every page with measurement.js (the cookie banner in
// docs/site-design.md).
describe("cookie banner", () => {
  it("keeps the full text, the switches and the three choices", () => {
    assert.match(
      script,
      /<span class="sr-only">We use cookies<\/span><span class="ins" aria-hidden="true">we vse cookies<\/span>/,
    );
    assert.match(
      script,
      /Essential cookies keep you signed in and YAP Arena secure\. With your OK, we also use an analytics cookie to count which debates people find and how long they watch\. We don't use advertising cookies\. <a href="\/cookies">Cookie Policy<\/a>/,
    );
    assert.match(script, /data-cookie-options hidden>/);
    assert.match(script, /data-cookie-analytics>/);
    // Phones show the short line, then Customize, Reject all and Accept all;
    // wider screens never show the line.
    assert.match(
      script,
      /<div class="cookie-actions"><p class="cookie-brief">Analytics cookie only with your OK\.<\/p><button type="button" class="cookie-link" data-cookie-customize>Customize<\/button><button type="button" data-cookie-save hidden>Save choices<\/button><button type="button" data-cookie-reject>Reject all<\/button><button type="button" data-cookie-accept>Accept all<\/button><\/div>/,
    );
    assert.match(css, /\n\.cookie-brief \{\s*display: none;\s*\}/);
  });

  it("shrinks to one line on phones until Customize opens the settings", () => {
    const start = css.indexOf("/* The banner, until Customize opens");
    assert.ok(start > 0);
    const phone = css.slice(css.lastIndexOf("@media", start), start);
    assert.match(phone, /^@media \(max-width: 599px\) \{/);
    const block = css.slice(start, css.indexOf("\n}\n", start));
    const rule = (selector) => {
      // Prettier may wrap a long selector onto two lines.
      const pattern = selector
        .split(" ")
        .map((part) => RegExp.escape(part))
        .join("\\s+");
      const match = new RegExp(`\\n  ${pattern} \\{([^}]*)\\}`).exec(block);
      assert.ok(match, selector);
      return match[1];
    };
    // Only while the settings are closed: Customize and Cookie settings
    // show the whole card as before.
    const banner = ".cookie-choice:has(> .cookie-options[hidden])";
    assert.match(rule(banner), /gap: 0;/);
    assert.match(rule(banner), /padding: var\(--space-3\);/);
    assert.match(rule(`${banner} > .cookie-copy`), /display: none;/);
    const line = rule(`${banner} .cookie-brief`);
    assert.match(line, /display: block;/);
    // Too wide to share a row with a button, so Reject all and Accept all
    // wrap together and keep the same width.
    assert.match(line, /flex: 1 1 60%;/);
    assert.match(
      phone,
      /\.cookie-actions button:not\(\.cookie-link\) \{\s*flex: 1 1 40%;/,
    );
    const customize = rule(`${banner} .cookie-actions .cookie-link`);
    assert.match(customize, /order: 0;/);
    assert.match(customize, /margin: 0;/);
    assert.match(
      rule(`${banner} > [data-cookie-status]:not(:empty)`),
      /margin-top: var\(--space-2\);/,
    );
  });
});
