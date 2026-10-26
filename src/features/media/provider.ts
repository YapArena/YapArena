import { randomUUID } from "node:crypto";
import {
  AccessToken,
  EgressClient,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import { EncodedFileOutput, EgressStatus, S3Upload } from "@livekit/protocol";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { createReplayAccess, replayPrefix } from "./replay.ts";
import { createReplayThumbnailStorage } from "./replay-thumbnail.ts";

export interface MediaProviderConfig {
  livekitUrl: string;
  livekitPublicUrl: string;
  livekitKey: string;
  livekitSecret: string;
  s3Endpoint?: string;
  s3PublicEndpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  replayEdgeUrl?: string;
  replaySigningSecret?: string;
  replayEdgeRooms?: readonly string[];
}

// LiveKit reports a recording file's start in Unix nanoseconds; 0 is unknown.
export const recordingStart = (nanoseconds: bigint) =>
  nanoseconds > 0n ? new Date(Number(nanoseconds / 1_000_000n)) : null;
export function createMediaProvider(
  config: MediaProviderConfig,
  packagedReplay?: (
    key: string,
  ) => Promise<{ packageKey: string; hasCaptions: boolean } | null>,
) {
  const controlUrl = new URL(config.livekitUrl);
  const supportsTokenRevocation =
    controlUrl.hostname.endsWith(".livekit.cloud");
  const rooms = new RoomServiceClient(
    config.livekitUrl,
    config.livekitKey,
    config.livekitSecret,
    { requestTimeout: 2 },
  );
  const egress = new EgressClient(
    config.livekitUrl,
    config.livekitKey,
    config.livekitSecret,
    { requestTimeout: 5 },
  );
  const receiver = new WebhookReceiver(config.livekitKey, config.livekitSecret);
  const storage = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: Boolean(config.s3Endpoint),
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  });
  const playbackStorage = config.s3PublicEndpoint
    ? new S3Client({
        endpoint: config.s3PublicEndpoint,
        region: config.s3Region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.s3AccessKey,
          secretAccessKey: config.s3SecretKey,
        },
      })
    : storage;
  const thumbnails = createReplayThumbnailStorage(
    { bucket: config.s3Bucket },
    storage,
  );
  const roomName = (id: string) => `debate-${id}`;
  const usesReplayEdge = (key: string) =>
    Boolean(
      config.replayEdgeUrl &&
      (!config.replayEdgeRooms ||
        config.replayEdgeRooms.includes(key.split("/")[1]!)),
    );
  const storageOrigin = config.s3PublicEndpoint
    ? new URL(config.s3PublicEndpoint).origin
    : "https:";
  const playbackOrigin = config.replayEdgeUrl
    ? new URL(config.replayEdgeUrl).origin
    : storageOrigin;
  return Object.freeze({
    supportsTokenRevocation,
    async removeSpeaker(id: string, identity: string) {
      if (
        !supportsTokenRevocation ||
        !/^speaker-(?:[1-9][0-9]*|[a-f0-9-]{36})$/.test(identity)
      )
        throw new Error("protected speaker token revocation is unavailable");
      const clockUrl = new URL(controlUrl.origin);
      clockUrl.protocol = "https:";
      const started = Date.now();
      const clock = await fetch(clockUrl, {
        method: "HEAD",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      const providerTime = Date.parse(clock.headers.get("date") ?? "");
      await clock.body?.cancel();
      // HTTP Date is a clock-health check, not an authentication proof. Cloud's
      // implicit one-minute buffer can permit recently refreshed token replay.
      // Fail closed on missing/stale clock evidence; never fall back to omission.
      if (
        !Number.isFinite(providerTime) ||
        Date.now() - started > 1500 ||
        Math.abs(providerTime - Date.now()) > 5000 ||
        ![null, "0"].includes(clock.headers.get("age"))
      )
        throw new Error("media provider clock could not be verified");
      await rooms.removeParticipant(roomName(id), identity, {
        revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 30),
      });
    },
    publicUrl: config.livekitPublicUrl,
    adaptiveReplay: Boolean(config.replayEdgeUrl),
    playbackOrigin,
    playbackOrigins: Object.freeze(
      config.replayEdgeUrl
        ? [...new Set([playbackOrigin, storageOrigin])]
        : [playbackOrigin],
    ),
    async token(
      id: string,
      identity: string,
      canPublish: boolean,
      side?: "A" | "B",
    ) {
      const token = new AccessToken(config.livekitKey, config.livekitSecret, {
        identity: canPublish ? `speaker-${identity}` : `viewer-${randomUUID()}`,
        ttl: 15 * 60,
        metadata: side ? JSON.stringify({ side }) : undefined,
      });
      token.addGrant({
        roomJoin: true,
        room: roomName(id),
        canPublish,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: canPublish ? [1] : [],
      });
      return token.toJwt();
    },
    async connectedSpeakers(id: string) {
      const people = await rooms.listParticipants(roomName(id));
      return people.filter((person) => person.identity.startsWith("speaker-"))
        .length;
    },
    async setTurn(id: string, side: "A" | "B" | null) {
      const people = await rooms.listParticipants(roomName(id));
      for (const person of people) {
        if (!person.identity.startsWith("speaker-")) continue;
        let speakerSide: string | undefined;
        try {
          speakerSide = JSON.parse(person.metadata || "{}").side;
        } catch {
          /* malformed metadata has no turn */
        }
        const sources = side !== null && speakerSide === side ? [1, 2] : [1];
        const permission = person.permission;
        if (
          permission?.canPublish &&
          permission.canSubscribe &&
          !permission.canPublishData &&
          permission.canPublishSources.length === sources.length &&
          sources.every((source) =>
            permission.canPublishSources.includes(source),
          )
        )
          continue;
        await rooms.updateParticipant(roomName(id), person.identity, {
          permission: {
            canPublish: true,
            canSubscribe: true,
            canPublishData: false,
            canPublishSources: sources,
          },
        });
      }
    },
    async beginRecording(id: string) {
      const key = `debates/${id}/${randomUUID()}.mp4`;
      const output = new EncodedFileOutput({
        filepath: key,
        output: {
          case: "s3",
          value: new S3Upload({
            bucket: config.s3Bucket,
            region: config.s3Region,
            endpoint: config.s3Endpoint ?? "",
            forcePathStyle: Boolean(config.s3Endpoint),
            accessKey: config.s3AccessKey,
            secret: config.s3SecretKey,
          }),
        },
      });
      const result = await egress.startRoomCompositeEgress(
        roomName(id),
        output,
        { layout: "grid" },
      );
      return { egressId: result.egressId, key };
    },
    async stopRecording(egressId: string) {
      await egress.stopEgress(egressId);
    },
    async recordingResult(
      egressId: string,
      expectedKey: string,
      signal?: AbortSignal,
    ) {
      const results = await egress.listEgress({ egressId });
      const result = results.find((row) => row.egressId === egressId);
      signal?.throwIfAborted();
      if (
        !result ||
        [
          EgressStatus.EGRESS_STARTING,
          EgressStatus.EGRESS_ACTIVE,
          EgressStatus.EGRESS_ENDING,
        ].includes(result.status)
      )
        return null;
      const file = result.fileResults.find(
        (row) => row.filename === expectedKey && row.size > 0n,
      );
      if (result.status !== EgressStatus.EGRESS_COMPLETE || !file)
        return { success: false, key: null };
      const head = await storage.send(
        new HeadObjectCommand({ Bucket: config.s3Bucket, Key: expectedKey }),
        { abortSignal: signal },
      );
      if (
        !head.ContentLength ||
        !Number.isSafeInteger(head.ContentLength) ||
        BigInt(head.ContentLength) !== file.size
      )
        throw new Error("recording object has not reached verified completion");
      // Decision 0012: when the file starts, for replay positions.
      const startedAt = recordingStart(file.startedAt);
      return {
        success: true,
        key: expectedKey,
        ...(startedAt && { startedAt }),
      };
    },
    async webhook(body: string, authorization?: string) {
      return receiver.receive(body, authorization);
    },
    async replayAccess(key: string) {
      const packaged = packagedReplay ? await packagedReplay(key) : undefined;
      if (
        !usesReplayEdge(key) ||
        !config.replaySigningSecret ||
        (packagedReplay && !packaged)
      )
        return {
          url: await this.replayUrl(key),
          type: "mp4",
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      await storage.send(
        new HeadObjectCommand({
          Bucket: config.s3Bucket,
          Key: `${replayPrefix(packaged?.packageKey ?? key)}ready.json`,
        }),
      );
      const access = createReplayAccess(
        packaged?.packageKey ?? key,
        config.replayEdgeUrl!,
        config.replaySigningSecret,
      );
      return {
        ...access,
        captionsUrl:
          packaged && !packaged.hasCaptions ? undefined : access.captionsUrl,
      };
    },
    async thumbnail(key: string) {
      return thumbnails.read(key, AbortSignal.timeout(5000));
    },
    async publishCaptions(key: string, captions: string) {
      if (usesReplayEdge(key) && !packagedReplay)
        await storage.send(
          new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: `${replayPrefix(key)}captions.vtt`,
            Body: captions,
            ContentType: "text/vtt",
            CacheControl: "no-store",
          }),
        );
    },
    async replayUrl(key: string) {
      await storage.send(
        new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }),
      );
      return getSignedUrl(
        playbackStorage,
        new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }),
        { expiresIn: 3600 },
      );
    },
  });
}
