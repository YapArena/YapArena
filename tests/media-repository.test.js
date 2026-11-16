import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMediaRepository,
  MediaConflictError,
  MediaNotFoundError,
} from "../dist/features/media/repository.js";

const id = "33333333-3333-4333-8333-333333333333";

describe("public replay publication policy", () => {
  for (const { name, configuration, expected, roomId = id } of [
    { name: "unconfigured services", expected: false },
    {
      name: "disabled packaging",
      configuration: { enabled: false },
      expected: false,
    },
    {
      name: "all eligible rooms",
      configuration: { enabled: true },
      expected: true,
    },
    {
      name: "an included canary",
      configuration: { enabled: true, allowedRooms: [id] },
      expected: true,
    },
    {
      name: "an included canary with an uppercase request UUID",
      roomId: "ABCDEF12-3333-4333-8333-333333333333",
      configuration: {
        enabled: true,
        allowedRooms: ["abcdef12-3333-4333-8333-333333333333"],
      },
      expected: true,
    },
    {
      name: "a room outside the canary",
      configuration: { enabled: true, allowedRooms: [] },
      expected: false,
    },
  ]) {
    it(`passes the configured publication policy for ${name}`, async () => {
      let parameters;
      const repository = createMediaRepository(
        {
          async query(_sql, values) {
            parameters = values;
            return { rows: [] };
          },
        },
        configuration,
      );
      assert.equal(await repository.getPublicSnapshot(roomId), null);
      assert.deepEqual(parameters, [roomId, expected]);
    });
  }
});

