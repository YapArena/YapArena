import assert from "node:assert/strict";
import { it } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { EgressStatus } from "@livekit/protocol";
import {
  EgressClient,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import { createMediaProvider } from "../dist/features/media/provider.js";
const id = "33333333-3333-4333-8333-333333333333";
const recording = `debates/${id}/recording.mp4`;
const config = {
  livekitUrl: "https://live.example",
  livekitPublicUrl: "wss://live.example",
  livekitKey: "synthetic-key",
  livekitSecret: "synthetic-live-secret-more-than-32-characters",
  s3Endpoint: "https://storage.example",
  s3PublicEndpoint: "https://storage.example",
  s3Region: "auto",
  s3Bucket: "synthetic",
  s3AccessKey: "synthetic-key",
  s3SecretKey: "synthetic-secret",
};
it("revokes only exact speaker identities on Cloud with an explicit cutoff after a fresh clock check", async (t) => {
  const removals = [],
    probes = [];
  t.mock.method(
    RoomServiceClient.prototype,
    "removeParticipant",
    async (...args) => removals.push(args),
  );
  let date = new Date().toUTCString(),
    age = "0";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    probes.push({ url: String(url), options });
    return new Response(null, {
      headers: {
        ...(date === null ? {} : { date }),
        ...(age === null ? {} : { age }),
      },
    });
  });
  const provider = createMediaProvider({
    ...config,
    livekitUrl: "wss://trial.livekit.cloud",
  });
  assert.equal(provider.supportsTokenRevocation, true);
  const started = Math.floor(Date.now() / 1000);
  await provider.removeSpeaker(id, `speaker-${id}`);
  assert.equal(removals.length, 1);
  assert.equal(removals[0][0], `debate-${id}`);
  assert.equal(removals[0][1], `speaker-${id}`);
  assert.ok(removals[0][2].revokeTokenTs >= BigInt(started + 30));
  assert.ok(
    removals[0][2].revokeTokenTs <= BigInt(Math.floor(Date.now() / 1000) + 30),
  );
  assert.equal(probes[0].url, "https://trial.livekit.cloud/");
  assert.equal(probes[0].options.method, "HEAD");
  assert.equal(probes[0].options.redirect, "error");
  await assert.rejects(
    provider.removeSpeaker(id, `viewer-${id}`),
    /unavailable/,
  );
  const local = createMediaProvider(config);
  assert.equal(local.supportsTokenRevocation, false);
  await assert.rejects(local.removeSpeaker(id, `speaker-${id}`), /unavailable/);
  for (const value of [
    null,
    "invalid-clock",
    new Date(Date.now() - 15000).toUTCString(),
    new Date(Date.now() + 15000).toUTCString(),
  ]) {
    date = value;
    await assert.rejects(provider.removeSpeaker(id, `speaker-${id}`), /clock/);
  }
  date = new Date().toUTCString();
  for (const value of ["1", "invalid"]) {
    age = value;
    await assert.rejects(provider.removeSpeaker(id, `speaker-${id}`), /clock/);
  }
  assert.equal(
    removals.length,
    1,
    "failed clock checks never fall back to implicit provider revocation",
  );
});
it("reads a small private thumbnail without exposing signed recording URLs", async (t) => {
  const jpeg = Buffer.from([255, 216, 255, 0, 255, 217]);
  t.mock.method(S3Client.prototype, "send", async (command) => {
    assert.equal(command.constructor.name, "GetObjectCommand");
    assert.equal(command.input.Key, `debates/${id}/recording/thumbnail.jpg`);
    return { ContentLength: jpeg.length, Body: Readable.from([jpeg]) };
  });
  const bytes = await createMediaProvider(config).thumbnail(recording);
  assert.deepEqual(Buffer.from(bytes), jpeg);
});
it("gates HLS access on package completion and delivers captions only to private storage", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  const provider = createMediaProvider({
    ...config,
    replayEdgeUrl: "https://edge.example",
    replaySigningSecret: "synthetic-replay-secret-32-characters",
  });
  const grant = await provider.replayAccess(recording);
  assert.equal(grant.type, "hls");
  assert.equal(grant.expiresIn, 300);
  assert.equal(provider.playbackOrigin, "https://edge.example");
  assert.match(commands[0].input.Key, /hls\/ready.json$/);
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.equal(commands[1].input.ContentType, "text/vtt");
  assert.match(commands[1].input.Key, /hls\/captions.vtt$/);
  t.mock.method(S3Client.prototype, "send", async () => {
    throw Error("not packaged");
  });
  await assert.rejects(provider.replayAccess(recording), /not packaged/);
});
it("preserves the explicit signed MP4 fallback and source recording behavior", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  t.mock.method(
    EgressClient.prototype,
    "startRoomCompositeEgress",
    async (room, output) => {
      assert.equal(room, `debate-${id}`);
      assert.match(output.filepath, /\.mp4$/);
      return { egressId: "synthetic-egress" };
    },
  );
  t.mock.method(EgressClient.prototype, "stopEgress", async (egress) =>
    assert.equal(egress, "synthetic-egress"),
  );
  const provider = createMediaProvider(config);
  const grant = await provider.replayAccess(recording);
  assert.equal(grant.type, "mp4");
  assert.equal(grant.expiresIn, 3600);
  assert.match(grant.url, /X-Amz-Signature=/);
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.equal(commands.length, 1);
  const started = await provider.beginRecording(id);
  assert.equal(started.egressId, "synthetic-egress");
  await provider.stopRecording(started.egressId);
  const defaultStorage = createMediaProvider({
    ...config,
    s3Endpoint: undefined,
    s3PublicEndpoint: undefined,
  });
  assert.equal(defaultStorage.playbackOrigin, "https:");
  await defaultStorage.replayUrl(recording);
});
it("limits adaptive rollout to selected rooms while preserving existing MP4 access and captions", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  const provider = createMediaProvider({
    ...config,
    replayEdgeUrl: "https://edge.example",
    replaySigningSecret: "synthetic-replay-secret-32-characters",
    replayEdgeRooms: [id],
  });
  assert.deepEqual(provider.playbackOrigins, [
    "https://edge.example",
    "https://storage.example",
  ]);
  assert.equal((await provider.replayAccess(recording)).type, "hls");
  const other = "debates/44444444-4444-4444-8444-444444444444/recording.mp4";
  assert.equal((await provider.replayAccess(other)).type, "mp4");
  assert.equal(commands.at(-1).input.Key, other);
  const count = commands.length;
  await provider.publishCaptions(other, "WEBVTT\n");
  assert.equal(commands.length, count);
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.match(commands.at(-1).input.Key, /hls\/captions.vtt$/);
});
it("issues subscribe-only viewer grants and permits microphone only to the current speaker", async (t) => {
  const updates = [];
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => [
    { identity: "speaker-1", metadata: '{"side":"A"}' },
    { identity: "speaker-2", metadata: '{"side":"B"}' },
    { identity: "speaker-3", metadata: "invalid" },
    { identity: "viewer-1" },
  ]);
  t.mock.method(
    RoomServiceClient.prototype,
    "updateParticipant",
    async (room, identity, update) => updates.push({ room, identity, update }),
  );
  const provider = createMediaProvider(config);
  const viewer = JSON.parse(
    Buffer.from(
      (await provider.token(id, "1", false)).split(".")[1],
      "base64url",
    ),
  );
  assert.equal(viewer.video.canPublish, false);
  assert.equal(viewer.video.canPublishData, false);
  assert.equal(viewer.video.room, `debate-${id}`);
  const speaker = JSON.parse(
    Buffer.from(
      (await provider.token(id, "1", true, "A")).split(".")[1],
      "base64url",
    ),
  );
  assert.deepEqual(speaker.video.canPublishSources, ["camera"]);
  assert.equal(await provider.connectedSpeakers(id), 3);
  await provider.setTurn(id, "A");
  assert.deepEqual(updates[0].update.permission.canPublishSources, [1, 2]);
  assert.deepEqual(updates[1].update.permission.canPublishSources, [1]);
  assert.deepEqual(updates[2].update.permission.canPublishSources, [1]);
  t.mock.method(WebhookReceiver.prototype, "receive", async () => ({
    event: "synthetic",
  }));
  assert.equal((await provider.webhook("{}", "synthetic")).event, "synthetic");
});

