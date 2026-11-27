import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  askerName,
  askerView,
  bandView,
  campView,
  firstCamp,
  fireable,
  fundView,
  incomingView,
  INVITE_MS,
  inviteDue,
  kindWord,
  liveView,
  micBadge,
  micError,
  micPhase,
  micTurnAt,
  micTurnLabel,
  micTurnSentence,
  micTurnSpeaker,
  micTurnWho,
  nextAfterMicTurn,
  ownSignature,
  pollDelay,
  stateLine,
  totalTurns,
  turnTitle,
  wholeCoins,
  yc,
} from "../public/mic-model.js";

// Decision 0018: what the mic's interface says, from the public list and the
// viewer's own part.
const names = { A: "Maya Chen", B: "Léo Tremblay" };
const now = Date.parse("2026-11-25T20:00:00Z");
const question = (id, target, total, overrides = {}) => ({
  id,
  target,
  text: `Question ${id}?`,
  author: `author-${id}`,
  total,
  pledges: 2,
  adds: [],
  ...overrides,
});
// Camp A asks side B, camp B asks side A.
const list = (overrides = {}) => ({
  id: "list-1",
  n: 1,
  extra: false,
  state: "open",
  openedRound: 4,
  camps: {
    A: [question("q1", "B", 340), question("q2", "B", 120)],
    B: [question("q3", "A", 210)],
  },
  ...overrides,
});
const entry = (overrides = {}) => ({
  id: "mic-1",
  listId: "list-1",
  camp: "A",
  target: "B",
  state: "live",
  price: 340,
  holder: "zoe",
  questionId: "q1",
  text: "Who pays for the night buses?",
  started: true,
  cut: { turnNumber: 7, side: "A", lostMs: 23_400 },
  extensions: 0,
  ...overrides,
});
const micTurn = (kind, overrides = {}) => ({
  turnNumber: 8,
  micId: "mic-1",
  kind,
  speaker: ["question", "followup", "extq"].includes(kind) ? "asker" : "B",
  side: "A",
  asker: "zoe",
  target: "B",
  text: null,
  deadline: new Date(now + 58_000).toISOString(),
  ...overrides,
});
const past = (turnNumber, kind, text = null) => ({
  turnNumber,
  micId: "mic-1",
  kind,
  asker: "zoe",
  target: "B",
  text,
});
const fund = (overrides = {}) => ({
  id: "fund-1",
  micId: "mic-1",
  price: 340,
  raised: 120,
  state: "open",
  closesAfter: "followup",
  closesAt: null,
  ...overrides,
});
const mic = (overrides = {}) => ({
  debateId: "debate",
  enabled: true,
  list: list(),
  mics: [],
  fund: null,
  turn: null,
  turns: [],
  ...overrides,
});
const own = (overrides = {}) => ({
  debateId: "debate",
  seated: false,
  pledges: [],
  mics: [],
  kept: null,
  ...overrides,
});
const viewer = (overrides = {}) => ({
  signedIn: true,
  own: own(),
  eventStatus: "live",
  ...overrides,
});

