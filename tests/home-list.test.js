// The home as a debate list (first-run plan PR 6): the lists, the top slot's
// order on quiet days, the chips, the words, the page and the topic page's
// last-answer figure (Decision 0015).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  ANSWER_CLOSE_HOURS,
  closesText,
  emptyHomeList,
  endedText,
  homeList,
  homeView,
  latestResult,
  resultText,
  startsText,
  topSlot,
  waitingRows,
  waitingText,
  withWindows,
} from "../dist/features/discovery/home-list-model.js";
import {
  filterLabel,
  homeFeedMarkup,
  homeListMarkup,
} from "../dist/features/discovery/home-list-view.js";
import {
  emptyEndorsementView,
  endorsementView,
} from "./endorsement-fixtures.js";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";
import { renderHome, renderTopic } from "../dist/features/discovery/web.js";
import { debate, empty, hostileText, list, topic } from "./page-fixtures.js";

const HOUR = 3_600_000;
const now = new Date("2026-11-06T18:00:00Z");
const at = (hours) => new Date(now.getTime() + hours * HOUR);
let next = 0;
const make = (fields = {}, topicSlug = topic.slug) => ({
  ...debate,
  id: `77777777-7777-4777-8777-${String(++next).padStart(12, "0")}`,
  slug: `home-debate-${next}`,
  topic: { ...debate.topic, slug: topicSlug, title: `Topic ${topicSlug}` },
  ...fields,
});
const live = (slug) => make({ status: "live" }, slug);
const soon = (hours, slug, status = "scheduled") =>
  make({ status, scheduledAt: at(hours) }, slug);
const ended = (hours, slug, status = "replay") =>
  make({ status, liveEndedAt: at(hours) }, slug);
const build = (sources, options = {}) =>
  homeList({ live: [], scheduled: [], ended: [], ...sources }, now, options);
const waitingTopic = (slug, sideA, sideB) => ({
  slug,
  title: `Topic ${slug}`,
  sideALabel: "Free transit",
  sideBLabel: "Keep fares",
  waiting: { sideA, sideB },
});
const windows = (fields) => ({
  serverNow: now.toISOString(),
  revealMode: "five_day",
  revealAt: at(48).toISOString(),
  windows: [],
  ...fields,
});
const share = (percent) => ({ n: String(percent), d: "100" });

describe("home lists", () => {
  it("keeps only debates starting within a day, and never a start that passed", () => {
    const data = build({
      scheduled: [
        soon(3, "a"),
        soon(-240, "past"),
        soon(25, "later"),
        soon(0.5, "b", "ready"),
        make({ status: "scheduled", scheduledAt: null }, "untimed"),
        soon(2, "cancelled", "cancelled"),
      ],
    });
    assert.deepEqual(
      data.soon.map((d) => d.topic.slug),
      ["b", "a"],
    );
    assert.equal(data.soon[0].kind, "soon");
    assert.equal(data.soon[0].startsAt, at(0.5).toISOString());
    assert.equal(data.now, now.toISOString());
    assert.equal(data.available, true);
  });

  it("splits replays still taking answers from finished debates at the 120-hour close", () => {
    assert.equal(ANSWER_CLOSE_HOURS, 120);
    const data = build({
      ended: [
        ended(-100, "older"),
        ended(-10, "recent", "finalized"),
        ended(-121, "closed"),
        ended(-400, "old", "finalized"),
        make({ status: "replay", liveEndedAt: null }, "untimed"),
        ended(-5, "voided", "void_review"),
      ],
    });
    // Closing soonest first.
    assert.deepEqual(
      data.replays.map((d) => [d.topic.slug, d.kind]),
      [
        ["older", "replay"],
        ["recent", "replay"],
      ],
    );
    assert.equal(data.replays[0].closesAt, at(20).toISOString());
    // Most recent end first; one without an end time goes last.
    assert.deepEqual(
      data.finished.map((d) => [d.topic.slug, d.kind, d.closesAt]),
      [
        ["closed", "finished", null],
        ["old", "finished", null],
        ["untimed", "finished", null],
      ],
    );
  });

  it("keeps each list short and maps speakers, avatars and links", () => {
    const data = build(
      {
        live: [
          ...Array.from({ length: 14 }, () => live("busy")),
          make({ status: "replay" }),
        ],
        ended: Array.from({ length: 6 }, (_, i) => ended(-1 - i, "r")),
      },
      {
        matchmaking: true,
        avatarUrl: (id) => `/assets/avatars/${id}.svg?v=x`,
      },
    );
    assert.equal(data.live.length, 12);
    assert.equal(data.replays.length, 4);
    assert.equal(data.matchmaking, true);
    const [first] = data.live;
    assert.equal(first.href, `/debates/${first.slug}`);
    // An unnamed speaker shows their side's label and "?".
    assert.deepEqual(first.names, ["Alex Public", "Against"]);
    assert.deepEqual(first.named, [true, false]);
    assert.deepEqual(first.avatars, ["/assets/avatars/yap-owl.svg?v=x", null]);
    assert.deepEqual(build({ live: [live("x")] }).live[0].avatars, [
      null,
      null,
    ]);
  });

  it("describes an empty or failed home", () => {
    assert.deepEqual(emptyHomeList(now), {
      available: true,
      now: now.toISOString(),
      matchmaking: false,
      live: [],
      soon: [],
      replays: [],
      finished: [],
    });
    assert.equal(emptyHomeList(now, false).available, false);
  });
});

