import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newQuestionError,
  rowWaitingText,
  sideButtonView,
  similarQuery,
  slugFromTitle,
  waitingRows,
  waitingText,
} from "../public/queue-page-model.js";
import { renderQueue } from "../dist/features/discovery/web.js";
import { empty, list, topic } from "./page-fixtures.js";

const transit = {
  slug: "free-transit",
  title: "Should Montreal make public transit free?",
  sideALabel: "Free transit",
  sideBLabel: "Keep fares",
  waiting: { sideA: 2, sideB: 0 },
};
const queued = (topicSlug, side, status = "searching") => ({
  serverNow: "2026-11-06T12:00:00.000Z",
  ticket: {
    id: "t1",
    topicSlug,
    topicTitle: "Topic",
    side,
    sideLabel: "Side",
    status,
    closedReason: null,
    queuedAt: "2026-11-06T11:59:00.000Z",
  },
  offer: null,
  debate: null,
  challenge: null,
  upcoming: null,
});

describe("Queue tab model", () => {
  it("offers the other side of every side with someone waiting", () => {
    assert.deepEqual(waitingRows([transit]), [
      {
        slug: "free-transit",
        title: transit.title,
        count: 2,
        waitingLabel: "Free transit",
        argueSide: "B",
        argueLabel: "Keep fares",
      },
    ]);
    const both = { ...transit, waiting: { sideA: 1, sideB: 3 } };
    assert.deepEqual(
      waitingRows([both]).map((row) => [row.argueSide, row.count]),
      [
        ["B", 1],
        ["A", 3],
      ],
    );
    assert.deepEqual(waitingRows([]), []);
  });

  it("words the counts for people, never for who is waiting", () => {
    assert.equal(
      waitingText(1, "Keep fares"),
      "1 person waiting to argue Keep fares",
    );
    assert.equal(
      waitingText(3, "Keep fares"),
      "3 people waiting to argue Keep fares",
    );
    assert.equal(rowWaitingText(transit), "Waiting now: 2 for Free transit");
    assert.equal(
      rowWaitingText({ ...transit, waiting: { sideA: 1, sideB: 4 } }),
      "Waiting now: 1 for Free transit · 4 for Keep fares",
    );
    assert.equal(
      rowWaitingText({ ...transit, waiting: { sideA: 0, sideB: 0 } }),
      "",
    );
  });

  it("draws side buttons like the topic page: your side leaves, the rest wait", () => {
    assert.deepEqual(
      sideButtonView(null, "free-transit", "A", "Free transit"),
      {
        text: "Free transit",
        pressed: false,
        disabled: false,
      },
    );
    const state = queued("free-transit", "A");
    assert.deepEqual(
      sideButtonView(state, "free-transit", "A", "Free transit"),
      {
        text: "Leave queue",
        pressed: true,
        disabled: false,
      },
    );
    // One queue at a time, as the server enforces.
    assert.equal(
      sideButtonView(state, "free-transit", "B", "Keep fares").disabled,
      true,
    );
    assert.equal(sideButtonView(state, "other", "A", "Yes").disabled, true);
    // A closed or matched ticket no longer holds the buttons.
    assert.deepEqual(
      sideButtonView(
        queued("free-transit", "A", "closed"),
        "free-transit",
        "A",
        "Free transit",
      ),
      { text: "Free transit", pressed: false, disabled: false },
    );
  });
});

describe("Queue tab Create sheet model", () => {
  const question = {
    title: "Should Montreal make public transit free?",
    summary: "Fares versus a free network paid by taxes.",
    sideALabel: "Free transit",
    sideBLabel: "Keep fares",
    category: "cities",
    side: "A",
  };

  it("makes a slug the server accepts from any question", () => {
    const pattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
    assert.equal(
      slugFromTitle("Should Montréal make public transit free?"),
      "should-montreal-make-public-transit-free",
    );
    assert.equal(
      slugFromTitle("Should Montréal make public transit free?", "x1y2"),
      "should-montreal-make-public-transit-free-x1y2",
    );
    assert.equal(slugFromTitle("?!"), "question");
    assert.equal(slugFromTitle("Ok"), "ok-question");
    const long = slugFromTitle(`${"word ".repeat(40)}end`, "ab12");
    assert.ok(long.length <= 80 && long.endsWith("-ab12"), long);
    for (const slug of [
      long,
      slugFromTitle("Ü"),
      slugFromTitle("  --Free   transit--  "),
      slugFromTitle(`${"a".repeat(79)} b`),
    ])
      assert.match(slug, pattern, slug);
  });

  it("searches for questions sharing a meaningful word", () => {
    assert.equal(
      similarQuery("Should Montréal make public transit free?"),
      "montreal or public or transit or free",
    );
    assert.equal(similarQuery("Is it ok?"), "");
    assert.equal(similarQuery("Transit, transit and TRANSIT"), "transit");
    const long = similarQuery(
      "Universities scholarships transportation infrastructure accessibility governments neighbourhoods",
    );
    assert.ok(long.length <= 80, long);
    assert.ok(!long.endsWith(" or"), long);
  });

  it("checks the server's limits before sending", () => {
    assert.equal(newQuestionError(question, true), null);
    assert.match(
      newQuestionError({ ...question, title: "Why?" }, true),
      /5 to 140/,
    );
    assert.match(
      newQuestionError({ ...question, summary: "Too short" }, true),
      /10 to 600/,
    );
    assert.match(
      newQuestionError({ ...question, sideBLabel: "x" }, true),
      /2 to 80/,
    );
    assert.match(
      newQuestionError({ ...question, sideBLabel: " free TRANSIT " }, true),
      /different names/,
    );
    assert.match(
      newQuestionError({ ...question, category: "" }, true),
      /category/,
    );
    // A side is needed only to join the queue; a draft has none.
    assert.match(
      newQuestionError({ ...question, side: null }, true),
      /side you argue/,
    );
    assert.equal(newQuestionError({ ...question, side: null }, false), null);
  });
});