describe("naming a mic's turns", () => {
  it("writes amounts in whole Yap Coins and askers by their handle", () => {
    assert.equal(yc(2500), "2,500 YC");
    assert.equal(askerName("zoe"), "@zoe");
    assert.equal(askerName(null), "A viewer");
  });

  it("finds a mic turn by its number", () => {
    const turns = [past(8, "question"), past(9, "answer")];
    assert.equal(micTurnAt(turns, 9).kind, "answer");
    assert.equal(micTurnAt(turns, 7), null);
    assert.equal(micTurnAt(undefined, 8), null);
    assert.equal(micTurnAt(turns, null), null);
  });

  it("names each kind, who has the floor and which debater speaks", () => {
    const turns = [
      ["question", "Question", "@zoe", null, "@zoe asks Léo Tremblay"],
      ["answer", "Answer", "Léo Tremblay", "B", "Léo Tremblay answers @zoe"],
      [
        "followup",
        "Follow-up",
        "@zoe",
        null,
        "@zoe follows up with Léo Tremblay",
      ],
      ["answer2", "Answer", "Léo Tremblay", "B", "Léo Tremblay answers @zoe"],
      [
        "extq",
        "Extra question",
        "@zoe",
        null,
        "@zoe asks Léo Tremblay one more",
      ],
      ["exta", "Answer", "Léo Tremblay", "B", "Léo Tremblay answers @zoe"],
      [
        "resume",
        "Floor back",
        "Maya Chen",
        "A",
        "Maya Chen has the floor back",
      ],
    ];
    for (const [kind, word, who, speaker, sentence] of turns) {
      const turn = past(8, kind);
      assert.equal(kindWord(kind), word);
      assert.equal(micTurnWho(turn, names), who);
      assert.equal(micTurnSpeaker(turn), speaker);
      assert.equal(micTurnSentence(turn, names), sentence);
      assert.equal(micTurnLabel(turn, names), `${word} · ${who}`);
    }
  });

  it("titles a mic's turn by its kind and a debater's by its number", () => {
    const turns = [past(8, "question"), past(9, "answer")];
    assert.equal(
      turnTitle({ turnNumber: 8, total: 10, turns, names }),
      "Question · @zoe",
    );
    // Each mic turn makes the debate one turn longer.
    assert.equal(totalTurns(10, turns), 12);
    assert.equal(totalTurns(10, undefined), 10);
    assert.equal(totalTurns(null, turns), null);
    assert.equal(
      turnTitle({ turnNumber: 10, total: 10, turns, names }),
      "Turn 10 of 12",
    );
    assert.equal(
      turnTitle({ turnNumber: 3, total: null, turns: undefined, names }),
      "Turn 3",
    );
    assert.equal(turnTitle({ turnNumber: null, total: 10, turns, names }), "");
  });

  it("says who speaks after each turn of the exchange", () => {
    const next = (kind, funded = false) =>
      nextAfterMicTurn(past(8, kind), funded, names);
    assert.deepEqual(next("question"), { side: "B", name: "Léo" });
    assert.deepEqual(next("followup"), { side: "B", name: "Léo" });
    assert.deepEqual(next("extq"), { side: "B", name: "Léo" });
    assert.deepEqual(next("answer"), { side: null, name: "@zoe" });
    // After the last answer: the asker again if viewers kept them on.
    assert.deepEqual(next("answer2", true), { side: null, name: "@zoe" });
    assert.deepEqual(next("answer2"), { side: "A", name: "Maya" });
    assert.deepEqual(next("exta"), { side: "A", name: "Maya" });
    assert.equal(next("resume"), null);
  });
});

