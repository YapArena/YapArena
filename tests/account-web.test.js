import assert from "node:assert/strict";
import { it } from "node:test";
import { accountMarkup } from "../dist/features/discovery/account-web.js";
import { renderCoins } from "../dist/features/discovery/web.js";
import { pixelCoin } from "../dist/features/discovery/pixel-mark.js";
import {
  renderSignInContinue,
  renderSignInProblem,
} from "../dist/platform/auth/sign-in-pages.js";

const asset = (name) => `/assets/${name}?v=test`;

it("signs in on the landing's layout, beside the living emblem", () => {
  const page = String(accountMarkup(asset));
  assert.match(
    page,
    /<h1 class="signin-headline kit-reveal" id="signin-title"><span class="sr-only">Every idea deserves a voice\.<\/span><span class="ins" aria-hidden="true">every idea deserves <em>a voice\.<\/em><\/span><\/h1>/,
  );
  assert.match(
    page,
    /<p class="signin-caption">Sign in or create an account<\/p>/,
  );
  assert.match(
    page,
    /<a class="btn btn-primary" href="\/api\/auth\/login\?connection=google&amp;return=%2Faccount" data-sign-in="google">Continue with Google<\/a>/,
  );
  assert.match(page, /data-sign-in="email">Continue with email<\/a>/);
  assert.match(
    page,
    /<div class="signin-emblem"><div class="living-emblem" data-living-emblem/,
  );
  assert.match(page, /living-emblem\.js\?v=test/);
  assert.doesNotMatch(page, /auth-arena-art|<ellipse/);
  // A loader holds the page while the account is checked.
  assert.match(
    page,
    /<div class="account-checking" aria-hidden="true"><span class="pixel-loader">/,
  );
});

it("titles Settings cards in Dydema and links Yap Coins with an arrow", () => {
  const page = String(accountMarkup(asset, true));
  for (const title of [
    "Public profile",
    "Debating",
    "Following",
    "Sign-in methods",
    "Recent account activity",
    "Notifications",
    "Cookies",
    "Download your data",
  ])
    assert.match(page, new RegExp(`<h2><span class="sr-only">${title}</span>`));
  assert.match(
    page,
    /<span class="settings-tab-arrow" aria-hidden="true">→<\/span>/,
  );
  assert.match(page, /class="settings-avatar" id="account-avatar"/);
  assert.match(
    page,
    /<a class="back-link account-back" data-auth-return href="\/debates"><span aria-hidden="true">←<\/span> Back to the arena<\/a>/,
  );
});

it("shows the Yap Coins balance with the pixel coin and placeholders", () => {
  const page = renderCoins("https://arena.example");
  assert.match(page, /<svg class="pixel-coin" width="64" height="64"/);
  assert.match(page, /<span class="sr-only">Yap Coins\.<\/span>/);
  assert.match(
    page,
    /data-coin-wallet-balances data-funds="balance"><span class="skeleton/,
  );
  assert.match(page, /<dd class="num" data-funds="available">/);
  assert.match(page, /<dd class="num" data-funds="held">/);
  assert.match(page, /Sign in to see your balance\./);
  assert.doesNotMatch(page, /USDC|withdraw/i);
  // A ring in the five visit colours around a white Y.
  const coin = String(pixelCoin(64));
  for (const slot of [0, 1, 2, 3, 4])
    assert.match(coin, new RegExp(`var\\(--visit-${slot}\\)`));
  assert.equal((coin.match(/fill="var\(--text\)"/g) ?? []).length, 7);
});

it("keeps the sign-in hand-off pages self-contained on the kit's look", () => {
  const page = renderSignInContinue("/home");
  assert.match(
    page,
    /<img src="\/assets\/landing\/yaparena-logo\.png"[^>]*alt="YAP Arena home">/,
  );
  assert.match(page, /<span class="loader" aria-hidden="true">/);
  assert.match(
    page,
    /<h1><span class="sr-only">You&#39;re signed in<\/span><span aria-hidden="true">yov&#39;re signed in<\/span><\/h1>/,
  );
  assert.match(page, /<meta http-equiv="refresh" content="0;url=\/home">/);
  assert.doesNotMatch(page, /<link rel="stylesheet"|spinner|<ellipse/);
  const problem = renderSignInProblem({
    title: "Sign-in expired",
    message: "Try again.",
    retry: "/api/auth/login",
    back: "/",
  });
  assert.match(problem, /<span class="sr-only">Sign-in expired<\/span>/);
  assert.match(
    problem,
    /<a class="button" href="\/api\/auth\/login">Try again<\/a><a class="secondary" href="\/">Back to YAP Arena<\/a>/,
  );
});
