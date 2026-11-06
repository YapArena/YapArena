import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rowWaitingText,
  sideButtonView,
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
  });
});
