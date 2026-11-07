import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerTip,
  COIN_MENU_LINES,
  intentPath,
  RESULTS_TIP,
  TIP_KEYS,
  WELCOME_GRANT_COINS,
  WELCOME_LINES,
  welcomeTitle,
} from "../public/first-run-copy.js";
import { newAccountingGrant } from "../dist/features/account-wallet/grant-accounting.js";
import { createPageSender } from "../dist/features/discovery/router.js";

// The response methods the page sender uses.
function sent(sender, body) {
  const response = {
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(text) {
      this.body = text;
      return this;
    },
  };
  sender(response, body);
  return response.body;
}

describe("first-run guide copy", () => {
  it("states the welcome grant the ledger actually issues", () => {
    const grant = newAccountingGrant({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "welcome",
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    // 10,000 atomic units are one Yap Coin (frontend/lib/coin-format.ts).
    assert.equal(Number(grant.principal) / 10_000, WELCOME_GRANT_COINS);
    assert.match(WELCOME_LINES[2].rest, /you start with 2,500\./);
  });

  it("explains answers per turn and contracts the A4 way", () => {
    assert.deepEqual(
      WELCOME_LINES.map((line) => line.lead),
      [
        "Two people debate live",
        "During each turn, tap Yes or No.",
        "Put Yap Coins on your answer.",
      ],
    );
    const all = [...WELCOME_LINES, ...COIN_MENU_LINES, RESULTS_TIP]
      .map((line) => `${line.lead}${line.rest}`)
      .join(" ");
    // A contract pays the final share of people, never a majority's win.
    assert.match(all, /pays the final share who answered your way/);
    assert.match(all, /above the price you paid/);
    assert.doesNotMatch(all, /majority|wins?\b|1,000/i);
  });

  it("greets by first name and routes each intent", () => {
    assert.equal(welcomeTitle("Maya Lopez"), "Welcome, Maya");
    assert.equal(welcomeTitle("  "), "Welcome");
    assert.equal(intentPath("watch", true), "/live");
    assert.equal(intentPath("debate", true), "/queue");
    assert.equal(intentPath("debate", false), "/match");
    assert.equal(intentPath(undefined, true), null);
  });

  it("names whoever has the floor in the first tip", () => {
    assert.match(answerTip("Sam").rest, /Listen to Sam, then tap Yes or No/);
    assert.match(answerTip(null).rest, /Listen to the speaker,/);
    assert.equal(answerTip(null).count, "Tip 1 of 2");
    assert.equal(RESULTS_TIP.count, "Tip 2 of 2");
    assert.notEqual(TIP_KEYS.answer, TIP_KEYS.results);
  });
});

describe("first-run guide switches", () => {
  const page =
    '<!doctype html><html lang="en"><head></head><body></body></html>';

  it("marks pages only for the switches that are on", () => {
    assert.match(sent(createPageSender({}), page), /<html lang="en">/);
    assert.match(
      sent(
        createPageSender({
          emailFirst: true,
          matchmakingEnabled: true,
          firstRunWelcome: true,
          firstRunTips: true,
        }),
        page,
      ),
      /<html lang="en" data-matchmaking data-first-run-welcome data-first-run-tips data-email-first>/,
    );
    assert.match(
      sent(createPageSender({ firstRunTips: true }), page),
      /<html lang="en" data-first-run-tips>/,
    );
  });
});
