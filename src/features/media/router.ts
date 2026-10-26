import { parsePlaybackReports, type PlaybackReport } from "./telemetry.ts";
import { randomUUID } from "node:crypto";
import { EgressStatus } from "@livekit/protocol";
import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import type { createMediaRepository } from "./repository.ts";
import type { createMediaProvider } from "./provider.ts";
import type { createMatchingRepository } from "../matching/repository.ts";
import type { createIdentityRepository } from "../identity/repository.ts";
import { MediaConflictError, MediaNotFoundError } from "./repository.ts";
import { createDebateStart } from "./debate-start.ts";
import { recordingStart } from "./provider.ts";
import {
  MatchConflictError,
  MatchNotFoundError,
} from "../matching/repository.ts";
import { createRequireRole } from "../identity/router.ts";
import {
  MediaRevocationPendingError,
  type createMediaAccountRevocation,
} from "./account-revocation.ts";
import { hashSessionToken } from "../../platform/auth/session-tokens.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (request: Request) =>
  typeof request.params.id === "string" && uuid.test(request.params.id)
    ? request.params.id
    : null;
function problem(response: Response, error: unknown) {
  if (error instanceof MediaRevocationPendingError)
    return response
      .status(409)
      .json({ error: error.message, code: "speaking_access_moving" });
  if (
    error instanceof MediaNotFoundError ||
    error instanceof MatchNotFoundError
  )
    return response.status(404).json({ error: error.message });
  if (
    error instanceof MediaConflictError ||
    error instanceof MatchConflictError
  )
    return response.status(409).json({ error: error.message });
  throw error;
}

function vtt(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 200_000 ||
    !value.startsWith("WEBVTT\n")
  )
    return false;
  if (/<[a-z!/]/i.test(value)) return false;
  return value.split("\n").length <= 5000;
}

