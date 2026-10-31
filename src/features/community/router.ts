import QRCode from "qrcode";
import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import type { createIdentityRepository } from "../identity/repository.ts";
import type {
  createCommunityRepository,
  CaseAction,
  ReasonCode,
} from "./repository.ts";
import {
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
  CommunityRateError,
} from "./repository.ts";
import { createRequireRole } from "../identity/router.ts";
import { renderModeration, renderMyModeration, renderOverlay } from "./web.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";
import type { createCommunityStreams } from "./streams.ts";
import { parseRoomCursor } from "./delivery.ts";
import { createPlaybackPresence } from "./presence.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const submissionUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = /^[1-9]\d{0,18}$/;
const validCursor = (value: string) =>
  integer.test(value) && BigInt(value) <= 9223372036854775807n;
const slug = /^[a-z0-9][a-z0-9-]{2,99}$/;
const reasons = new Set<ReasonCode>([
  "harassment",
  "hate",
  "threat",
  "spam",
  "privacy",
  "other",
]);
const actions = new Set<CaseAction>([
  "dismiss",
  "remove_chat",
  "restrict_account",
  "pause_chat",
]);

function pathId(request: Request, key = "id") {
  const value = request.params[key];
  return typeof value === "string" && uuid.test(value) ? value : null;
}
function text(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= minimum && trimmed.length <= maximum
    ? trimmed
    : null;
}
function problem(response: Response, error: unknown) {
  if (error instanceof CommunityNotFoundError)
    return response.status(404).json({ error: error.message });
  if (error instanceof CommunityForbiddenError)
    return response.status(403).json({ error: error.message });
  if (error instanceof CommunityConflictError)
    return response
      .status(409)
      .json({ error: error.message, code: error.code });
  if (error instanceof CommunityRateError) {
    if (error.retryAfterSeconds !== undefined)
      response.set("Retry-After", String(error.retryAfterSeconds));
    return response.status(429).json({
      error: error.message,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      retryAt: error.retryAt,
    });
  }
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    error.code === "23505"
  )
    return response.status(409).json({ error: "request already exists" });
  throw error;
}
async function attempt(
  response: Response,
  work: () => Promise<unknown>,
  status = 200,
) {
  try {
    return response.status(status).json(await work());
  } catch (error) {
    return problem(response, error);
  }
}

