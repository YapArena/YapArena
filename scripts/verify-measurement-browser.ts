/* global window, document */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright-core";
import { chromium } from "playwright-core";
import axe from "axe-core";

const base = process.env.BROWSER_BASE_URL ?? "http://localhost:3000";
const chromePath =
  process.env.BROWSER_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = process.env.BROWSER_ARTIFACT_DIR;
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox"],
});
const timings: { viewport: number; milliseconds: number }[] = [];
const pages: Page[] = [];
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844, isMobile: true, hasTouch: true },
  ]) {
    const context = await browser.newContext({ viewport, bypassCSP: true });
    const page = await context.newPage();
    pages.push(page);
    const started = performance.now();
    await page.goto(base + "/home");
    await page.getByRole("region", { name: "Cookie choices" }).waitFor();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: `${artifactDir}/measurement-${viewport.width}.png`,
        fullPage: true,
      });
    }
    await page.evaluate((source) => window.eval(source), axe.source);
    const choiceViolations = await page.evaluate(async () => {
      const result = await window.axe.run(
        document.querySelector(".cookie-choice")!,
        {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        },
      );
      return result.violations.map((item) => item.id);
    });
    assert.deepEqual(choiceViolations, []);
    if (viewport.width < 600) {
      // Phones: one short line with Customize, then Reject all and Accept all
      // side by side at the same size, instead of the full card.
      const layout = await page.evaluate(() => {
        const panel = document.querySelector(".cookie-choice")!;
        const box = (selector: string) => {
          const { top, width, height } = panel
            .querySelector(selector)!
            .getBoundingClientRect();
          return { top, width, height };
        };
        return {
          panel: panel.getBoundingClientRect().height,
          copy: panel.querySelector(".cookie-copy")!.getClientRects().length,
          line: box(".cookie-brief"),
          customize: box("[data-cookie-customize]"),
          reject: box("[data-cookie-reject]"),
          accept: box("[data-cookie-accept]"),
        };
      });
      assert.ok(
        layout.panel <= viewport.height * 0.2,
        `phone banner is ${layout.panel}px tall`,
      );
      assert.equal(layout.copy, 0, "the full text waits for Customize");
      // One line in Arial; a wider fallback font may wrap it, but never
      // beyond the 44px row it shares with Customize.
      assert.ok(
        layout.line.height > 0 && layout.line.height <= layout.customize.height,
      );
      const middle = (item: { top: number; height: number }) =>
        item.top + item.height / 2;
      assert.ok(
        Math.abs(middle(layout.customize) - middle(layout.line)) <= 2,
        "Customize sits on the line's row",
      );
      assert.equal(layout.reject.top, layout.accept.top);
      assert.equal(layout.reject.width, layout.accept.width);
      assert.ok(layout.reject.height >= 44 && layout.accept.height >= 44);
      assert.ok(layout.reject.top > layout.customize.top);
      // Customize still opens the full text and the switches.
      await page.getByRole("button", { name: "Customize" }).click();
      assert.equal(
        await page
          .getByText("Essential cookies keep you signed in")
          .isVisible(),
        true,
      );
      assert.equal(
        await page.getByRole("switch", { name: /Analytics/ }).isVisible(),
        true,
      );
      await page.reload();
      await page.getByRole("region", { name: "Cookie choices" }).waitFor();
    }
    const before = await page.evaluate<{ consented: boolean }>(() =>
      fetch("/api/measurement/consent").then((r) => r.json()),
    );
    assert.equal(before.consented, false);
    await page.getByRole("button", { name: "Accept all" }).click();
    await page.waitForFunction(() => window.yapMeasurement?.consented === true);
    const after = await page.evaluate<{ consented: boolean }>(() =>
      fetch("/api/measurement/consent").then((r) => r.json()),
    );
    assert.equal(after.consented, true);
    await page.goto(`${base}/debates`);
    await page.waitForFunction(() => window.yapMeasurement?.consented === true);
    // Cookie settings: the analytics switch reflects the choice; turning it
    // off and saving deletes this browser's measurements.
    await page.getByRole("button", { name: "Cookie settings" }).click();
    const analytics = page.getByRole("switch", { name: /Analytics/ });
    assert.equal(await analytics.isChecked(), true);
    await analytics.uncheck();
    await page.getByRole("button", { name: "Save choices" }).click();
    await page.waitForFunction(
      () => window.yapMeasurement?.consented === false,
    );
    assert.equal(
      (
        await page.evaluate<{ consented: boolean }>(() =>
          fetch("/api/measurement/consent").then((r) => r.json()),
        )
      ).consented,
      false,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
      "no horizontal overflow",
    );
    await page.evaluate((source) => window.eval(source), axe.source);
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.body, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      });
      return result.violations.map((item) => item.id);
    });
    assert.deepEqual(violations, []);
    const dashboard = await page.goto(`${base}/measurement`);
    assert.equal(dashboard!.status(), 401);
    timings.push({
      viewport: viewport.width,
      milliseconds: Math.round(performance.now() - started),
    });
    await context.close();
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), base, timings }));
} finally {
  for (const page of pages) {
    try {
      await page.evaluate(() =>
        fetch("/api/measurement/consent", { method: "DELETE" }),
      );
    } catch {
      // Best-effort cleanup when a page or network failed mid-trial.
    }
  }
  await browser.close();
}
