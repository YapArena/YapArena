import assert from "node:assert/strict";
import { it } from "node:test";

import {
  joinSpeaker,
  SPEAKER_CAMERA,
  speakerCameraOptions,
} from "../public/media-speaker.js";

it("keeps deliberately muted rejoining from capturing the microphone", async () => {
  const paths = [];
  let tokenOptions;
  let options;
  await joinSpeaker({
    button: {},
    microphoneWanted: false,
    mediaDevices: {
      async getUserMedia(value) {
        options = value;
        return {
          getVideoTracks: () => [{ stop() {} }],
          getAudioTracks: () => [],
          getTracks: () => [{ stop() {} }],
        };
      },
    },
    async request(path, requestOptions) {
      paths.push(path);
      if (path === "/speaker-token") tokenOptions = requestOptions;
      return path === "/speaker-token"
        ? { token: "synthetic", url: "wss://synthetic.example", side: "A" }
        : { eventStatus: "live", state: { state: "running" } };
    },
    connect: async () => ({
      localParticipant: {
        identity: "speaker-1",
        setCameraEnabled: async () => ({ track: {} }),
      },
    }),
    tracks: { attach() {} },
    setSide() {},
    setPreparedMicrophone() {
      assert.fail("muted rejoin must not retain a microphone");
    },
    refresh: async () => {},
  });
  assert.equal(options.audio, false);
  assert.equal(paths.includes("/device-check"), false);
  assert.deepEqual(JSON.parse(tokenOptions.body), { replaceExisting: false });
});

it("shows the first speaker's camera and permits reconnect after a pause", async () => {
  const button = { disabled: false };
  const steps = [];
  let paused = false;
  let readyCalls = 0;
  const camera = { kind: "video" };
  const options = {
    button,
    mediaDevices: {
      async getUserMedia() {
        return {
          getVideoTracks: () => [{}],
          getAudioTracks: () => [{}],
          getTracks: () => [{ stop: () => steps.push("preview stopped") }],
        };
      },
    },
    async request(path) {
      if (path === "/speaker-token")
        return { token: "token", url: "wss://example.test", side: "A" };
      if (path === "")
        return {
          eventStatus: paused ? "live" : "ready",
          state: paused ? { state: "paused" } : null,
        };
      return {};
    },
    async connect() {
      assert.equal(button.disabled, true);
      return {
        localParticipant: {
          identity: "speaker-1",
          async setCameraEnabled() {
            assert.ok(steps.includes("preview stopped"));
            steps.push("camera opened");
            return { track: camera };
          },
        },
      };
    },
    tracks: {
      attach(track, identity) {
        assert.equal(track, camera);
        assert.equal(identity, "speaker-1");
        steps.push("camera shown");
      },
    },
    setSide(side) {
      assert.equal(side, "A");
    },
    async markReady() {
      readyCalls += 1;
    },
    async refresh() {},
  };

  assert.match(await joinSpeaker(options), /Connected as speaker A/);
  assert.equal(button.disabled, false);
  assert.deepEqual(steps.slice(0, 3), [
    "preview stopped",
    "camera opened",
    "camera shown",
  ]);
  assert.equal(readyCalls, 1);

  paused = true;
  assert.match(await joinSpeaker(options), /Reconnected as speaker A/);
  assert.equal(button.disabled, false);
  assert.equal(readyCalls, 1);
  assert.equal(steps.filter((step) => step === "camera shown").length, 2);
});

it("restores the join control when camera publishing fails", async () => {
  const button = { disabled: false };
  const preview = { stopped: false };
  await assert.rejects(
    joinSpeaker({
      button,
      mediaDevices: {
        async getUserMedia() {
          return {
            getVideoTracks: () => [{}],
            getAudioTracks: () => [{}],
            getTracks: () => [
              {
                stop: () => {
                  preview.stopped = true;
                },
              },
            ],
          };
        },
      },
      async request(path) {
        return path === "/speaker-token"
          ? { token: "token", url: "wss://example.test", side: "A" }
          : {};
      },
      async connect() {
        return {
          localParticipant: {
            async setCameraEnabled() {
              return undefined;
            },
          },
        };
      },
    }),
    /Could not open camera/,
  );
  assert.equal(preview.stopped, true);
  assert.equal(button.disabled, false);
});

