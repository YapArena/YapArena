import { asset } from "./assets.ts";
import { inscribe } from "./inscribe.ts";
import { html } from "../../platform/html.ts";

export { inscribe };

// The headline's flip tracks. frontend/landing-headline.ts holds the same
// words for its step logic; tests/landing.test.js keeps the two in step.
const pronouns = ["our", "appers", "our"];
const nouns = ["opinions", "debates", "ideas", "discussions", "", "opinions"];

const track = (words: string[], space: string) =>
  html`<span class="flip-track">${words.map((word) => html`<span class="flip-word">${word && space + inscribe(word)}</span>`)}</span>`;

// "Y" + "our"/"appers" + noun on line 1, "matter" on line 2. Phones set both
// on one line, so a real space separates them: the font's own word space.
// Screen readers get one stable sentence; the animated lines are hidden from
// them.
const headline = html`<h1 id="landing-title" class="landing-headline" data-headline><span class="sr-only">Your opinions, debates, ideas and discussions matter. Yappers matter.</span><span class="headline-line reveal" aria-hidden="true"><span class="headline-y">Y</span><span class="flip" data-flip="pronoun">${track(pronouns, "")}</span><span class="flip" data-flip="noun">${track(nouns, " ")}</span></span> <span class="headline-line reveal reveal-2" aria-hidden="true">matter</span></h1>`;

// The landing page at / for readers without a session (docs/landing-page.md).
// It stands alone: no site header, homepage bundle or account scripts.
// The headline font is preloaded at the exact, unversioned URL that
// landing.css resolves, so it downloads once.
export function renderLanding(origin: string) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000"><title>YAP Arena</title><meta name="description" content="Follow an idea. Hear both sides. Take a position."><link rel="canonical" href="${origin}/"><link rel="preload" href="/assets/landing/fonts/headline.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="${asset("landing.css")}"><script type="module" src="${asset("landing.js")}"></script></head><body class="landing"><a class="skip-link" href="#main">Skip to content</a><header class="landing-header landing-container"><a class="landing-brand" href="/"><img src="${asset("landing/yaparena-logo.png")}" width="575" height="151" alt="YAP Arena"></a></header><main id="main" class="landing-main landing-container"><section class="landing-join" aria-labelledby="landing-title">${headline}<h2 class="reveal reveal-3">Join the arena.</h2><div class="landing-actions reveal reveal-4"><a class="landing-button landing-button-primary" href="/api/auth/login?connection=google&amp;return=%2Fhome" data-sign-in="google">Continue with Google</a><a class="landing-button landing-button-secondary" href="/api/auth/login?connection=email&amp;return=%2Fhome" data-sign-in="email">Continue with email</a></div><div class="landing-sign-in reveal reveal-5"><p>Already have an account?</p><a class="landing-button landing-button-outline" href="/api/auth/login?return=%2Fhome">Sign in</a></div><a class="landing-explore reveal reveal-5" href="/home">Explore debates without an account <span aria-hidden="true">→</span></a></section><div class="landing-emblem"><div class="pixel-logo" data-pixel-logo><canvas class="aura" aria-hidden="true"></canvas><img id="pixel-logo" src="${asset("landing/yaparena-emblem.png")}" width="2048" height="1715" alt=""><canvas class="bloom" aria-hidden="true"></canvas><canvas class="cores" aria-hidden="true"></canvas></div><p class="sr-only">Light spreads through neighboring pixels of the YAP Arena emblem. Move the mouse across it to awaken more signals. Press Space to pause or resume the emblem and the headline.</p><span class="sr-only" role="status" data-pixel-status></span></div></main><footer class="landing-footer landing-container"><nav aria-label="Site"><a href="/topics">Topics</a><a href="/coins">Yap Coins</a><a href="/about">About</a><span>Play money</span></nav></footer></body></html>`.toString();
}