describe("the list", () => {
  it("is off without a mic, before its list, open, then over", () => {
    assert.equal(micPhase(null, "live"), "off");
    assert.equal(micPhase(mic({ enabled: false }), "live"), "off");
    assert.equal(micPhase(mic({ list: null }), "live"), "before");
    assert.equal(micPhase(mic({ list: null }), "scheduled"), "before");
    assert.equal(micPhase(mic(), "live"), "open");
    assert.equal(micPhase(mic(), "replay"), "over");
    assert.equal(
      micPhase(mic({ list: list({ state: "closed" }) }), "live"),
      "over",
    );
    // An older server names no switch: only a list shows the mic is on.
    const older = (value) => {
      const next = mic(value);
      delete next.enabled;
      return next;
    };
    assert.equal(micPhase(older({ list: null }), "live"), "off");
    assert.equal(micPhase(older({}), "live"), "open");
  });

  it("says where the list stands", () => {
    assert.equal(stateLine("off", null), "");
    assert.match(stateLine("before", mic()), /opens after round 3/);
    assert.match(stateLine("open", mic()), /^The list is open/);
    assert.match(
      stateLine("open", mic({ list: list({ extra: true }) })),
      /^A new list is open/,
    );
    assert.match(stateLine("over", mic()), /closed/);
  });

  it("ranks a debater's questions with their totals and comments", () => {
    const value = mic({
      list: list({
        camps: {
          A: [
            question("q1", "B", 340, {
              author: "zoe",
              pledges: 1,
              adds: [
                { text: "Ask for a date", by: "kofi" },
                { text: "Numbers", by: null },
              ],
            }),
            question("q2", "B", 120, { author: null }),
          ],
          B: [],
        },
      }),
    });
    const view = campView(value, "B", viewer(), names);
    assert.equal(view.target, "B");
    assert.deepEqual(
      view.rows.map((row) => [row.rank, row.total, row.meta]),
      [
        [1, "340 YC", "@zoe · 1 pledge"],
        [2, "120 YC", "A viewer · 2 pledges"],
      ],
    );
    assert.deepEqual(view.rows[0].adds, [
      { text: "Ask for a date", by: "@kofi" },
      { text: "Numbers", by: "A viewer" },
    ]);
    // Each question's bar is its total against the list leader's.
    assert.deepEqual(
      view.rows.map((row) => row.share),
      [100, 35],
    );
    assert.equal(view.askBlocked, null);
    assert.equal(view.rows[0].canPledge, true);
    assert.equal(view.rows[0].canFire, false);
    // The other debater has no questions yet.
    assert.equal(
      campView(value, "A", viewer(), names).empty,
      "No questions for Maya yet.",
    );
  });

  it("picks the list a phone shows first", () => {
    const camps = (a, b) =>
      mic({
        list: list({
          camps: {
            A: a.map((total, index) => question(`a${index}`, "B", total)),
            B: b.map((total, index) => question(`b${index}`, "A", total)),
          },
        }),
      });
    // Camp A asks debater B: the most backed question's debater comes first.
    assert.equal(firstCamp(camps([340, 20], [90]), null), "B");
    assert.equal(firstCamp(camps([40], [90]), null), "A");
    assert.equal(firstCamp(camps([], []), null), "A");
    assert.equal(firstCamp(mic({ list: null }), null), "A");
    // The viewer's own question wins over the totals.
    assert.equal(
      firstCamp(
        camps([340], [90]),
        own({
          pledges: [{ id: "p1", questionId: "b0", amount: 90, wager: true }],
        }),
      ),
      "A",
    );
    // A pledge on someone else's question doesn't.
    assert.equal(
      firstCamp(
        camps([340], [90]),
        own({
          pledges: [{ id: "p1", questionId: "b0", amount: 90, wager: false }],
        }),
      ),
      "B",
    );
  });

  it("lets only the author of a debater's top question fire", () => {
    const mine = own({
      pledges: [
        { id: "p1", questionId: "q1", amount: 100, wager: true },
        { id: "p2", questionId: "q3", amount: 20, wager: false },
      ],
    });
    const top = campView(mic(), "B", viewer({ own: mine }), names);
    assert.equal(top.rows[0].own, true);
    assert.equal(top.rows[0].canFire, true);
    assert.deepEqual(top.rows[0].mine, [
      { id: "p1", amount: 100, wager: true },
    ]);
    assert.match(top.askBlocked, /already have a question/);
    assert.deepEqual(fireable(mic(), viewer({ own: mine }), names).target, "B");
    assert.equal(micBadge(mic(), viewer({ own: mine }), names), "#1");
    // A pledge alone, or second place, fires nothing.
    const other = campView(mic(), "A", viewer({ own: mine }), names);
    assert.equal(other.rows[0].own, false);
    assert.equal(other.rows[0].canFire, false);
    const second = own({
      pledges: [{ id: "p1", questionId: "q2", amount: 100, wager: true }],
    });
    assert.equal(fireable(mic(), viewer({ own: second }), names), null);
    assert.equal(micBadge(mic(), viewer({ own: second }), names), "3");
  });

  it("says why a viewer can't ask or pledge", () => {
    const blocked = (who, value = mic()) =>
      campView(value, "B", viewer(who), names);
    const signedOut = blocked({ signedIn: false, own: null });
    assert.match(signedOut.askBlocked, /need an account/);
    assert.equal(signedOut.rows[0].canPledge, false);
    assert.match(
      blocked({ own: own({ seated: true }) }).askBlocked,
      /Debaters can't/,
    );
    assert.match(blocked({ own: null }).askBlocked, /Checking/);
    assert.equal(
      blocked({ eventStatus: "ended" }).askBlocked,
      "The list isn't open.",
    );
    // L22: a debater asked once takes no more questions in this list.
    const fired = mic({
      list: list({ camps: { A: [], B: [question("q3", "A", 210)] } }),
      mics: [entry()],
    });
    const camp = blocked({}, fired);
    assert.equal(camp.askBlocked, "Léo has already been asked in this list.");
    assert.equal(camp.empty, "@zoe fired this mic for 340 YC.");
    assert.equal(camp.fired.id, "mic-1");
  });

  it("badges the open questions, and nothing without an open list", () => {
    assert.equal(micBadge(mic(), viewer(), names), "3");
    assert.equal(micBadge(mic({ list: null }), viewer(), names), "");
    assert.equal(micBadge(null, viewer(), names), "");
    assert.equal(
      micBadge(
        mic({ list: list({ camps: { A: [], B: [] } }) }),
        viewer(),
        names,
      ),
      "",
    );
  });
});

