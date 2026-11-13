// The betting panel's window reads, shared with the debate page's other
// modules (frontend/stake-windows.ts). Each module loads on its own, so the
// first read can finish before a module that loads later listens.
import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";

const {
  onDebateEndorsement,
  onStakeRounds,
  onStakeWindows,
  onStakeWindowsStale,
  reportStakeWindowsFailure,
  shareStakeRounds,
  shareStakeWindows,
} = await import("../public/stake-windows.js");

beforeEach(() => {
  globalThis.window = new EventTarget();
});

// Lets the queued start-up delivery run, as it does once a module's code ends.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const read = (turn) => [{ id: `w${turn}`, turnNumber: turn, state: "open" }];

it("starts a module that listens after the first read from that read", async () => {
  shareStakeWindows({ debateId: "d1", windows: read(1) });
  const seen = [];
  onStakeWindows("d1", (windows) => seen.push(windows));
  // Not before the module's own code has run.
  assert.deepEqual(seen, []);
  await settle();
  assert.deepEqual(seen, [read(1)]);
});

it("gives a module that loads before and one that loads after the read the same windows", async () => {
  const early = [];
  const late = [];
  onStakeWindows("d1", (windows) => early.push(windows));
  await settle();
  shareStakeWindows({ debateId: "d1", windows: read(1) });
  onStakeWindows("d1", (windows) => late.push(windows));
  await settle();
  assert.deepEqual(early, [read(1)]);
  assert.deepEqual(late, [read(1)]);
});

it("hears each later read once", async () => {
  shareStakeWindows({ debateId: "d1", windows: read(1) });
  const seen = [];
  onStakeWindows("d1", (windows) => seen.push(windows));
  await settle();
  shareStakeWindows({ debateId: "d1", windows: read(2) });
  shareStakeWindows({ debateId: "d1", windows: read(3) });
  await settle();
  assert.deepEqual(seen, [read(1), read(2), read(3)]);
});

it("starts from the latest read only", async () => {
  shareStakeWindows({ debateId: "d1", windows: read(1) });
  shareStakeWindows({ debateId: "d1", windows: read(2) });
  const seen = [];
  onStakeWindows("d1", (windows) => seen.push(windows));
  await settle();
  assert.deepEqual(seen, [read(2)]);
});

it("waits for the first read when none was shared yet", async () => {
  const seen = [];
  onStakeWindows("d1", (windows) => seen.push(windows));
  await settle();
  assert.deepEqual(seen, []);
});

it("ignores another debate's windows, kept or new", async () => {
  shareStakeWindows({ debateId: "d2", windows: read(1) });
  const seen = [];
  onStakeWindows("d1", (windows) => seen.push(windows));
  await settle();
  shareStakeWindows({ debateId: "d2", windows: read(2) });
  await settle();
  assert.deepEqual(seen, []);
});

it("keeps the read on window and still sends the page event", () => {
  const events = [];
  globalThis.window.addEventListener("yap:stake-windows", (event) =>
    events.push(event.detail),
  );
  const detail = { debateId: "d1", windows: read(1) };
  shareStakeWindows(detail);
  assert.equal(globalThis.window.yapStakeWindows, detail);
  assert.deepEqual(events, [detail]);
});

it("shares the viewer's own limits the same way, latest first, per debate", async () => {
  const events = [];
  globalThis.window.addEventListener("yap:stake-rounds", (event) =>
    events.push(event.detail),
  );
  shareStakeRounds({ debateId: "d2", limits: { w9: "0.10" } });
  shareStakeRounds({ debateId: "d1", limits: { w1: "0.58" } });
  const seen = [];
  onStakeRounds("d1", (limits) => seen.push(limits));
  assert.deepEqual(seen, []);
  await settle();
  assert.deepEqual(seen, [{ w1: "0.58" }]);
  shareStakeRounds({ debateId: "d1", limits: { w1: "0.58", w2: "0.40" } });
  shareStakeRounds({ debateId: "d2", limits: {} });
  assert.deepEqual(seen, [{ w1: "0.58" }, { w1: "0.58", w2: "0.40" }]);
  assert.deepEqual(globalThis.window.yapStakeRounds, {
    debateId: "d2",
    limits: {},
  });
  assert.equal(events.length, 4);
});

// Decision 0015: the bar on the video takes the debate's last-answer figure
// from the same read, with when its answers are revealed.
it("shares the debate's last-answer figure from each window read", async () => {
  const figure = { throughTurn: 2, yes: 1, accounts: 3 };
  shareStakeWindows({
    debateId: "d1",
    windows: read(1),
    endorsement: figure,
    revealMode: "per_round",
    revealAt: null,
  });
  const seen = [];
  onDebateEndorsement("d1", (view) => seen.push(view));
  onDebateEndorsement("d2", (view) => seen.push(view));
  assert.deepEqual(seen, []);
  await settle();
  assert.deepEqual(seen, [
    { endorsement: figure, revealMode: "per_round", revealAt: null },
  ]);
  // An older server's read carries no figure: the bar stays empty.
  shareStakeWindows({ debateId: "d1", windows: read(2) });
  assert.deepEqual(seen.at(-1), {
    endorsement: null,
    revealMode: "five_day",
    revealAt: null,
  });
  assert.equal(seen.length, 2);
});

it("marks the Results tab stale after a failed read until the next read arrives", () => {
  const stale = [];
  onStakeWindowsStale("d1", (value) => stale.push(value));
  reportStakeWindowsFailure("d2");
  reportStakeWindowsFailure("d1");
  shareStakeWindows({ debateId: "d2", windows: read(1) });
  shareStakeWindows({ debateId: "d1", windows: read(2) });
  assert.deepEqual(stale, [true, false]);
});