export function createCommunityRouter({
  community,
  identity,
  requireAuth,
  applicationOrigin,
  recordProductAction,
  streams,
  emailFirst = false,
}: {
  community: ReturnType<typeof createCommunityRepository>;
  identity: Pick<ReturnType<typeof createIdentityRepository>, "getRoles">;
  requireAuth: RequestHandler;
  applicationOrigin: string;
  emailFirst?: boolean;
  recordProductAction?: ProductActionRecorder;
  streams?: Pick<ReturnType<typeof createCommunityStreams>, "subscribe">;
}) {
  const router = Router();
  const presence = createPlaybackPresence();
  const participant = createRequireRole(identity, ["participant"]);
  const moderator = createRequireRole(identity, ["moderator"]);
  // Guests keep public reads; authenticated authors opt into private correlation.
  const ownRead: RequestHandler = (request, response, next) =>
    request.query.own === "1" ? requireAuth(request, response, next) : next();
  const origin = applicationOrigin.replace(/\/$/, "");
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/debates/:slug/qr.svg", async (request, response) => {
    const key = request.params.slug;
    if (typeof key !== "string" || !slug.test(key))
      return response.status(404).end();
    const event = await community.publicEventBySlug(key);
    if (!event) return response.status(404).end();
    const canonical = `${origin}/debates/${event.slug}`;
    const svg = await QRCode.toString(canonical, {
      type: "svg",
      width: 256,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    return response.type("image/svg+xml").send(svg);
  });
  // An unknown event falls through to the app's not-found page.
  router.get("/overlay/:slug", async (request, response, next) => {
    const key = request.params.slug;
    const event =
      typeof key === "string" && slug.test(key)
        ? await community.publicEventBySlug(key)
        : null;
    return event ? response.type("html").send(renderOverlay(event)) : next();
  });
  router.get("/account/moderation", requireAuth, (_request, response) =>
    response.type("html").send(renderMyModeration(emailFirst)),
  );
  router.get("/moderation", requireAuth, moderator, (_request, response) =>
    response.type("html").send(renderModeration(emailFirst)),
  );

  router.post(
    "/api/community/events/:id/presence",
    async (request, response) => {
      const id = pathId(request);
      const value = request.body;
      if (
        !id ||
        !value ||
        typeof value !== "object" ||
        Object.keys(value).some((k) => k !== "connection" && k !== "active") ||
        typeof value.connection !== "string" ||
        !submissionUuid.test(value.connection) ||
        typeof value.active !== "boolean"
      )
        return response
          .status(400)
          .json({ error: "invalid playback presence" });
      // The same publication gate used by public community reads runs first.
      return attempt(response, async () => {
        await community.summary(id);
        return presence.heartbeat(id, value.connection, value.active);
      });
    },
  );
  router.get("/api/community/events/:id", async (request, response) => {
    const id = pathId(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    return attempt(response, () => community.summary(id));
  });
  router.get("/api/community/events/:id/stream", (request, response) => {
    const id = pathId(request)?.toLowerCase();
    if (!id) return response.status(404).end();
    if (
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return response.status(403).end();
    if (!streams)
      return response
        .set("Retry-After", "30")
        .status(503)
        .json({ error: "community stream is disabled" });
    try {
      // Explicit application cursor wins over EventSource's received-but-unapplied ID.
      const cursor = parseRoomCursor(
        id,
        request.query.cursor ?? request.headers["last-event-id"],
      );
      return streams.subscribe(id, cursor, request.ip ?? "unknown", response);
    } catch {
      return response.status(400).json({ error: "invalid room cursor" });
    }
  });
  router.get("/api/community/events/:id/updates", async (request, response) => {
    const id = pathId(request)?.toLowerCase();
    if (!id) return response.status(404).json({ error: "event not found" });
    let cursor: string | null;
    try {
      cursor = parseRoomCursor(id, request.query.cursor);
    } catch {
      return response.status(400).json({ error: "invalid room cursor" });
    }
    return attempt(response, () => community.publicUpdates(id, cursor));
  });
  router.get(
    "/api/community/events/:id/chat",
    ownRead,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const before = request.query.before;
      if (
        before !== undefined &&
        (typeof before !== "string" || !validCursor(before))
      )
        return response.status(400).json({ error: "invalid chat cursor" });
      return attempt(response, () =>
        community.listChat(id, before as string | undefined, request.user?.id),
      );
    },
  );
  router.get(
    "/api/community/events/:id/chat/sync",
    ownRead,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const after = request.query.after ?? "0";
      const watch = request.query.watch ?? "";
      if (
        typeof after !== "string" ||
        (after !== "0" && !validCursor(after)) ||
        typeof watch !== "string" ||
        watch.length > 4000 ||
        (watch && !watch.split(",").every((value) => validCursor(value)))
      )
        return response.status(400).json({ error: "invalid chat cursor" });
      const watchedIds = watch ? [...new Set(watch.split(","))] : [];
      if (watchedIds.length > 200)
        return response
          .status(400)
          .json({ error: "too many watched messages" });
      response.set("Cache-Control", "no-store");
      return attempt(response, () =>
        community.syncChat(id, after, watchedIds, request.user?.id),
      );
    },
  );
  router.get(
    "/api/community/events/:id/my-like",
    requireAuth,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      return attempt(response, () => community.summary(id, request.user!.id));
    },
  );
  router.get(
    "/api/community/events/:id/chat/submissions",
    requireAuth,
    async (request, response) => {
      const id = pathId(request);
      const keys =
        typeof request.query.keys === "string"
          ? request.query.keys.split(",")
          : [];
      if (
        !id ||
        !keys.length ||
        keys.length > 100 ||
        !keys.every((key) => submissionUuid.test(key))
      )
        return response.status(400).json({ error: "invalid submission keys" });
      return attempt(response, () =>
        community.reconcileSubmissions(id, request.user!.id, keys),
      );
    },
  );
  router.post(
    "/api/community/events/:id/chat",
    requireAuth,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const body = text(request.body?.body, 1, 500);
      if (!body)
        return response.status(400).json({
          error: "chat must be 1–500 characters",
          code: "CHAT_INVALID_BODY",
        });
      const key = request.body?.clientMessageId;
      if (
        key !== undefined &&
        (typeof key !== "string" || !submissionUuid.test(key))
      )
        return response.status(400).json({
          error: "clientMessageId must be a random UUID v4",
          code: "CHAT_INVALID_KEY",
        });
      const roles = await identity.getRoles(request.user!.id);
      return attempt(
        response,
        () =>
          community.postChat(
            id,
            request.user!.id,
            body,
            key?.toLowerCase(),
            roles.includes("participant"),
          ),
        201,
      );
    },
  );
  for (const method of ["put", "delete"] as const) {
    router[method](
      "/api/community/events/:id/like",
      requireAuth,
      participant,
      async (request, response) => {
        const id = pathId(request);
        if (!id) return response.status(404).json({ error: "event not found" });
        return attempt(response, () =>
          community.setLike(id, request.user!.id, method === "put"),
        );
      },
    );
  }
  router.post(
    "/api/community/reports",
    requireAuth,
    participant,
    async (request, response) => {
      const { targetType, targetId, reasonCode } = request.body ?? {};
      const detail = text(request.body?.detail, 10, 500);
      if (
        (targetType !== "event" && targetType !== "chat") ||
        typeof targetId !== "string" ||
        !(targetType === "event" ? uuid : integer).test(targetId) ||
        !reasons.has(reasonCode) ||
        !detail
      )
        return response.status(400).json({ error: "invalid report fields" });
      return attempt(
        response,
        async () => {
          const result = await community.report(
            request.user!.id,
            targetType,
            targetId,
            reasonCode,
            detail,
          );
          await recordProductAction?.(request, {
            type: "report_submitted",
            caseId: result.id,
          });
          return result;
        },
        201,
      );
    },
  );

  router.get(
    "/api/community/me/cases",
    requireAuth,
    async (request, response) =>
      attempt(response, () => community.listMyCases(request.user!.id)),
  );
  router.post(
    "/api/community/cases/:id/appeal",
    requireAuth,
    participant,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const reason = text(request.body?.reason, 10, 500);
      if (!reason)
        return response
          .status(400)
          .json({ error: "appeal reason must be 10–500 characters" });
      return attempt(
        response,
        () => community.appeal(id, request.user!.id, reason),
        201,
      );
    },
  );
  router.get(
    "/api/community/moderation/cases",
    requireAuth,
    moderator,
    async (request, response) => {
      const status = request.query.status ?? "open";
      if (status !== "open" && status !== "dismissed" && status !== "actioned")
        return response.status(400).json({ error: "invalid case status" });
      return attempt(response, () => community.listCases(status));
    },
  );
  router.get(
    "/api/community/moderation/cases/:id",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      return attempt(response, () => community.getCase(id));
    },
  );
  router.post(
    "/api/community/moderation/cases/:id/decision",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const { action, reasonCode } = request.body ?? {};
      const note = text(request.body?.note, 10, 500);
      if (!actions.has(action) || !reasons.has(reasonCode) || !note)
        return response.status(400).json({ error: "invalid case decision" });
      return attempt(response, () =>
        community.decideCase(id, request.user!.id, action, reasonCode, note),
      );
    },
  );
  router.post(
    "/api/community/moderation/cases/:id/resume-chat",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const note = text(request.body?.note, 10, 500);
      if (!note)
        return response
          .status(400)
          .json({ error: "resume note must be 10–500 characters" });
      return attempt(response, () =>
        community.resumeChat(id, request.user!.id, note),
      );
    },
  );
  router.get(
    "/api/community/moderation/appeals",
    requireAuth,
    moderator,
    async (_request, response) =>
      attempt(response, () => community.listAppeals()),
  );
  router.post(
    "/api/community/moderation/appeals/:id/decision",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "appeal not found" });
      const decision = request.body?.decision;
      const note = text(request.body?.note, 10, 500);
      if ((decision !== "upheld" && decision !== "overturned") || !note)
        return response.status(400).json({ error: "invalid appeal decision" });
      return attempt(response, () =>
        community.decideAppeal(id, request.user!.id, decision, note),
      );
    },
  );
  return router;
}