describe("Queue tab page", () => {
  const origin = "https://arena.example";

  it("lists every question with one button per side and loads the queue script", () => {
    const page = renderQueue(origin, list([topic]), true);
    assert.match(page, /<title>Queue · YAP Arena<\/title>/);
    assert.match(
      page,
      /<link rel="canonical" href="https:\/\/arena\.example\/queue">/,
    );
    for (const [side, label] of [
      ["A", topic.sideALabel],
      ["B", topic.sideBLabel],
    ])
      assert.ok(
        page.includes(
          `data-queue-request="${topic.slug}" data-request-side="${side}" data-side-label="${label}">${label}</button>`,
        ),
      );
    assert.match(
      page,
      /<a class="queue-row-title" href="\/topics\/public-topic">/,
    );
    assert.match(page, /data-waiting-section[^>]*hidden>/);
    assert.match(
      page,
      /<p class="queue-page-note" data-queue-page-note role="status"><\/p>/,
    );
    assert.match(page, /\/assets\/queue-page\.js/);
    // These buttons sit outside any topic page panel, so the topic page's own
    // queue hooks never pick them up.
    assert.doesNotMatch(page, /data-queue-topic|data-queue-side=/);
  });

  it("shows every question without buttons while the queue is off", () => {
    const page = renderQueue(origin, list([topic]), false);
    assert.doesNotMatch(
      page,
      /data-queue-request|data-waiting-section|queue-page\.js/,
    );
    assert.match(page, /The live queue isn/);
    assert.match(
      page,
      new RegExp(`${topic.sideALabel} vs ${topic.sideBLabel}`),
    );
  });

  it("invites the first question when there are none", () => {
    assert.match(renderQueue(origin, empty, true), /No public questions yet/);
    const none = renderQueue(origin, empty, true, "cities");
    assert.match(none, /No Cities questions yet/);
    // A new question can still be added above the empty state.
    assert.match(
      none,
      /<ol class="queue-list" data-question-list hidden><\/ol>/,
    );
  });

  it("filters by category with chips that keep the page's address", () => {
    const cities = { ...topic, category: "cities" };
    const page = renderQueue(
      origin,
      {
        items: [cities],
        pagination: { limit: 12, offset: 0, hasMore: true },
      },
      true,
      "cities",
    );
    assert.match(
      page,
      /<nav class="list-filters" aria-label="Categories"><div class="chips"><a class="chip" href="\/queue">All<\/a><a class="chip" href="\/queue\?category=politics">Politics<\/a>/,
    );
    assert.match(
      page,
      /<a class="chip" href="\/queue\?category=cities" aria-current="page">Cities<\/a>/,
    );
    // One current chip.
    assert.equal(page.match(/class="chip"[^>]*aria-current/g).length, 1);
    assert.match(
      page,
      /<link rel="canonical" href="https:\/\/arena\.example\/queue\?category=cities">/,
    );
    assert.match(page, /href="\/queue\?category=cities&amp;offset=12"/);
    assert.match(
      page,
      /<p class="queue-row-meta"><span>Cities<\/span><span data-queue-row-waiting><\/span><\/p>/,
    );
    // The sheet suggests the category being browsed.
    assert.match(page, /<option value="cities" selected>Cities<\/option>/);
    assert.match(
      renderQueue(origin, list([cities]), true),
      /<a class="chip" href="\/queue" aria-current="page">All<\/a>/,
    );
  });

  it("opens the one-step Create sheet only while the queue is on", () => {
    const page = renderQueue(origin, list([topic]), true);
    assert.match(
      page,
      /<a class="card queue-create" href="\/match#topic-create" data-create-open>/,
    );
    assert.match(
      page,
      /<dialog class="queue-create-dialog" data-create-dialog aria-labelledby="create-title"><form class="stack-form queue-create-form" data-create-form>/,
    );
    for (const [name, limits] of [
      ["title", 'minlength="5" maxlength="140"'],
      ["sideALabel", 'minlength="2" maxlength="80"'],
      ["sideBLabel", 'minlength="2" maxlength="80"'],
    ])
      assert.ok(page.includes(`name="${name}" ${limits} required`), name);
    assert.ok(
      page.includes('<textarea name="summary" minlength="10" maxlength="600"'),
    );
    assert.match(
      page,
      /<input type="radio" name="side" value="A"> <span data-side-name="A">Side A<\/span>/,
    );
    assert.match(page, /data-similar hidden>/);
    assert.match(
      page,
      /<p class="queue-create-error" data-create-error role="alert"><\/p>/,
    );
    assert.match(
      page,
      /<button class="btn btn-primary" type="submit" value="queue">Create and join the queue<\/button><button class="btn btn-secondary" type="submit" value="draft" formnovalidate>Save as a private draft<\/button>/,
    );
    // The sheet comes before the script that runs it; guests follow the link.
    assert.ok(
      page.indexOf("data-create-dialog") < page.indexOf("queue-page.js"),
    );
    const off = renderQueue(origin, list([topic]), false);
    assert.doesNotMatch(off, /data-create-dialog|data-create-form/);
    assert.match(off, /href="\/match#topic-create"/);
  });
});