describe("the live mic and keeping the asker on", () => {
  it("says who has the mic, what they are doing and who waits", () => {
    assert.equal(liveView(mic(), names), null);
    const value = mic({
      mics: [
        entry(),
        entry({ id: "mic-2", state: "queued", holder: "arjun", target: "A" }),
      ],
      turn: micTurn("followup"),
    });
    assert.deepEqual(liveView(value, names), {
      line: "@zoe has the mic",
      detail: "Asking Léo Tremblay · follow-up",
      queued: ["@arjun asks Maya Chen"],
    });
    // Fired, and waiting for the clock to start it.
    assert.equal(
      liveView(mic({ mics: [entry({ started: false })] }), names).detail,
      "Asking Léo Tremblay · starting",
    );
    assert.deepEqual(
      liveView(mic({ mics: [entry({ state: "queued" })] }), names),
      { line: "", detail: "", queued: ["@zoe asks Léo Tremblay"] },
    );
  });

  it("shows the fund's progress, what is left and the viewer's pledge", () => {
    assert.equal(fundView(mic(), null), null);
    const value = mic({ mics: [entry()], fund: fund() });
    assert.deepEqual(
      fundView(value, own({ kept: { fundId: "fund-1", amount: 20 } })),
      {
        title: "Keep @zoe on for one more question",
        progress: "120 of 340 YC",
        percent: 35,
        left: 220,
        open: true,
        note: "Open until their follow-up ends. Refunded if the price isn't reached.",
        mine: "You pledged 20 YC.",
      },
    );
    const funded = fundView(
      mic({
        mics: [entry()],
        fund: fund({ raised: 340, state: "funded", closesAfter: "extq" }),
      }),
      own({ kept: { fundId: "another", amount: 20 } }),
    );
    assert.equal(funded.open, false);
    assert.equal(funded.mine, "");
    assert.match(funded.note, /^Funded: @zoe stays on/);
    assert.match(
      fundView(mic({ fund: fund({ state: "failed" }) }), null).note,
      /Not funded/,
    );
    assert.match(
      fundView(mic({ fund: fund({ closesAfter: "extq" }) }), null).note,
      /extra question ends/,
    );
    assert.equal(fundView(mic({ fund: fund({ price: 0 }) }), null).percent, 0);
  });

  it("gives the asker their controls only in their own turn", () => {
    const value = mic({ mics: [entry()], turn: micTurn("question") });
    assert.equal(askerView(value, own(), names), null);
    assert.equal(askerView(mic(), own({ mics: ["mic-1"] }), names), null);
    const mine = own({ mics: ["mic-1"] });
    assert.match(
      askerView(value, mine, names).title,
      /your question to Léo Tremblay$/,
    );
    assert.match(
      askerView(
        mic({ mics: [entry()], turn: micTurn("followup", { text: "So?" }) }),
        mine,
        names,
      ).title,
      /your follow-up to/,
    );
    const extra = askerView(
      mic({ mics: [entry()], turn: micTurn("extq", { text: "And?" }) }),
      mine,
      names,
    );
    assert.match(extra.title, /your extra question to/);
    // The debater's answer is not the asker's turn.
    assert.equal(
      askerView(mic({ mics: [entry()], turn: micTurn("answer") }), mine, names),
      null,
    );
  });
});