describe("turn windows", () => {
  it("reads the latest revealed turn's share as the result", () => {
    assert.deepEqual(
      latestResult([
        { turnNumber: 1, state: "settled", pricing: { share: share(40) } },
        { turnNumber: 3, state: "settled", pricing: { share: share(57.6) } },
        { turnNumber: 4, state: "settled", pricing: { share: null } },
        { turnNumber: 5, state: "void", pricing: null },
        { turnNumber: 6, state: "open" },
        { turnNumber: 2, state: "settled", pricing: { share: share(60) } },
      ]),
      { turn: 3, yes: 58 },
    );
    assert.equal(latestResult([]), null);
    assert.equal(
      latestResult([
        {
          turnNumber: 1,
          state: "settled",
          pricing: { share: { n: "1", d: "0" } },
        },
      ]),
      null,
    );
    assert.equal(resultText({ turn: 6, yes: 58 }), "Turn 6: 58% said yes");
  });

  it("keeps a replay only while it takes answers, and gives finished debates their result", () => {
    const open = ended(-2, "open");
    const perRound = ended(-3, "per-round");
    const noWindow = ended(-4, "none");
    const unread = ended(-5, "unread");
    const lastWeek = ended(-200, "last-week");
    const data = build({
      ended: [open, perRound, noWindow, unread, lastWeek],
    });
    const settled = [
      { turnNumber: 1, state: "settled", pricing: { share: share(70) } },
    ];
    const next = withWindows(
      data,
      new Map([
        [open.id, windows({ windows: [{ turnNumber: 1, state: "open" }] })],
        [perRound.id, windows({ revealMode: "per_round", windows: settled })],
        [noWindow.id, windows({ windows: [] })],
        [
          lastWeek.id,
          windows({ revealAt: at(-80).toISOString(), windows: settled }),
        ],
      ]),
    );
    assert.deepEqual(
      next.replays.map((d) => [d.topic.slug, d.closesAt]),
      [
        ["unread", at(115).toISOString()],
        ["open", at(48).toISOString()],
      ],
    );
    assert.deepEqual(
      next.finished.map((d) => [d.topic.slug, d.kind, d.result]),
      [
        ["per-round", "finished", { turn: 1, yes: 70 }],
        ["none", "finished", null],
        ["last-week", "finished", { turn: 1, yes: 70 }],
      ],
    );
    // A close that already passed by the server's clock ends answers too.
    assert.equal(
      withWindows(
        data,
        new Map([
          [
            open.id,
            windows({
              revealAt: at(-1).toISOString(),
              windows: [{ turnNumber: 1, state: "open" }],
            }),
          ],
        ]),
      ).replays.some((d) => d.id === open.id),
      false,
    );
  });
});

