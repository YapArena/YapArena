import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDebateStart } from "../dist/features/media/debate-start.js";
import { MediaConflictError } from "../dist/features/media/repository.js";

const debateId = "44444444-4444-4444-8444-444444444444";

function fixture({ connected = 2, transition, setTurn, stopRecording } = {}) {
  const calls = [];
  const errors = [];
  const media = {
    async start(_id, egress, key) {
      calls.push(`start:${egress}:${key}`);
    },
    async get() {
      return { debateId, state: "running" };
    },
    async pause(_id, actor, reason) {
      calls.push(`pause:${actor}:${reason}`);
    },
    async undoFailedStart() {
      calls.push("undoFailedStart");
    },
  };
  const provider = {
    async connectedSpeakers() {
      return connected;
    },
    async beginRecording() {
      calls.push("beginRecording");
      return { egressId: "egress-1", key: "recording.mp4" };
    },
    async setTurn(_id, side) {
      calls.push(`setTurn:${side}`);
      if (setTurn) await setTurn();
    },
    async stopRecording(egress) {
      calls.push(`stopRecording:${egress}`);
      if (stopRecording) await stopRecording();
    },
  };
  const matching = {
    async operatorTransition(actor, id, action, reason) {
      calls.push(`transition:${actor}:${action}:${reason}`);
      if (transition) await transition();
      return { id, status: "live" };
    },
  };
  const logger = {
    error(details, message) {
      errors.push(message);
    },
  };
  const startDebate = createDebateStart({ media, provider, matching });
  const start = () =>
    startDebate({ debateId, actorUserId: "9", reason: "both ready", logger });
  return { calls, errors, start };
}

describe("shared debate start", () => {
  it("records, starts the clock, goes live and gives side A the turn", async () => {
    const f = fixture();
    const result = await f.start();
    assert.deepEqual(f.calls, [
      "beginRecording",
      "start:egress-1:recording.mp4",
      "transition:9:start:both ready",
      "setTurn:A",
    ]);
    assert.deepEqual(result, {
      event: { id: debateId, status: "live" },
      state: { debateId, state: "running" },
    });
  });

  it("refuses before recording unless both speakers are connected", async () => {
    const f = fixture({ connected: 1 });
    await assert.rejects(f.start(), MediaConflictError);
    assert.deepEqual(f.calls, []);
  });

  it("undoes the start and stops the orphan recording when going live fails", async () => {
    const f = fixture({
      transition: () => {
        throw new MediaConflictError("start raced");
      },
      stopRecording: () => {
        throw new Error("egress unavailable");
      },
    });
    await assert.rejects(f.start(), /start raced/);
    assert.deepEqual(f.calls.slice(-2), [
      "undoFailedStart",
      "stopRecording:egress-1",
    ]);
    assert.deepEqual(f.errors, ["failed to stop orphan recording"]);
  });

  it("pauses a live debate when speaker permissions cannot be applied", async () => {
    const f = fixture({
      setTurn: () => {
        throw new Error("livekit unavailable");
      },
    });
    const result = await f.start();
    assert.equal(result.event.status, "live");
    assert.equal(
      f.calls.at(-1),
      "pause:null:Speaker permissions could not be applied.",
    );
    assert.deepEqual(f.errors, ["failed to set initial speaker turn"]);
  });
});