const rules = {
  initial_speaking_time_seconds: 60,
  maximum_duration_seconds: 120,
};
function fake() {
  const seen = [];
  let event = {
    status: "ready",
    publicationState: "published",
    rulesSnapshot: rules,
  };
  let media = null;
  let participant = true;
  let device = false;
  let captions = null;
  const result = (rows = []) => ({ rows });
  async function query(sql, values = []) {
    seen.push({ sql, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return result();
    if (sql.includes("FROM debates WHERE id = $1 FOR UPDATE"))
      return result(event ? [event] : []);
    if (
      sql.includes("FROM debates d JOIN topics") &&
      sql.includes('"publicationState"')
    )
      return result(event ? [event] : []);
    if (sql.startsWith("SELECT side FROM event_participants"))
      return result(participant ? [{ side: "A" }] : []);
    if (sql.startsWith("SELECT 1 FROM event_participants"))
      return result(participant ? [{}] : []);
    if (sql.startsWith("INSERT INTO media_device_checks")) {
      device = Boolean(values[2] && values[3]);
      return result();
    }
    if (sql.startsWith("SELECT 1 FROM media_device_checks"))
      return result(device ? [{}] : []);
    if (sql.startsWith("INSERT INTO debate_media")) {
      media = {
        debateId: id,
        state: "running",
        activeSide: "A",
        turnNumber: 1,
        turnDeadlineAt: new Date(Date.now() + 60000),
        remainingMs: 60000,
        activeMs: 0,
        lastResumedAt: new Date(),
        revision: 0,
        incident: null,
        egressId: values[1],
        recordingStatus: "recording",
        recordingKey: values[3],
        hasCaptions: false,
        compositeLayout: values[4],
      };
      return result([media]);
    }
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM debate_media WHERE debate_id = $1 FOR UPDATE")
    )
      return result(media ? [{ ...media, databaseNow: new Date() }] : []);
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM debate_media WHERE debate_id = $1")
    )
      return result(media ? [media] : []);
    if (
      sql.startsWith("SELECT debate_id AS") &&
      sql.includes("FROM debate_media")
    )
      return result(
        media?.state === "running" && media.turnDeadlineAt <= new Date()
          ? [{ debateId: id }]
          : [],
      );
    if (sql.startsWith("WITH due AS"))
      return result(
        media?.state === "ended" && media.recordingStatus === "processing"
          ? [{ debateId: id, egressId: media.egressId }]
          : [],
      );
    if (sql.startsWith("UPDATE debate_media SET stop_requested_at = NULL"))
      return result();
    if (sql.startsWith("DELETE FROM debate_media")) {
      media = null;
      return result();
    }
    if (sql.startsWith("UPDATE debate_media SET state = 'ended'")) {
      media = {
        ...media,
        state: "ended",
        activeSide: null,
        recordingStatus: "processing",
        revision: media.revision + 1,
      };
      return result([media]);
    }
    if (sql.startsWith("UPDATE debate_media SET state = 'paused'")) {
      assert.equal(values.length, 2);
      assert.match(sql, /incident = \$2/);
      media = {
        ...media,
        state: "paused",
        remainingMs: 30000,
        turnDeadlineAt: null,
        incident: values[1],
        revision: media.revision + 1,
      };
      return result([media]);
    }
    if (sql.startsWith("UPDATE debate_media SET state = 'running'")) {
      if (
        media.state !== "paused" ||
        media.recordingStatus !== "recording" ||
        media.revision !== values[1]
      )
        return result();
      media = {
        ...media,
        state: "running",
        turnDeadlineAt: new Date(Date.now() + media.remainingMs),
        revision: media.revision + 1,
      };
      return result([media]);
    }
    if (sql.startsWith("UPDATE debate_media SET active_side")) {
      media = {
        ...media,
        activeSide: values[1],
        turnNumber: media.turnNumber + 1,
        activeMs: values[2],
        remainingMs: values[3],
        turnDeadlineAt: new Date(Date.now() + values[3]),
        lastResumedAt: new Date(),
        revision: media.revision + 1,
      };
      return result();
    }
    if (sql.startsWith("UPDATE debates SET status = 'ended'")) {
      event.status = "ended";
      return result();
    }
    if (sql.startsWith("UPDATE event_participants SET active")) return result();
    if (sql.startsWith("UPDATE debate_media SET recording_status = CASE")) {
      if (!media || media.egressId !== values[0]) return result();
      const complete = media.state === "ended" && values[1] === "ready";
      media = {
        ...media,
        recordingStatus: complete ? "ready" : "failed",
        recordingKey: complete ? values[2] : null,
      };
      return result([media]);
    }
    if (sql.startsWith("UPDATE debate_media SET recording_status = 'failed'")) {
      media = { ...media, recordingStatus: "failed" };
      return result([media]);
    }
    if (sql.startsWith("SELECT captions_vtt"))
      return result(captions ? [{ captionsVtt: captions }] : []);
    if (sql.startsWith("UPDATE debate_media SET captions_vtt")) {
      if (media?.recordingStatus !== "ready") return result();
      captions = values[1];
      return result([{ debate_id: id }]);
    }
    if (sql.startsWith("INSERT INTO event_history")) return result();
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  return {
    repository: createMediaRepository({
      query,
      connect: async () => ({ query, release() {} }),
    }),
    get event() {
      return event;
    },
    seen,
    setEventMissing() {
      event = null;
    },
    setParticipant(value) {
      participant = value;
    },
    setDeadline(date, activeMs = 0) {
      media.turnDeadlineAt = date;
      media.lastResumedAt = new Date(date.getTime() - media.remainingMs);
      media.activeMs = activeMs;
    },
    state() {
      return media;
    },
  };
}

describe("durable media lifecycle", () => {
  it("keeps published state, speaker seat and device checks server-side", async () => {
    const f = fake();
    assert.equal((await f.repository.getPublicEvent(id)).status, "ready");
    assert.equal(await f.repository.get(id), null);
    assert.equal(await f.repository.sideFor(id, "1"), "A");
    await assert.rejects(
      () => f.repository.assertDeviceReady(id, "1"),
      MediaConflictError,
    );
    f.setParticipant(false);
    await assert.rejects(
      () => f.repository.checkDevice(id, "1", true, true),
      MediaNotFoundError,
    );
    f.setParticipant(true);
    await f.repository.checkDevice(id, "1", true, true);
    await f.repository.assertDeviceReady(id, "1");
    f.event.status = "live";
    await f.repository.checkDevice(id, "1", true, true);
    await f.repository.assertDeviceReady(id, "1");
    f.event.status = "ended";
    await assert.rejects(
      () => f.repository.checkDevice(id, "1", true, true),
      MediaConflictError,
    );
  });

  it("requires prototype timings and a ready event before recording starts early", async () => {
    const f = fake();
    f.event.scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    f.event.rulesSnapshot = {
      initial_speaking_time_seconds: null,
      maximum_duration_seconds: null,
    };
    await assert.rejects(
      () => f.repository.start(id, "egress", "key"),
      MediaConflictError,
    );
    for (const invalid of [
      { initial_speaking_time_seconds: 5, maximum_duration_seconds: 120 },
      { initial_speaking_time_seconds: 60, maximum_duration_seconds: 100 },
      { initial_speaking_time_seconds: 60, maximum_duration_seconds: 8000 },
      { initial_speaking_time_seconds: 60.5, maximum_duration_seconds: 120 },
    ]) {
      f.event.rulesSnapshot = invalid;
      await assert.rejects(
        () => f.repository.start(id, "egress", "key"),
        MediaConflictError,
      );
    }
    f.event.rulesSnapshot = rules;
    const state = await f.repository.start(id, "egress", "key");
    assert.equal(state.activeSide, "A");
    assert.equal(state.recordingStatus, "recording");
    // Decision 0016: a start without a layout is LiveKit's grid page.
    assert.equal(state.compositeLayout, "livekit-grid");
    const insert = f.seen.find(({ sql }) =>
      sql.startsWith("INSERT INTO debate_media"),
    );
    assert.match(insert.sql, /recording_key, composite_layout\)/);
    assert.match(insert.sql, /composite_layout AS "compositeLayout"/);
    await f.repository.undoFailedStart(id);
    f.event.status = "ready";
    const sides = await f.repository.start(id, "egress", "key", "sides-v1");
    assert.equal(sides.compositeLayout, "sides-v1");
    await f.repository.undoFailedStart(id);
    assert.equal(await f.repository.get(id), null);
    f.event.status = "scheduled";
    await assert.rejects(
      () => f.repository.start(id, "egress", "key"),
      MediaConflictError,
    );
  });

  it("pauses with an incident, resumes by revision and ends recording", async () => {
    const f = fake();
    await f.repository.start(id, "egress", "key");
    f.event.status = "live";
    const paused = await f.repository.pause(id, "9", "speaker disconnected");
    assert.equal(paused.state, "paused");
    assert.equal(paused.incident, "speaker disconnected");
    await assert.rejects(
      () => f.repository.resume(id, "9", 0),
      MediaConflictError,
    );
    assert.equal(
      (await f.repository.resume(id, "9", paused.revision)).state,
      "running",
    );
    assert.equal(
      (await f.repository.stop(id, "time complete")).recordingStatus,
      "processing",
    );
    assert.equal((await f.repository.stop(id, "time complete")).state, "ended");
    assert.equal(
      (await f.repository.recordingEnded("egress", true, "key"))
        .recordingStatus,
      "ready",
    );
    assert.equal(await f.repository.captions(id), null);
    await f.repository.setCaptions(id, "WEBVTT\n\nCaption");
    assert.equal(await f.repository.captions(id), "WEBVTT\n\nCaption");
  });

  it("advances equal turns and ends at the maximum duration", async () => {
    const f = fake();
    await f.repository.start(id, "egress", "key");
    f.event.status = "live";
    f.setDeadline(new Date(Date.now() - 1000));
    const first = await f.repository.tick();
    assert.deepEqual(first.turns, [{ debateId: id, side: "B" }]);
    assert.equal(f.state().turnNumber, 2);
    f.setDeadline(new Date(Date.now() - 1000), 60000);
    const second = await f.repository.tick();
    assert.deepEqual(second.turns, []);
    assert.deepEqual(second.ended, [id]);
    assert.equal(f.event.status, "ended");
    assert.equal(f.state().state, "ended");
    assert.deepEqual(await f.repository.claimRecordingStops(), [
      { debateId: id, egressId: "egress" },
    ]);
    await f.repository.recordingStopFailed(id);
    assert.deepEqual(await f.repository.tick(), { turns: [], ended: [] });
  });

  it("marks failed recordings and blocks caption publication", async () => {
    const f = fake();
    await f.repository.start(id, "egress", "key");
    assert.equal(
      (await f.repository.recordingFailed("egress")).recordingStatus,
      "failed",
    );
    await assert.rejects(
      () => f.repository.setCaptions(id, "WEBVTT\n"),
      MediaConflictError,
    );
    assert.equal(
      (await f.repository.recordingEnded("egress", false, null))
        .recordingStatus,
      "failed",
    );
  });

  it("rejects a partial recording and prevents the paused debate from resuming", async () => {
    const f = fake();
    await f.repository.start(id, "egress", "key");
    f.event.status = "live";
    const stopped = await f.repository.recordingEnded("egress", true, "key");
    assert.equal(stopped.recordingStatus, "failed");
    assert.equal(stopped.recordingKey, null);
    const paused = await f.repository.pause(
      id,
      null,
      "recording stopped early",
    );
    await assert.rejects(
      () => f.repository.resume(id, "9", paused.revision),
      MediaConflictError,
    );
  });

  it("does not advance a paused or early turn and rejects repeated pause", async () => {
    const f = fake();
    assert.deepEqual(await f.repository.tick(), { turns: [], ended: [] });
    await f.repository.start(id, "egress", "key");
    f.event.status = "live";
    assert.deepEqual(await f.repository.tick(), { turns: [], ended: [] });
    await f.repository.pause(id, "9", "speaker disconnected");
    await assert.rejects(
      () => f.repository.pause(id, "9", "another incident"),
      MediaConflictError,
    );
    assert.deepEqual(await f.repository.tick(), { turns: [], ended: [] });
    assert.equal(
      await f.repository.recordingEnded("unknown", true, "key"),
      null,
    );
  });

  it("handles missing seats and missing events", async () => {
    const f = fake();
    f.setParticipant(false);
    assert.equal(await f.repository.sideFor(id, "1"), null);
    await assert.rejects(
      () => f.repository.stop(id, "operator ended"),
      MediaNotFoundError,
    );
    await assert.rejects(
      () => f.repository.pause(id, "9", "speaker dropped"),
      MediaConflictError,
    );
    f.setEventMissing();
    assert.equal(await f.repository.getPublicEvent(id), null);
    await assert.rejects(
      () => f.repository.start(id, "egress", "key"),
      MediaNotFoundError,
    );
    await assert.rejects(
      () => f.repository.checkDevice(id, "1", true, true),
      MediaConflictError,
    );
  });

  it("does not advance a due clock before the event is live", async () => {
    const f = fake();
    await f.repository.start(id, "egress", "key");
    f.setDeadline(new Date(Date.now() - 1000));
    assert.deepEqual(await f.repository.tick(), { turns: [], ended: [] });
    assert.equal(f.state().activeSide, "A");
  });
});