describe("the top slot", () => {
  const follows = new Set(["mine"]);
  const rows = waitingRows([waitingTopic("queue", 1, 0)]);
  const slot = (sources, followed = follows, waiting = rows) =>
    topSlot(build(sources), followed, waiting);
  const label = (result) =>
    result.kind === "debate"
      ? `${result.label}:${result.debate.topic.slug}`
      : result.kind;

  it("follows the decision page's order on busy and quiet days", () => {
    const everything = {
      live: [live("other"), live("mine")],
      scheduled: [soon(1, "other"), soon(2, "mine")],
      ended: [ended(-2, "mine"), ended(-200, "other")],
    };
    // 1. A live debate in a followed topic.
    assert.equal(label(slot(everything)), "live-yours:mine");
    // 2. Something soon in your topics: the next debate, then a replay.
    assert.equal(
      label(slot({ ...everything, live: [live("other")] })),
      "yours:mine",
    );
    assert.equal(
      label(
        slot({
          ...everything,
          live: [live("other")],
          scheduled: [soon(1, "other")],
        }),
      ),
      "yours:mine",
    );
    // 3. Any other live debate, never hidden: named for followers.
    assert.equal(label(slot({ live: [live("other")] })), "live-other:other");
    assert.equal(
      label(slot({ live: [live("other")] }, new Set())),
      "live:other",
    );
    // 4. The next debate within a day.
    assert.equal(
      label(slot({ scheduled: [soon(3, "a"), soon(1, "b")] })),
      "next:b",
    );
    // 5. A replay still taking answers.
    assert.equal(
      label(slot({ ended: [ended(-200, "done"), ended(-2, "open")] })),
      "replay:open",
    );
    // 6. Someone waiting.
    const waiting = slot({ ended: [ended(-200, "done")] });
    assert.equal(waiting.kind, "waiting");
    assert.equal(waiting.row.slug, "queue");
    // 7. A finished debate, one with its result first.
    assert.equal(
      label(slot({ ended: [ended(-200, "done")] }, follows, [])),
      "finished:done",
    );
    const finished = build({ ended: [ended(-200, "a"), ended(-300, "b")] });
    finished.finished[1].result = { turn: 2, yes: 40 };
    assert.equal(label(topSlot(finished, follows, [])), "finished:b");
    // 8. Nothing at all.
    assert.equal(slot({}, new Set(), []).kind, "start");
  });
});

