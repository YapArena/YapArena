import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBER,
  HOLE,
  LIT_OPACITY,
  PULSE_LOW,
  REFILL_SECONDS,
  REST_OPACITY,
  SPENT_OPACITY,
  WARNING_SECONDS,
  clockFrame,
  frameKey,
  tileAngle,
  tileLook,
  timerLabel,
} from "../public/turn-clock-logic.js";

// The debate page's turn clock (direction BC1, docs/debate-page-design.md):
// the landing emblem draining clockwise over the speaker's turn.

const running = (left, options = {}) =>
  clockFrame({ phase: "running", left, total: 60, reduced: false, ...options });
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual}`);

describe("turn clock", () => {
  it("measures each tile's angle clockwise from 12 o'clock", () => {
    close(tileAngle(HOLE.x, 0), 0);
    close(tileAngle(1, HOLE.y), 0.25);
    close(tileAngle(HOLE.x, 1), 0.5);
    close(tileAngle(0, HOLE.y), 0.75);
    close(tileAngle(10, 0, { x: 0, y: 0 }), 0.25, "around another hole");
  });

  it("rests when no turn runs", () => {
    const frame = clockFrame({
      phase: "rest",
      left: 30,
      total: 60,
      reduced: false,
    });
    assert.deepEqual(frame, {
      spent: 0,
      refill: 1,
      warn: false,
      pulse: 1,
      rest: true,
    });
    assert.deepEqual(tileLook(0.4, frame, false), {
      kind: "rest",
      opacity: REST_OPACITY,
    });
    assert.equal(frameKey(frame), "rest");
  });

  it("lights clockwise as a turn starts, then drains with it", () => {
    const start = running(60);
    assert.equal(start.spent, 0);
    assert.equal(start.refill, 0);
    assert.equal(tileLook(0.1, start, false).kind, "rest", "not lit yet");
    close(running(60 - REFILL_SECONDS / 2).refill, 0.5);
    // A page opened mid-turn is lit at once.
    const middle = running(42);
    close(middle.spent, 0.3);
    assert.equal(middle.refill, 1);
    assert.equal(middle.warn, false);
    assert.equal(middle.pulse, 1);
    assert.deepEqual(tileLook(0.1, middle, false), {
      kind: "spent",
      opacity: SPENT_OPACITY,
    });
    assert.deepEqual(tileLook(0.6, middle, false), {
      kind: "lit",
      opacity: LIT_OPACITY,
    });
    // The ember glows just behind the sweep, brighter nearer to it.
    const near = tileLook(0.3 - EMBER / 10, middle, false);
    const far = tileLook(0.3 - EMBER * 0.9, middle, false);
    assert.equal(near.kind, "ember");
    assert.equal(far.kind, "ember");
    assert.ok(near.opacity > far.opacity);
    assert.ok(far.opacity >= 0.1 && near.opacity <= 0.85);
  });

  it("turns coral and pulses in the last ten seconds", () => {
    const warning = running(WARNING_SECONDS);
    assert.equal(warning.warn, true);
    assert.equal(warning.pulse, 1, "brightest on the second");
    close(running(9.5).pulse, PULSE_LOW, "dimmest at the half second");
    assert.equal(tileLook(0.95, running(9.5), false).kind, "warn");
    assert.equal(running(10.5).warn, false);
    const over = running(0);
    assert.equal(over.spent, 1);
    assert.equal(over.pulse, 1, "no pulse once time is up");
    assert.equal(tileLook(0.99, over, false).kind, "spent");
    assert.equal(running(-3).spent, 1);
  });

  it("waits unlit when the deadline is further away than a turn", () => {
    const early = running(75);
    assert.equal(early.spent, 0);
    assert.equal(early.refill, 0);
    assert.equal(
      clockFrame({ phase: "running", left: 0.5, total: 0, reduced: false })
        .spent,
      0.5,
      "a turn is at least a second long",
    );
  });

  it("steps whole seconds without refill, ember or pulse under reduced motion", () => {
    const reduced = running(41.3, { reduced: true });
    close(reduced.spent, 0.3);
    assert.equal(running(60, { reduced: true }).refill, 1);
    assert.equal(running(9.5, { reduced: true }).pulse, 1);
    assert.equal(
      tileLook(0.3 - EMBER / 2, reduced, true).kind,
      "spent",
      "no ember",
    );
  });

  it("redraws only when the drawn tiles would change", () => {
    assert.equal(frameKey(running(41.97)), frameKey(running(41.96)));
    assert.notEqual(frameKey(running(42)), frameKey(running(41)));
    assert.notEqual(frameKey(running(10.01)), frameKey(running(10)));
    assert.notEqual(frameKey(running(60)), frameKey(running(59.8)));
  });

  it("names the time left for screen readers", () => {
    assert.equal(timerLabel(42, 3), "42 seconds left in turn 3");
    assert.equal(timerLabel(41.2, 3), "42 seconds left in turn 3");
    assert.equal(timerLabel(0.4, null), "1 second left");
    assert.equal(timerLabel(-2, 4), "0 seconds left in turn 4");
  });
});