describe("the band over the video", () => {
  it("shows the backed question until the asker types their own", () => {
    assert.equal(bandView(null, names), null);
    assert.equal(bandView(mic(), names), null);
    const asking = bandView(
      mic({ mics: [entry()], turn: micTurn("question"), fund: fund() }),
      names,
    );
    assert.deepEqual(asking, {
      kicker: "Mic · Question",
      line: "@zoe asks Léo Tremblay",
      text: "Who pays for the night buses?",
      asking: true,
      fund: { label: "Keep @zoe on · 120 of 340 YC", percent: 35 },
    });
    assert.equal(
      bandView(
        mic({
          mics: [entry()],
          turn: micTurn("question", { text: "Typed instead" }),
        }),
        names,
      ).text,
      "Typed instead",
    );
    // A follow-up shows nothing until it is typed.
    assert.equal(
      bandView(mic({ mics: [entry()], turn: micTurn("followup") }), names).text,
      "",
    );
  });

  it("shows the question a debater is answering", () => {
    const answer = (turns, kind = "answer", turnNumber = 9) =>
      bandView(
        mic({
          mics: [entry()],
          turn: micTurn(kind, { turnNumber }),
          turns,
          fund: fund({ state: "funded" }),
        }),
        names,
      );
    const typed = answer([past(8, "question", "Typed question")]);
    assert.equal(typed.text, "Typed question");
    assert.equal(typed.asking, false);
    assert.equal(typed.fund, null);
    assert.equal(typed.line, "Léo Tremblay answers @zoe");
    // Nothing typed: the first answer is to the backed question.
    assert.equal(
      answer([past(8, "question")]).text,
      "Who pays for the night buses?",
    );
    assert.equal(answer([]).text, "Who pays for the night buses?");
    // An untyped follow-up has no words to show.
    assert.equal(
      answer(
        [past(8, "question", "Q"), past(9, "answer"), past(10, "followup")],
        "answer2",
        11,
      ).text,
      "",
    );
    // The turn that hands the floor back shows no band.
    assert.equal(
      bandView(mic({ mics: [entry()], turn: micTurn("resume") }), names),
      null,
    );
  });
});

describe("Yapper incoming", () => {
  const starting = (overrides = {}, input = {}) =>
    incomingView({
      mic: mic({ mics: [entry()], turn: micTurn("question"), ...overrides }),
      names,
      seen: null,
      now,
      turnSeconds: 60,
      ...input,
    });

  it("plays when a mic's question starts, naming whom it cut", () => {
    assert.deepEqual(starting(), {
      turnNumber: 8,
      asker: "@zoe",
      target: "asks Léo Tremblay",
      cut: "Maya Chen cut off · 0:23 lost",
      spoken:
        "Yapper incoming. @zoe asks Léo Tremblay. Maya Chen cut off, 0:23 lost.",
    });
    // A mic that started at a turn's end cut nobody.
    const calm = starting({ mics: [entry({ cut: null })] });
    assert.equal(calm.cut, "");
    assert.equal(calm.spoken, "Yapper incoming. @zoe asks Léo Tremblay.");
  });

  it("plays again for an extension question", () => {
    const extra = starting({ turn: micTurn("extq", { turnNumber: 12 }) });
    assert.equal(extra.turnNumber, 12);
    assert.equal(extra.target, "asks one more of Léo Tremblay");
    assert.equal(extra.cut, "");
  });

  it("plays once, and never for a turn found under way", () => {
    assert.equal(starting({}, { seen: 8 }), null);
    assert.equal(starting({ turn: micTurn("answer") }), null);
    assert.equal(starting({ turn: null }), null);
    assert.equal(starting({}, { mic: null }), null);
    assert.equal(
      starting({ turn: micTurn("question", { deadline: null }) }),
      null,
    );
    // Twenty seconds into the question: the page opened late.
    assert.equal(
      starting({
        turn: micTurn("question", {
          deadline: new Date(now + 40_000).toISOString(),
        }),
      }),
      null,
    );
  });
});

