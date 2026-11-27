import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mediaPresentation } from "../public/media-presentation.js";

describe("media page state", () => {
  it("shows recording failure after a page refresh and offers no replay action", () => {
    for (const automatic of [false, true]) {
      const view = mediaPresentation(
        "ended",
        { state: "ended", recordingStatus: "failed" },
        automatic,
      );
      assert.match(view.message, /Recording failed.*Replay is unavailable/);
      assert.equal(view.replayVisible, false);
      assert.equal(view.actions.replay, false);
      assert.equal(view.actions.end, false);
    }
  });

  it("describes automatic publication while preserving the manual fallback", () => {
    const state = { state: "ended", recordingStatus: "ready" };
    const automatic = mediaPresentation("ended", state, true);
    assert.match(automatic.message, /prepared.*published automatically/);
    assert.equal(automatic.actions.replay, false);
    assert.equal(automatic.replayVisible, false);
    for (const manual of [undefined, false]) {
      const view = mediaPresentation("ended", state, manual);
      assert.match(view.message, /operator can publish/);
      assert.equal(view.actions.replay, true);
      assert.equal(view.replayVisible, false);
    }
    for (const status of ["replay", "finalized"]) {
      const available = mediaPresentation(status, state, true);
      assert.equal(available.message, "Replay is available.");
      assert.equal(available.replayVisible, true);
      assert.equal(available.actions.replay, false);
    }
  });

  it("shows only actions valid for the current media state", () => {
    assert.equal(mediaPresentation("ready", null).actions.start, true);
    const running = mediaPresentation("live", {
      state: "running",
      activeSide: "A",
      recordingStatus: "recording",
    });
    assert.equal(running.actions.pause, true);
    assert.equal(running.actions.end, true);
    assert.equal(running.actions.replay, false);
    const paused = mediaPresentation("live", {
      state: "paused",
      recordingStatus: "recording",
    });
    assert.equal(paused.actions.resume, true);
    const broken = mediaPresentation("live", {
      state: "paused",
      recordingStatus: "failed",
    });
    assert.equal(broken.actions.resume, false);
    const complete = mediaPresentation("ended", {
      state: "ended",
      recordingStatus: "ready",
    });
    assert.equal(complete.actions.replay, true);
    assert.match(complete.message, /ready/);
  });
});

// Decision 0018: in a viewer's own mic turn no debater has the floor.
describe("media page state with a mic", () => {
  it("says a viewer has the mic instead of naming the clock's side", () => {
    const state = {
      state: "running",
      activeSide: "A",
      recordingStatus: "recording",
    };
    assert.equal(
      mediaPresentation("live", state).message,
      "Live. Speaker A has the floor. Recording recording.",
    );
    assert.equal(
      mediaPresentation("live", { ...state, speakingSide: "A" }).message,
      "Live. Speaker A has the floor. Recording recording.",
    );
    assert.equal(
      mediaPresentation("live", { ...state, speakingSide: null }).message,
      "Live. A viewer has the mic. Recording recording.",
    );
  });
});