it("recovers missed recording webhooks only from matching successful egress and completed private bytes", async (t) => {
  let result = [];
  let bytes = 25;
  t.mock.method(EgressClient.prototype, "listEgress", async (options) => {
    assert.equal(options.egressId, "fixture-egress");
    return result;
  });
  t.mock.method(S3Client.prototype, "send", async (command) => {
    assert.equal(command.input.Key, recording);
    return { ContentLength: bytes };
  });
  const provider = createMediaProvider(config);
  assert.equal(
    await provider.recordingResult("fixture-egress", recording),
    null,
  );
  for (const status of [
    EgressStatus.EGRESS_STARTING,
    EgressStatus.EGRESS_ACTIVE,
    EgressStatus.EGRESS_ENDING,
  ]) {
    result = [{ egressId: "fixture-egress", status }];
    assert.equal(
      await provider.recordingResult("fixture-egress", recording),
      null,
    );
  }
  for (const status of [
    EgressStatus.EGRESS_FAILED,
    EgressStatus.EGRESS_ABORTED,
    EgressStatus.EGRESS_LIMIT_REACHED,
  ]) {
    result = [{ egressId: "fixture-egress", status, fileResults: [] }];
    assert.deepEqual(
      await provider.recordingResult("fixture-egress", recording),
      { success: false, key: null },
    );
  }
  result = [
    {
      egressId: "fixture-egress",
      status: EgressStatus.EGRESS_COMPLETE,
      fileResults: [{ filename: recording, size: 25n }],
    },
  ];
  assert.deepEqual(
    await provider.recordingResult("fixture-egress", recording),
    { success: true, key: recording },
  );
  bytes = 24;
  await assert.rejects(
    provider.recordingResult("fixture-egress", recording),
    /verified completion/,
  );
  bytes = 0;
  await assert.rejects(
    provider.recordingResult("fixture-egress", recording),
    /verified completion/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.recordingResult("fixture-egress", recording, controller.signal),
    { name: "AbortError" },
  );
  result[0].fileResults[0].filename = "other-source.mp4";
  assert.deepEqual(
    await provider.recordingResult("fixture-egress", recording),
    { success: false, key: null },
  );
});
it("avoids repeating provider updates when current permissions already match the durable turn", async (t) => {
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => [
    {
      identity: "speaker-1",
      metadata: '{"side":"A"}',
      permission: {
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [1, 2],
      },
    },
  ]);
  const update = t.mock.method(
    RoomServiceClient.prototype,
    "updateParticipant",
    async () => {},
  );
  await createMediaProvider(config).setTurn(id, "A");
  assert.equal(update.mock.callCount(), 0);
});
it("never grants a microphone for null or malformed speaker metadata while paused", async (t) => {
  const updates = [];
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () =>
    ["null", "{}", '{"side":null}', '{"side":"invalid"}', "malformed"].map(
      (metadata, i) => ({ identity: `speaker-${i}`, metadata }),
    ),
  );
  t.mock.method(
    RoomServiceClient.prototype,
    "updateParticipant",
    async (_room, _identity, update) => updates.push(update),
  );
  await createMediaProvider(config).setTurn(id, null);
  assert.equal(updates.length, 5);
  assert.ok(
    updates.every(
      (update) => JSON.stringify(update.permission.canPublishSources) === "[1]",
    ),
  );
});

