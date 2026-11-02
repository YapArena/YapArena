import assert from "node:assert/strict";
import { it } from "node:test";
import {
  renderAbout,
  renderInvalidRequest,
  renderMatchmaking,
  renderNotFound,
  renderUnavailable,
} from "../dist/features/discovery/web.js";

const origin = "https://arena.example";

it("sets the error pages beside the living emblem with one way on and a way home", () => {
  for (const [page, kicker, button] of [
    [
      renderNotFound(origin),
      "404 / No such page",
      '<a class="btn btn-primary" href="/debates">Browse debates</a>',
    ],
    [
      renderInvalidRequest(origin),
      "400 / Invalid link",
      '<a class="btn btn-primary" href="/debates">Browse debates</a>',
    ],
  ]) {
    assert.match(page, new RegExp(`<span class="sr-only">${kicker}</span>`));
    assert.ok(page.includes(button));
    assert.match(
      page,
      /<a class="text-link error-home" href="\/home">Go to Home <span aria-hidden="true">→<\/span><\/a>/,
    );
    assert.match(
      page,
      /<div class="error-emblem"><div class="living-emblem" data-living-emblem/,
    );
    assert.match(page, /living-emblem\.js\?v=/);
    assert.match(page, /<h1 class="display-title kit-reveal">/);
    // The page's own words, outside the header's menu.
    assert.doesNotMatch(page.split('<main id="main">')[1], /↗/);
  }
  // Try again reloads the page that failed, and only a same-site path.
  assert.match(
    renderUnavailable("/debates?q=city"),
    /<a class="btn btn-primary" href="\/debates\?q=city">Try again<\/a>/,
  );
  for (const unsafe of [
    "//evil.example/",
    "/\\evil",
    "https://evil.example/",
    "",
  ])
    assert.match(
      renderUnavailable(unsafe),
      /<a class="btn btn-primary" href="\/">Try again<\/a>/,
    );
  assert.match(
    renderUnavailable(),
    /<a class="btn btn-primary" href="\/">Try again<\/a>/,
  );
});

it("shows About's words beside the emblem with Dydema section headings", () => {
  const page = renderAbout(origin);
  assert.match(
    page,
    /<span class="sr-only">Make room for the other side\.<\/span>/,
  );
  assert.match(page, /<h2 class="section-title" id="measurement">/);
  assert.match(
    page,
    /<a class="btn btn-primary" href="\/debates">Explore debates<\/a>/,
  );
  assert.match(page, /<div class="about-emblem"><div class="living-emblem"/);
});

it("puts Create's two forms in a tab pair and the lists beside them", () => {
  const page = renderMatchmaking(origin, true);
  assert.match(
    page,
    /<div class="match-tabs" role="tablist" aria-label="Create">/,
  );
  assert.match(
    page,
    /role="tab" id="match-tab-topic" aria-controls="match-panel-topic" aria-selected="true" tabindex="0">Start a topic<\/button>/,
  );
  assert.match(
    page,
    /role="tab" id="match-tab-other" aria-controls="match-panel-other" aria-selected="false" tabindex="-1">Challenge a person<\/button>/,
  );
  assert.match(
    page,
    /id="match-panel-other" aria-labelledby="match-tab-other" hidden>/,
  );
  for (const id of [
    "topic-create",
    "challenge-create",
    "my-topics",
    "my-requests",
    "my-events",
    "match-notifications",
  ])
    assert.match(page, new RegExp(`id="${id}"`));
  assert.match(
    page,
    /<button class="btn btn-primary" type="submit">Send challenge<\/button>/,
  );
  assert.match(
    page,
    /<button class="btn btn-primary" type="submit">Create private draft<\/button>/,
  );
  assert.match(
    page,
    /<div class="match-switch-options"><label><input type="radio" name="mode" value="now" checked> Now<\/label>/,
  );
  assert.match(page, /Browse topics <span aria-hidden="true">→<\/span>/);
  assert.match(page, /<aside class="match-side" aria-label="Your matches">/);
  assert.doesNotMatch(page.split('<main id="main">')[1], /↗|01 \/|02 \//);
  // Without the live queue the second tab opens a request.
  const plain = renderMatchmaking(origin, false);
  assert.match(plain, />Open a request<\/button>/);
  assert.match(plain, /id="open-queue"/);
  assert.match(
    plain,
    /<button class="btn btn-primary" type="submit">Open request<\/button>/,
  );
});