describe("the list's views", () => {
  const data = build({
    live: [live("mine"), live("other"), live("third")],
    scheduled: [soon(2, "s1"), soon(4, "s2")],
    ended: [ended(-2, "r1"), ended(-200, "f1")],
  });
  const keys = (view) => view.sections.map((part) => part.key);

  it("lists everything once under All, with the others live beside a live top slot", () => {
    const view = homeView(data, new Set(), [waitingTopic("w", 0, 2)]);
    assert.equal(view.filter, "all");
    assert.equal(view.top.label, "live");
    assert.deepEqual(
      view.topRows.map((d) => d.topic.slug),
      ["other", "third"],
    );
    assert.deepEqual(keys(view), ["soon", "waiting", "replays", "finished"]);
    assert.equal(view.quiet, false);
    assert.deepEqual(view.counts, { soon: 2, replays: 2 });
    const ids = [
      view.top.debate.id,
      ...view.topRows.map((d) => d.id),
      ...view.sections.flatMap((part) =>
        "debates" in part ? part.debates.map((d) => d.id) : [],
      ),
    ];
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 7);
    // Someone waiting on side B: argue side A.
    const waiting = view.sections.find((part) => part.key === "waiting");
    assert.equal(waiting.rows[0].argueSide, "A");
    assert.equal(waiting.rows[0].argueLabel, "Free transit");
  });

  it("names the other live debates when a followed one leads", () => {
    const view = homeView(data, new Set(["mine"]), []);
    assert.equal(view.top.label, "live-yours");
    assert.deepEqual(view.topRows, []);
    assert.equal(view.sections[0].key, "live");
    assert.equal(view.sections[0].title, "Live in other topics");
    const both = homeView(
      build({ live: [live("mine"), live("mine")] }),
      new Set(["mine"]),
      [],
    );
    assert.equal(both.sections[0].title, "Live now");
    // Something soon in your topics leads; live debates follow, named.
    const soonFirst = homeView(
      build({ live: [live("other")], scheduled: [soon(1, "mine")] }),
      new Set(["mine"]),
      [],
    );
    assert.equal(soonFirst.top.label, "yours");
    assert.equal(soonFirst.sections[0].title, "Live in other topics");
  });

  it("says when nothing is live, and leaves out the waiting row on top", () => {
    const quiet = homeView(build({ ended: [ended(-200, "f1")] }), new Set(), [
      waitingTopic("w", 1, 1),
      ...["a", "b", "c", "d", "e", "f"].map((s) => waitingTopic(s, 1, 0)),
    ]);
    assert.equal(quiet.quiet, true);
    assert.equal(quiet.top.kind, "waiting");
    const waiting = quiet.sections.find((part) => part.key === "waiting");
    assert.equal(waiting.rows.length, 5);
    assert.ok(!waiting.rows.includes(quiet.top.row));
    assert.deepEqual(
      waiting.rows.slice(0, 1).map((row) => [row.slug, row.argueSide]),
      [["w", "A"]],
    );
    const start = homeView(emptyHomeList(now), new Set(), []);
    assert.equal(start.top.kind, "start");
    assert.equal(start.quiet, false);
    assert.deepEqual(start.sections, []);
  });

  it("filters by Soon and Replays, with a note when there is nothing", () => {
    const soonView = homeView(data, new Set(), [], "soon");
    assert.equal(soonView.top, null);
    assert.deepEqual(keys(soonView), ["soon"]);
    assert.equal(soonView.sections[0].debates.length, 2);
    assert.equal(soonView.empty, null);
    const replays = homeView(data, new Set(), [], "replays");
    assert.deepEqual(keys(replays), ["replays", "finished"]);
    assert.equal(replays.empty, null);
    const none = emptyHomeList(now);
    assert.equal(homeView(none, new Set(), [], "soon").empty, "soon");
    assert.deepEqual(homeView(none, new Set(), [], "soon").sections, []);
    assert.equal(homeView(none, new Set(), [], "replays").empty, "replays");
    assert.equal(filterLabel("all", soonView), "All");
    assert.equal(filterLabel("soon", soonView), "Soon · 2");
    assert.equal(filterLabel("replays", soonView), "Replays · 2");
  });
});

