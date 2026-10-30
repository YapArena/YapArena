import assert from "node:assert/strict";
import { it } from "node:test";

import { createMediaTracks, sideFromMetadata } from "../public/media-tracks.js";

function fakeContainer() {
  const nodes = [];
  return {
    nodes,
    get children() {
      return [...nodes];
    },
    append(node) {
      nodes.push(node);
    },
    insertBefore(node, before) {
      nodes.splice(nodes.indexOf(before), 0, node);
    },
    replaceChildren() {
      nodes.length = 0;
    },
  };
}

function fakeTrack(container, kind = "video") {
  let attachCount = 0;
  let detachCount = 0;
  const track = {
    kind,
    attach() {
      attachCount += 1;
      return {
        tagName: kind.toUpperCase(),
        dataset: {},
        getAttribute(name) {
          return name === "data-side" ? (this.dataset.side ?? null) : null;
        },
        setAttribute() {},
        remove() {
          const index = container.nodes.indexOf(this);
          if (index !== -1) container.nodes.splice(index, 1);
        },
      };
    },
    detach() {
      detachCount += 1;
    },
    counts() {
      return { attachCount, detachCount };
    },
  };
  return track;
}

it("attaches each subscribed track once and removes stale participant tiles", () => {
  const container = fakeContainer();
  const tracks = createMediaTracks(container);
  const first = fakeTrack(container);
  const second = fakeTrack(container);

  tracks.attach(first, "speaker-a");
  tracks.attach(first, "speaker-a");
  tracks.attach(second, "speaker-b");
  assert.equal(container.nodes.length, 2);
  assert.deepEqual(first.counts(), { attachCount: 1, detachCount: 0 });

  tracks.removeParticipant("speaker-a");
  assert.equal(container.nodes.length, 1);
  assert.equal(container.nodes[0].dataset.participant, "speaker-b");
  assert.deepEqual(first.counts(), { attachCount: 1, detachCount: 1 });

  tracks.detach(second);
  tracks.detach(second);
  assert.equal(container.nodes.length, 0);
  assert.deepEqual(second.counts(), { attachCount: 1, detachCount: 1 });
});

it("clears old tracks before a room reconnect and permits a fresh attachment", () => {
  const container = fakeContainer();
  const tracks = createMediaTracks(container);
  const track = fakeTrack(container);

  tracks.attach(track, "speaker-a");
  tracks.clear();
  assert.equal(container.nodes.length, 0);
  assert.deepEqual(track.counts(), { attachCount: 1, detachCount: 1 });

  tracks.attach(track, "speaker-a");
  assert.equal(container.nodes.length, 1);
  assert.deepEqual(track.counts(), { attachCount: 2, detachCount: 1 });
});

it("replaces a speaker's stale camera tile when a new track arrives", () => {
  const container = fakeContainer();
  const tracks = createMediaTracks(container);
  const oldCamera = fakeTrack(container);
  const newCamera = fakeTrack(container);

  tracks.attach(oldCamera, "speaker-a");
  tracks.attach(newCamera, "speaker-a");
  assert.equal(container.nodes.length, 1);
  assert.deepEqual(oldCamera.counts(), { attachCount: 1, detachCount: 1 });
  assert.deepEqual(newCamera.counts(), { attachCount: 1, detachCount: 0 });
});

it("orders videos by side, A left of B, whatever order they arrive in", () => {
  const container = fakeContainer();
  const tracks = createMediaTracks(container);
  const sides = (kind = "VIDEO") =>
    container.nodes
      .filter((node) => node.tagName === kind)
      .map((node) => node.dataset.side ?? "-");

  tracks.attach(fakeTrack(container), "speaker-b", "B");
  tracks.attach(fakeTrack(container, "audio"), "speaker-b", "B");
  tracks.attach(fakeTrack(container), "speaker-a", "A");
  assert.deepEqual(sides(), ["A", "B"]);
  tracks.attach(fakeTrack(container), "viewer-1");
  assert.deepEqual(sides(), ["A", "B", "-"]);
  // A replacement camera keeps its side's place.
  tracks.attach(fakeTrack(container), "speaker-a", "A");
  assert.deepEqual(sides(), ["A", "B", "-"]);
  assert.equal(
    container.nodes.find((n) => n.dataset.side === "A").dataset.participant,
    "speaker-a",
  );
});

it("reads a speaker's side from its token metadata", () => {
  assert.equal(sideFromMetadata('{"side":"A"}'), "A");
  assert.equal(sideFromMetadata('{"side":"B"}'), "B");
  assert.equal(sideFromMetadata('{"side":"C"}'), null);
  assert.equal(sideFromMetadata("not json"), null);
  assert.equal(sideFromMetadata(""), null);
  assert.equal(sideFromMetadata(undefined), null);
  assert.equal(sideFromMetadata("null"), null);
});