it("authorizes only the current immutable package, and keeps MP4 available during packaging", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  let packaged = {
    packageKey: `debates/${id}/package-new.mp4`,
    hasCaptions: false,
  };
  const provider = createMediaProvider(
    {
      ...config,
      replayEdgeUrl: "https://edge.example",
      replaySigningSecret: "synthetic-replay-secret-32-characters",
    },
    async (key) => {
      assert.equal(key, recording);
      return packaged;
    },
  );
  const access = await provider.replayAccess(recording);
  assert.equal(access.type, "hls");
  assert.match(access.url, /package-new\/hls\/master/);
  assert.equal(access.captionsUrl, undefined);
  assert.match(commands.at(-1).input.Key, /package-new\/hls\/ready.json/);
  const count = commands.length;
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.equal(
    commands.length,
    count,
    "managed captions must never overwrite a published package",
  );
  packaged.hasCaptions = true;
  assert.match(
    (await provider.replayAccess(recording)).captionsUrl,
    /package-new\/hls\/captions/,
  );
  packaged = null;
  assert.equal((await provider.replayAccess(recording)).type, "mp4");
  assert.deepEqual(provider.playbackOrigins, [
    "https://edge.example",
    "https://storage.example",
  ]);
});
it("uploads recordings with the separate Egress key when one is configured", async (t) => {
  const uploads = [];
  t.mock.method(
    EgressClient.prototype,
    "startRoomCompositeEgress",
    async (_room, output) => {
      uploads.push(output.output.value);
      return { egressId: "synthetic-egress" };
    },
  );
  await createMediaProvider(config).beginRecording(id);
  await createMediaProvider({
    ...config,
    s3EgressAccessKey: "synthetic-egress-key",
    s3EgressSecretKey: "synthetic-egress-secret",
  }).beginRecording(id);
  assert.deepEqual(
    uploads.map(({ accessKey, secret }) => [accessKey, secret]),
    [
      ["synthetic-key", "synthetic-secret"],
      ["synthetic-egress-key", "synthetic-egress-secret"],
    ],
  );
});