describe("the list's words", () => {
  const ms = now.getTime();
  it("counts down to a start", () => {
    assert.equal(startsText(at(-0.01).toISOString(), ms), "Starting now");
    assert.equal(startsText(at(0).toISOString(), ms), "Starting now");
    assert.equal(startsText(at(0.25 / 60).toISOString(), ms), "in 1 min");
    assert.equal(startsText(at(35 / 60).toISOString(), ms), "in 35 min");
    assert.equal(startsText(at(2 + 14 / 60).toISOString(), ms), "in 2 h 14");
    assert.equal(startsText(at(1).toISOString(), ms), "in 1 h 00");
  });
  it("says how long answers stay open", () => {
    assert.equal(closesText(at(-1).toISOString(), ms), "now");
    assert.equal(closesText(at(0.2).toISOString(), ms), "in 12 min");
    assert.equal(closesText(at(0.001).toISOString(), ms), "in 1 min");
    assert.equal(closesText(at(30).toISOString(), ms), "in 30 h");
    assert.equal(closesText(at(47.9).toISOString(), ms), "in 47 h");
    assert.equal(closesText(at(100).toISOString(), ms), "in 4 days");
  });
  it("says when a debate ended", () => {
    assert.equal(endedText(null, ms), "");
    assert.equal(endedText(at(0).toISOString(), ms), "Ended 1 min ago");
    assert.equal(endedText(at(-0.5).toISOString(), ms), "Ended 30 min ago");
    assert.equal(endedText(at(5).toISOString(), ms), "Ended 1 min ago");
    assert.equal(endedText(at(-3).toISOString(), ms), "Ended 3 h ago");
    assert.equal(endedText(at(-30).toISOString(), ms), "Ended 1 day ago");
    assert.equal(endedText(at(-100).toISOString(), ms), "Ended 4 days ago");
    assert.equal(endedText(at(-400).toISOString(), ms), "Ended Oct 21");
  });
  it("counts the people waiting, as the Queue tab does", () => {
    assert.equal(
      waitingText(1, "Free transit"),
      "1 person waiting to argue Free transit",
    );
    assert.equal(
      waitingText(3, "Keep fares"),
      "3 people waiting to argue Keep fares",
    );
    assert.deepEqual(waitingRows([waitingTopic("t", 0, 0)]), []);
  });
});