export function createMediaRouter({
  media,
  provider,
  matching,
  identity,
  requireAuth,
  recordPlayback = () => {},
  accountRevocation,
  environment = "development",
}: {
  media: ReturnType<typeof createMediaRepository>;
  provider: ReturnType<typeof createMediaProvider>;
  matching: ReturnType<typeof createMatchingRepository>;
  identity: ReturnType<typeof createIdentityRepository>;
  requireAuth: RequestHandler;
  recordPlayback?: (rows: PlaybackReport[]) => void;
  accountRevocation?: ReturnType<typeof createMediaAccountRevocation>;
  environment?: string;
}) {
  const router = Router();
  const participant = createRequireRole(identity, ["participant"]);
  const operator = createRequireRole(identity, ["operator"]);
  const startDebate = createDebateStart({ media, provider, matching });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.post("/events/:id/playback", (request, response) => {
    if (!idOf(request)) return response.status(404).end();
    const reports = parsePlaybackReports(request.body?.reports);
    if (!reports)
      return response.status(400).json({ error: "invalid playback report" });
    recordPlayback(reports);
    return response.status(204).end();
  });

  router.get("/events/:id", async (request, response) => {
    const id = idOf(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    const snapshot = await media.getPublicSnapshot(id);
    if (!snapshot)
      return response.status(404).json({ error: "event not found" });
    return response.json({
      ...snapshot,
      extensionsEnabled: false,
      preparationUrl: provider.publicUrl,
    });
  });
  router.get(
    "/events/:id/speaker-seat",
    requireAuth,
    participant,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const side = await media.sideFor(id, request.user!.id);
      return side
        ? response.json({ side, userId: request.user!.id })
        : response.status(404).json({ error: "speaker seat not available" });
    },
  );
  router.get("/events/:id/replay", async (request, response) => {
    const id = idOf(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    const [event, state] = await Promise.all([
      media.getPublicEvent(id),
      media.get(id),
    ]);
    if (
      !event ||
      event.publicationState !== "published" ||
      !["replay", "finalized"].includes(event.status) ||
      state?.recordingStatus !== "ready" ||
      !state.recordingKey
    )
      return response.status(404).json({ error: "replay not available" });
    try {
      return response.json(await provider.replayAccess(state.recordingKey));
    } catch (error) {
      request.log.error({ error, id }, "replay object unavailable");
      return response
        .status(503)
        .json({ error: "replay temporarily unavailable" });
    }
  });
  router.get("/events/:id/thumbnail", async (request, response) => {
    const id = idOf(request);
    if (!id) return response.status(404).end();
    const [event, state] = await Promise.all([
      media.getPublicEvent(id),
      media.get(id),
    ]);
    if (
      !event ||
      event.publicationState !== "published" ||
      !["replay", "finalized"].includes(event.status) ||
      state?.recordingStatus !== "ready" ||
      !state.recordingKey
    )
      return response.status(404).end();
    try {
      const bytes = await provider.thumbnail(state.recordingKey);
      return response.type("image/jpeg").send(Buffer.from(bytes));
    } catch {
      return response.status(404).end();
    }
  });
  router.get("/events/:id/captions.vtt", async (request, response) => {
    const id = idOf(request);
    if (!id) return response.status(404).end();
    const event = await media.getPublicEvent(id);
    if (
      !event ||
      event.publicationState !== "published" ||
      !["replay", "finalized"].includes(event.status)
    )
      return response.status(404).end();
    const captions = await media.captions(id);
    return captions
      ? response.type("text/vtt").send(captions)
      : response.status(404).end();
  });
  router.post("/events/:id/viewer-token", async (request, response) => {
    const id = idOf(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    const event = await media.getPublicEvent(id);
    if (
      !event ||
      event.publicationState !== "published" ||
      event.status !== "live"
    )
      return response.status(404).json({ error: "live debate not available" });
    return response.json({
      token: await provider.token(id, randomUUID(), false),
      url: provider.publicUrl,
    });
  });
  router.post(
    "/events/:id/device-check",
    requireAuth,
    participant,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const { cameraOk, microphoneOk } = request.body ?? {};
      if (typeof cameraOk !== "boolean" || typeof microphoneOk !== "boolean")
        return response
          .status(400)
          .json({ error: "cameraOk and microphoneOk are required" });
      try {
        return response.json({
          check: await media.checkDevice(
            id,
            request.user!.id,
            cameraOk,
            microphoneOk,
          ),
        });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  // Taken on the queue screen, before any debate exists (Decision 0011).
  router.post(
    "/device-check",
    requireAuth,
    participant,
    async (request, response) => {
      const { cameraOk, microphoneOk } = request.body ?? {};
      if (typeof cameraOk !== "boolean" || typeof microphoneOk !== "boolean")
        return response
          .status(400)
          .json({ error: "cameraOk and microphoneOk are required" });
      return response.json({
        check: await media.checkAccountDevice(
          request.user!.id,
          cameraOk,
          microphoneOk,
        ),
      });
    },
  );
  router.post(
    "/events/:id/speaker-token",
    requireAuth,
    participant,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const body: unknown = request.body ?? {};
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "replaceExisting") ||
        ("replaceExisting" in body && typeof body.replaceExisting !== "boolean")
      )
        return response
          .status(400)
          .json({ error: "invalid speaker request fields" });
      const [event, side] = await Promise.all([
        media.getPublicEvent(id),
        media.sideFor(id, request.user!.id),
      ]);
      if (
        !side ||
        !event ||
        !["scheduled", "ready", "live"].includes(event.status)
      )
        return response
          .status(404)
          .json({ error: "speaker seat not available" });
      try {
        await media.assertDeviceReady(id, request.user!.id);
        if (accountRevocation) {
          const grant = await accountRevocation.issueSpeakerGrant({
            userId: request.user!.id,
            sessionTokenHash: hashSessionToken(
              request.cookies[
                environment === "production" ? "__Host-session" : "session"
              ],
            ),
            debateId: id,
            allowReplacement:
              "replaceExisting" in body && body.replaceExisting === true,
          });
          return response.json({ ...grant, url: provider.publicUrl });
        }
        return response.json({
          token: await provider.token(id, request.user!.id, true, side),
          url: provider.publicUrl,
          side,
        });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.post(
    "/events/:id/start",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const reason =
        typeof request.body?.reason === "string"
          ? request.body.reason.trim()
          : "";
      if (reason.length < 5 || reason.length > 500)
        return response
          .status(400)
          .json({ error: "reason must be 5–500 characters" });
      try {
        return response.json(
          await startDebate({
            debateId: id,
            actorUserId: request.user!.id,
            reason,
            logger: request.log,
          }),
        );
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.post(
    "/events/:id/end",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const reason =
        typeof request.body?.reason === "string"
          ? request.body.reason.trim()
          : "";
      if (reason.length < 5 || reason.length > 500)
        return response
          .status(400)
          .json({ error: "reason must be 5–500 characters" });
      try {
        const event = await matching.operatorTransition(
          request.user!.id,
          id,
          "end",
          reason,
        );
        const state = await media.stop(id, reason);
        try {
          await provider.setTurn(id, null);
        } catch (permissionError) {
          request.log.error(
            { permissionError, id },
            "failed to revoke speaker turn at end",
          );
        }
        return response.json({ event, state });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.post(
    "/events/:id/pause",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const reason =
        typeof request.body?.reason === "string"
          ? request.body.reason.trim()
          : "";
      if (reason.length < 5 || reason.length > 500)
        return response
          .status(400)
          .json({ error: "reason must be 5–500 characters" });
      try {
        const state = await media.pause(id, request.user!.id, reason);
        await provider.setTurn(id, null);
        return response.json({ state });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.post(
    "/events/:id/resume",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const revision = request.body?.revision;
      if (!Number.isInteger(revision) || revision < 0)
        return response.status(400).json({ error: "revision required" });
      try {
        if ((await provider.connectedSpeakers(id)) !== 2)
          throw new MediaConflictError(
            "both speakers must be connected before resume",
          );
        const state = await media.resume(id, request.user!.id, revision);
        try {
          await provider.setTurn(id, state.activeSide);
        } catch (permissionError) {
          request.log.error(
            { permissionError, id },
            "failed to restore speaker turn after resume",
          );
          await media.pause(
            id,
            request.user!.id,
            "Speaker permissions could not be restored.",
          );
          return response.status(503).json({
            error: "speaker permissions unavailable; debate paused",
          });
        }
        return response.json({ state });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.post(
    "/events/:id/replay",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const reason =
        typeof request.body?.reason === "string"
          ? request.body.reason.trim()
          : "";
      if (reason.length < 5 || reason.length > 500)
        return response
          .status(400)
          .json({ error: "reason must be 5–500 characters" });
      try {
        const state = await media.get(id);
        if (state?.recordingStatus !== "ready" || !state.recordingKey)
          throw new MediaConflictError(
            "verified recording required before replay",
          );
        await provider.replayAccess(state.recordingKey);
        return response.json({
          event: await matching.operatorTransition(
            request.user!.id,
            id,
            "replay",
            reason,
          ),
        });
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  router.put(
    "/events/:id/captions",
    requireAuth,
    operator,
    async (request, response) => {
      const id = idOf(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      if (!vtt(request.body?.vtt))
        return response
          .status(400)
          .json({ error: "valid plain WebVTT required" });
      try {
        const state = await media.get(id);
        if (state?.recordingStatus !== "ready" || !state.recordingKey)
          throw new MediaConflictError(
            "recording must be ready before captions are published",
          );
        await provider.publishCaptions(state.recordingKey, request.body.vtt);
        await media.setCaptions(id, request.body.vtt);
        return response.status(204).end();
      } catch (error) {
        return problem(response, error);
      }
    },
  );
  return router;
}

export function createMediaWebhookRouter({
  media,
  provider,
  accountRevocation,
}: {
  media: ReturnType<typeof createMediaRepository>;
  provider: ReturnType<typeof createMediaProvider>;
  accountRevocation?: ReturnType<typeof createMediaAccountRevocation>;
}) {
  const router = Router();
  router.post("/", async (request, response) => {
    try {
      const event = await provider.webhook(
        request.body.toString("utf8"),
        request.header("Authorization"),
      );
      if (
        event.event === "participant_joined" &&
        event.room?.name &&
        event.participant?.identity.startsWith("speaker-")
      ) {
        const id = event.room.name.replace(/^debate-/, "");
        if (uuid.test(id)) {
          if (
            accountRevocation &&
            !(await accountRevocation.isCurrentGrant(
              id,
              event.participant.identity,
            ))
          ) {
            await provider.removeSpeaker(id, event.participant.identity);
            return response.status(204).end();
          }
          const state = await media.get(id);
          await provider.setTurn(
            id,
            state?.state === "running" ? state.activeSide : null,
          );
        }
      }
      if (
        event.event === "participant_left" &&
        event.room?.name &&
        event.participant?.identity.startsWith("speaker-")
      ) {
        const id = event.room.name.replace(/^debate-/, "");
        if (uuid.test(id)) {
          try {
            const reason = "Speaker disconnected. Operator review required.";
            if (accountRevocation) {
              const applied = await accountRevocation.withSpeakerDeparture(
                id,
                event.participant.identity,
                (client) => media.pauseWithClient(client, id, null, reason),
              );
              if (applied) {
                const current = await media.get(id);
                await provider.setTurn(
                  id,
                  current?.state === "running" ? current.activeSide : null,
                );
              }
            } else {
              await media.pause(id, null, reason);
              await provider.setTurn(id, null);
            }
          } catch (error) {
            if (!(error instanceof MediaConflictError)) throw error;
          }
        }
      }
      if (event.event === "egress_ended" && event.egressInfo?.egressId) {
        const info = event.egressInfo;
        const file = info.fileResults[0];
        const success = Boolean(
          info.status === EgressStatus.EGRESS_COMPLETE &&
          file?.filename &&
          file.size > 0n,
        );
        if (!success)
          request.log.warn(
            { egressId: info.egressId, status: info.status, error: info.error },
            "recording ended without a usable file",
          );
        const state = await media.recordingEnded(
          info.egressId,
          success,
          success ? file!.filename : null,
          success ? recordingStart(file!.startedAt) : null,
        );
        if (state?.state === "running") {
          await media.pause(
            state.debateId,
            null,
            "Recording stopped before the debate ended. Operator review required.",
          );
          await provider.setTurn(state.debateId, null);
        }
      }
      return response.status(204).end();
    } catch (error) {
      request.log.warn({ error }, "invalid or failed media webhook");
      return response.status(400).end();
    }
  });
  return router;
}
