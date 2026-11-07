// The betting panel's window reads, shared with the debate page's other
// modules (frontend/stake-windows.ts). Each module loads on its own, so the
// first read can finish before a module that loads later listens.
import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";

const { onStakeWindows, shareStakeWindows } =
  await import("../public/stake-windows.js");

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