describe("the page", () => {
  const origin = "https://arena.example";
  const data = build(
    {
      live: [
        make({ status: "live", proposition: hostileText("Proposition") }, "x"),
      ],
      scheduled: [soon(1, "s")],
      ended: [ended(-3, "r"), ended(-300, "f")],
    },
    { matchmaking: true },
  );

  it("renders the lists with one white button and escapes every field", () => {
    const page = renderHome(origin, data);
    assert.match(
      page,
      /<main id="main"><div class="container home-list" data-home-list>/,
    );
    assert.match(page, /<link rel="stylesheet" href="\/assets\/home\.css\?v=/);
    assert.match(
      page,
      /<script type="module" src="\/assets\/home-list\.js\?v=/,
    );
    assert.doesNotMatch(page, /homepage\.(css|bundle)|ya-market-v4|ya-chart/);
    assert.match(page, /rel="canonical" href="https:\/\/arena\.example\/home"/);
    assert.match(page, /<a href="\/home" aria-current="page">/);
    assert.equal((page.match(/btn-primary/g) ?? []).length, 1);
    assert.ok(!page.includes("Proposition <b>"));
    assert.ok(page.includes("Proposition &lt;b&gt;&amp;amp;&lt;/b&gt;"));
    const embedded = page.match(
      /<template id="home-list-data">([\s\S]*?)<\/template>/,
    )[1];
    assert.ok(!embedded.includes("<"));
    assert.equal(
      JSON.parse(
        embedded
          .replaceAll("&quot;", '"')
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&#39;", "'")
          .replaceAll("&amp;", "&"),
      ).live[0].proposition,
      hostileText("Proposition"),
    );
    // The intro and chips; the words never explain Yap Coins.
    assert.match(
      page,
      /Live video debates\. Say whether you agree during each turn's 60-second window\./,
    );
    assert.match(page, /aria-label="Close the introduction"/);
    assert.match(page, /data-home-filter="all" aria-pressed="true">All</);
    assert.match(
      page,
      /data-home-filter="soon" aria-pressed="false">Soon · 1</,
    );
    assert.match(
      page,
      /data-home-filter="replays" aria-pressed="false">Replays · 2</,
    );
    assert.doesNotMatch(page, /voted|winner|Yap Coins? (pay|contract)/i);
    assert.match(
      page,
      /datetime="2026-11-06T19:00:00\.000Z" data-home-countdown="start">in 1 h 00</,
    );
    assert.match(
      page,
      /Answers close <time class="num" datetime="2026-11-11T15:00:00\.000Z" data-home-countdown="close">in 4 days<\/time>/,
    );
    assert.match(page, />Answer</);
    assert.match(page, /Ended 12 days ago/);
    assert.match(page, /href="\/debates">All debates/);
  });

  it("offers to start the first debate, by the queue or by a challenge", () => {
    const view = (matchmaking) =>
      String(
        homeFeedMarkup(
          homeView({ ...emptyHomeList(now), matchmaking }, new Set(), []),
          now.getTime(),
          matchmaking,
        ),
      );
    assert.match(
      view(true),
      /href="\/topics"[^>]*>.*Open a topic and queue on a side\./,
    );
    assert.match(view(true), /Pick a topic/);
    assert.match(
      view(false),
      /href="\/match"[^>]*>.*Create a topic, then challenge someone to debate it\./,
    );
    assert.match(view(false), /Start the first debate/);
    assert.doesNotMatch(view(false), /Nothing live right now/);
  });

  it("sends a waiting row to the side to take on the topic page", () => {
    const view = homeView(build({ ended: [ended(-200, "f")] }), new Set(), [
      waitingTopic("free-transit", 2, 0),
      waitingTopic("a-topic", 0, 1),
    ]);
    const feed = String(homeFeedMarkup(view, now.getTime(), true));
    assert.match(
      feed,
      /Nothing live right now\. Live debates show here first\./,
    );
    assert.match(
      feed,
      /href="\/topics\/free-transit#queue-side-b"[^>]*>.*2 people waiting to argue Free transit.*Take the other side: Keep fares.*Argue against/,
    );
    assert.match(
      feed,
      /href="\/topics\/a-topic#queue-side-a"[^>]*>.*1 person waiting to argue Keep fares.*Take the other side: Free transit.*Argue for/,
    );
    const result = homeFeedMarkup(
      homeView(
        withWindows(build({ ended: [ended(-200, "f")] }), new Map()),
        new Set(),
        [],
      ),
      now.getTime(),
      false,
    );
    assert.match(String(result), /Latest result/);
  });

  it("shows a finished debate's result and the filters' empty notes", () => {
    const done = build({ ended: [ended(-200, "f")] });
    done.finished[0].result = { turn: 6, yes: 58 };
    const feed = String(
      homeFeedMarkup(
        homeView(done, new Set(), [], "replays"),
        now.getTime(),
        false,
      ),
    );
    assert.match(
      feed,
      /Ended 8 days ago · <strong class="home-result">Turn 6: 58% said yes<\/strong>/,
    );
    const none = emptyHomeList(now);
    assert.match(
      String(homeFeedMarkup(homeView(none, new Set(), [], "soon"), 0, false)),
      /Nothing starts in the next 24 hours\..*href="\/debates\?status=scheduled"/,
    );
    assert.match(
      String(
        homeFeedMarkup(homeView(none, new Set(), [], "replays"), 0, false),
      ),
      /No replays yet\./,
    );
  });

  it("shows one state, without data or script, when discovery fails", () => {
    const page = renderHome(origin, emptyHomeList(now, false));
    assert.match(page, /Discovery temporarily unavailable\./);
    assert.match(page, /href="\/home">Try again<\/a>/);
    assert.doesNotMatch(page, /home-list-data|home-list\.js|data-home-list/);
    assert.equal(
      String(
        homeListMarkup(
          emptyHomeList(now, false),
          homeView(emptyHomeList(now), new Set(), []),
        ),
      ).includes("data-home-feed"),
      false,
    );
  });
});

describe("the home and topic routes", () => {
  const origin = "https://arena.example";
  const statuses = [];
  const discovery = {
    listDebates: async ({ status, limit }) => {
      statuses.push([status, limit]);
      if (status === "live")
        return list([{ ...debate, status: "live", id: "live-1" }]);
      if (status === "scheduled")
        return list([
          { ...debate, scheduledAt: new Date(Date.now() + HOUR) },
          {
            ...debate,
            id: "past",
            scheduledAt: new Date("2026-10-27T17:00:00Z"),
          },
        ]);
      return list([]);
    },
    getTopic: async (slug) => (slug === topic.slug ? topic : null),
  };
  const app = (options = {}) =>
    express().use(
      createDiscoveryRouter({
        discovery,
        applicationOrigin: origin,
        ...options,
      }),
    );

  it("reads live, scheduled, ready, replay and finalized debates for /home", async () => {
    statuses.length = 0;
    const home = await request(app({ matchmakingEnabled: true })).get("/home");
    assert.equal(home.status, 200);
    assert.equal(home.headers["cache-control"], "no-store");
    assert.deepEqual(statuses.sort(), [
      ["finalized", 12],
      ["live", 12],
      ["ready", 12],
      ["replay", 24],
      ["scheduled", 50],
    ]);
    assert.match(home.text, /data-home-list/);
    assert.match(home.text, /&quot;matchmaking&quot;:true/);
    // The start that passed (Oct 27) is not listed as upcoming.
    assert.doesNotMatch(home.text, /2026-10-27/);
    assert.equal((home.text.match(/data-home-key="33333333/g) ?? []).length, 1);
  });

  it("fails as one state and retires the reference sample", async () => {
    const broken = express().use(
      createDiscoveryRouter({
        discovery: {
          listDebates: async () => {
            throw new Error("offline");
          },
        },
        homepageReferenceEnabled: true,
        applicationOrigin: origin,
      }),
    );
    const failed = await request(broken).get("/home");
    assert.equal(failed.status, 503);
    assert.match(failed.text, /Discovery temporarily unavailable/);
    assert.equal((await request(broken).get("/home?reference=1")).status, 404);
  });

  it("shows a topic's last-answer figure and its history (Decision 0015)", async () => {
    const asked = [];
    const page = (options) =>
      request(app(options)).get(`/topics/${topic.slug}`);
    const shown = await page({
      topicEndorsement: {
        topic: async (id) => {
          asked.push(id);
          return endorsementView;
        },
      },
      // The shared bot history no longer reaches the topic page (D3).
      publicBots: {
        topics: async () => {
          throw new Error("the topic page must not read bot history");
        },
      },
    });
    assert.deepEqual(asked, [topic.id]);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers["cache-control"], "no-store");
    assert.match(shown.text, /data-topic-endorsement/);
    assert.match(shown.text, /Where viewers ended up/);
    assert.match(shown.text, /data-topic-history/);
    assert.match(shown.text, /<svg id="ya-chart" class="ya-chart"/);
    assert.match(
      shown.text,
      /<script type="module" src="\/assets\/topic-chart\.js\?v=/,
    );
    assert.doesNotMatch(shown.text, /Shared simulation|data-metric=/);
    // The figure sits above the debates and the history below them.
    assert.ok(
      shown.text.indexOf("data-topic-endorsement") <
        shown.text.indexOf('id="topic-debates"'),
    );
    assert.ok(
      shown.text.indexOf('id="topic-debates"') <
        shown.text.indexOf("data-topic-history"),
    );
    // Before a turn is revealed: the figure's section says when it starts,
    // with no chart and no script.
    const before = await page({
      topicEndorsement: { topic: async () => emptyEndorsementView },
    });
    assert.match(before.text, /The figure starts when a debate's first turn/);
    assert.doesNotMatch(before.text, /data-topic-history|topic-chart\.js/);
    // A failed read, or Yap Coins off: debates only.
    for (const options of [
      {
        topicEndorsement: {
          topic: async () => {
            throw new Error("offline");
          },
        },
      },
      {},
    ]) {
      const quiet = await page(options);
      assert.equal(quiet.status, 200);
      assert.doesNotMatch(
        quiet.text,
        /data-topic-endorsement|data-topic-history|topic-chart\.js/,
      );
    }
    assert.doesNotMatch(
      renderTopic(origin, topic, empty),
      /data-topic-endorsement|data-topic-history/,
    );
  });
});