describe("Yappers, the mic is open", () => {
  const due = (overrides = {}) =>
    inviteDue({
      mic: mic(),
      eventStatus: "live",
      own: own(),
      seen: null,
      ...overrides,
    });

  it("announces an open list once, to viewers who can take part", () => {
    assert.equal(INVITE_MS, 4200);
    assert.equal(due(), "list-1");
    assert.equal(due({ own: null }), "list-1");
    assert.equal(due({ seen: "list-1" }), null);
    // A new list is announced again.
    assert.equal(due({ seen: "list-0" }), "list-1");
    assert.equal(due({ own: own({ seated: true }) }), null);
  });

  it("waits while there is no open list or a mic is live", () => {
    assert.equal(due({ mic: null }), null);
    assert.equal(due({ mic: mic({ list: null }) }), null);
    assert.equal(due({ eventStatus: "replay" }), null);
    assert.equal(due({ mic: mic({ mics: [entry()] }) }), null);
    assert.equal(
      due({ mic: mic({ mics: [entry({ state: "queued" })] }) }),
      null,
    );
    assert.equal(
      due({ mic: mic({ mics: [entry({ state: "done" })] }) }),
      "list-1",
    );
  });
});

describe("reading the list", () => {
  it("reads a live list often, an upcoming one rarely, a replay once", () => {
    const delay = (overrides) =>
      pollDelay({
        available: true,
        eventStatus: "live",
        hidden: false,
        busy: false,
        ...overrides,
      });
    assert.equal(delay({}), 4000);
    assert.equal(delay({ busy: true }), 2000);
    assert.equal(delay({ hidden: true }), 20_000);
    assert.equal(delay({ eventStatus: "scheduled" }), 30_000);
    assert.equal(delay({ eventStatus: "ready" }), 30_000);
    assert.equal(delay({ eventStatus: "replay" }), null);
    assert.equal(delay({ available: false }), null);
  });

  it("reads the viewer's own part again when it may have changed", () => {
    assert.equal(ownSignature(null, null), "");
    const mine = own({
      pledges: [{ id: "p1", questionId: "q2", amount: 20, wager: false }],
    });
    const before = ownSignature(mic(), mine);
    assert.equal(ownSignature(mic(), mine), before);
    // A total moving changes nothing of the viewer's own.
    const moved = mic({
      list: list({
        camps: {
          A: [question("q1", "B", 900), question("q2", "B", 120)],
          B: [question("q3", "A", 210)],
        },
      }),
    });
    assert.equal(ownSignature(moved, mine), before);
    // A mic firing, a fund opening, or their question leaving the list does.
    assert.notEqual(ownSignature(mic({ mics: [entry()] }), mine), before);
    assert.notEqual(ownSignature(mic({ fund: fund() }), mine), before);
    assert.notEqual(
      ownSignature(
        mic({
          list: list({ camps: { A: [question("q1", "B", 340)], B: [] } }),
        }),
        mine,
      ),
      before,
    );
    assert.notEqual(ownSignature(mic({ list: null }), null), before);
  });

  it("takes whole Yap Coins from a field", () => {
    assert.equal(wholeCoins(" 25 "), 25);
    assert.equal(wholeCoins("0"), null);
    assert.equal(wholeCoins("2.5"), null);
    assert.equal(wholeCoins(""), null);
    assert.equal(wholeCoins("-3"), null);
  });

  it("turns the server's reasons into sentences", () => {
    assert.equal(
      micError(401, "authentication required"),
      "Sign in to use the mic.",
    );
    assert.match(micError(429, "slow down"), /Too many requests/);
    assert.match(
      micError(403, "join the live debate first"),
      /counts you as watching/,
    );
    assert.match(
      micError(409, "insufficient Yap Coins", "insufficient_balance"),
      /enough Yap Coins/,
    );
    assert.match(micError(503, "paused", "mic_paused"), /paused for a moment/);
    assert.match(micError(503, "busy", "busy"), /busy/);
    assert.match(micError(409, "changed", "session_changed"), /Reload/);
    assert.match(micError(500, "boom"), /didn't go through/);
    assert.match(micError(undefined, "network"), /didn't go through/);
    assert.match(micError(409, ""), /didn't go through/);
    assert.equal(
      micError(409, "only the camp's #1 can fire"),
      "Only the camp's #1 can fire.",
    );
    assert.equal(
      micError(400, "write a question first."),
      "Write a question first.",
    );
  });
});