it("keeps a checked microphone muted until its turn and stops it if joining fails", async () => {
  const camera = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const microphone = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  let prepared;
  const mediaDevices = {
    async getUserMedia() {
      return {
        getVideoTracks: () => [camera],
        getAudioTracks: () => [microphone],
        getTracks: () => [camera, microphone],
      };
    },
  };
  const request = async (path) =>
    path === "/speaker-token"
      ? { token: "token", url: "wss://example.test", side: "A" }
      : path === ""
        ? { eventStatus: "live", state: { state: "running" } }
        : {};
  const connect = async () => ({
    localParticipant: {
      identity: "speaker-a",
      async setCameraEnabled() {
        assert.equal(camera.stopped, true);
        assert.equal(microphone.stopped, false);
        return { track: camera };
      },
    },
  });
  await joinSpeaker({
    button: { disabled: false },
    mediaDevices,
    request,
    connect,
    tracks: { attach() {} },
    setSide() {},
    setPreparedMicrophone(track) {
      prepared = track;
    },
    async refresh() {},
  });
  assert.equal(prepared, microphone);
  assert.equal(microphone.enabled, false);
  assert.equal(microphone.stopped, false);

  const failedMicrophone = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  await assert.rejects(
    joinSpeaker({
      button: { disabled: false },
      mediaDevices: {
        async getUserMedia() {
          return {
            getVideoTracks: () => [camera],
            getAudioTracks: () => [failedMicrophone],
            getTracks: () => [camera, failedMicrophone],
          };
        },
      },
      request,
      connect: async () => ({
        localParticipant: {
          async setCameraEnabled() {
            return undefined;
          },
        },
      }),
      setPreparedMicrophone() {
        assert.fail("failed join must not retain microphone");
      },
    }),
    /Could not open camera/,
  );
  assert.equal(failedMicrophone.stopped, true);
});

it("opens every speaker camera in the stage's 8:9 shape on the chosen device", async () => {
  assert.equal(SPEAKER_CAMERA.width / SPEAKER_CAMERA.height, 8 / 9);
  assert.equal(SPEAKER_CAMERA.aspectRatio, 8 / 9);
  assert.deepEqual(speakerCameraOptions(), { resolution: SPEAKER_CAMERA });
  let cameraOptions;
  let shown;
  await joinSpeaker({
    button: {},
    devices: { videoinput: "front-camera" },
    microphoneWanted: false,
    mediaDevices: {
      async getUserMedia() {
        return {
          getVideoTracks: () => [{ stop() {} }],
          getAudioTracks: () => [],
          getTracks: () => [{ stop() {} }],
        };
      },
    },
    async request(path) {
      return path === "/speaker-token"
        ? { token: "synthetic", url: "wss://synthetic.example", side: "B" }
        : { eventStatus: "live", state: { state: "running" } };
    },
    connect: async () => ({
      localParticipant: {
        identity: "speaker-2",
        async setCameraEnabled(enabled, options) {
          assert.equal(enabled, true);
          cameraOptions = options;
          return { track: { kind: "video" } };
        },
      },
    }),
    tracks: {
      attach(...args) {
        shown = args.slice(1);
      },
    },
    setSide() {},
    refresh: async () => {},
  });
  assert.deepEqual(cameraOptions, {
    resolution: SPEAKER_CAMERA,
    deviceId: { exact: "front-camera" },
  });
  // The speaker's own tile is marked as their mirror view.
  assert.deepEqual(shown, ["speaker-2", "B", true]);
});
