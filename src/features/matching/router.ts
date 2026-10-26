import { Router } from "express";
import type { Request, Response } from "express";
import type { createMatchingRepository } from "./repository.ts";
import type { createIdentityRepository } from "../identity/repository.ts";
import type { createMediaRepository } from "../media/repository.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";
import { MediaConflictError } from "../media/repository.ts";
import { createRequireRole } from "../identity/router.ts";
import { MatchConflictError, MatchNotFoundError } from "./repository.ts";
import { PROPOSAL_MIN_LEAD_MINUTES } from "./timings.ts";

type Repository = ReturnType<typeof createMatchingRepository>;
const slugPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number, min = 1): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= min && normalized.length <= max
    ? normalized
    : null;
}

function topicInput(body: unknown) {
  const value = object(body);
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        !["slug", "title", "summary", "sideALabel", "sideBLabel"].includes(key),
    )
  )
    return null;
  const slug = value.slug;
  const title = text(value.title, 140, 5);
  const summary = text(value.summary, 600, 10);
  const sideALabel = text(value.sideALabel, 80, 2);
  const sideBLabel = text(value.sideBLabel, 80, 2);
  if (
    typeof slug !== "string" ||
    !slugPattern.test(slug) ||
    !title ||
    !summary ||
    !sideALabel ||
    !sideBLabel ||
    sideALabel.toLowerCase() === sideBLabel.toLowerCase()
  )
    return null;
  return { slug, title, summary, sideALabel, sideBLabel };
}

// A proposed or scheduled time: 1 hour to 90 days ahead, in UTC ISO form.
function startTime(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  )
    return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) &&
    time.getTime() >= Date.now() + PROPOSAL_MIN_LEAD_MINUTES * 60 * 1000 &&
    time.getTime() <= Date.now() + 90 * 24 * 60 * 60 * 1000
    ? time
    : null;
}

// One to three distinct proposed times (Decision 0011).
function proposedTimes(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    return null;
  const times = value.map(startTime);
  if (times.some((time) => time === null)) return null;
  const valid = times.filter((time): time is Date => time !== null);
  return new Set(valid.map((time) => time.getTime())).size === valid.length
    ? valid
    : null;
}

function requestInput(body: unknown) {
  const value = object(body);
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        ![
          "kind",
          "topicSlug",
          "targetHandle",
          "proposition",
          "requestedSide",
          "scheduledAt",
          "mode",
          "proposedTimes",
        ].includes(key),
    )
  )
    return null;
  const { kind, topicSlug, targetHandle, requestedSide } = value;
  const proposition = text(value.proposition, 240, 10);
  if (
    (kind !== "direct" && kind !== "queue") ||
    typeof topicSlug !== "string" ||
    !slugPattern.test(topicSlug) ||
    !proposition ||
    (requestedSide !== "A" && requestedSide !== "B")
  )
    return null;
  if (
    kind === "direct" &&
    (typeof targetHandle !== "string" || !handlePattern.test(targetHandle))
  )
    return null;
  if (kind === "queue" && targetHandle !== undefined) return null;
  const mode = value.mode ?? "scheduled";
  if (mode !== "now" && mode !== "scheduled") return null;
  if (kind === "queue" && (mode !== "scheduled" || value.proposedTimes))
    return null;
  const base = {
    kind: kind as "direct" | "queue",
    topicSlug,
    targetHandle: typeof targetHandle === "string" ? targetHandle : undefined,
    proposition,
    requestedSide: requestedSide as "A" | "B",
  };
  // "now" carries no time; otherwise one scheduledAt or one to three proposedTimes.
  if (mode === "now")
    return value.scheduledAt === undefined && value.proposedTimes === undefined
      ? { ...base, mode: "now" as const }
      : null;
  if (value.proposedTimes !== undefined) {
    const times = proposedTimes(value.proposedTimes);
    return times && value.scheduledAt === undefined
      ? { ...base, mode: "scheduled" as const, proposedTimes: times }
      : null;
  }
  const scheduledAt = startTime(value.scheduledAt);
  return scheduledAt
    ? { ...base, mode: "scheduled" as const, scheduledAt }
    : null;
}

function errorResponse(response: Response, error: unknown) {
  if (error instanceof MatchNotFoundError)
    return response.status(404).json({ error: error.message });
  if (error instanceof MatchConflictError)
    return response.status(409).json({ error: error.message });
  if (error instanceof MediaConflictError)
    return response.status(409).json({ error: error.message });
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
    return response
      .status(409)
      .json({ error: "resource or active request already exists" });
  throw error;
}

function idFrom(request: Request) {
  const id = request.params.id;
  return typeof id === "string" && uuidPattern.test(id) ? id : null;
}

export function createMatchingRouter({
  matching,
  identity,
  media,
  recordProductAction,
  debateAutoStart,
  liveQueue = false,
}: {
  matching: Repository;
  identity: ReturnType<typeof createIdentityRepository>;
  media?: ReturnType<typeof createMediaRepository>;
  recordProductAction?: ProductActionRecorder;
  // Present with the live queue (Decision 0011): the second ready speaker starts the debate.
  debateAutoStart?: { tryStart(debateId: string): Promise<boolean> };
  // With the live queue on, the old open-request list is retired (Decision 0011).
  liveQueue?: boolean;
}) {
  const router = Router();
  const participant = createRequireRole(identity, ["participant"]);
  const operator = createRequireRole(identity, ["operator"]);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/rules", async (_request, response) =>
    response.json({ rules: await matching.listRules() }),
  );
  router.get("/topics/mine", async (request, response) =>
    response.json({ topics: await matching.listOwnTopics(request.user!.id) }),
  );
  router.post("/topics", participant, async (request, response) => {
    const input = topicInput(request.body);
    if (!input)
      return response.status(400).json({ error: "invalid topic fields" });
    try {
      return response
        .status(201)
        .json({ topic: await matching.createTopic(request.user!.id, input) });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.post(
    "/topics/:slug/publish",
    participant,
    async (request, response) => {
      const slug = request.params.slug;
      if (typeof slug !== "string" || !slugPattern.test(slug))
        return response.status(404).json({ error: "topic not found" });
      const topic = await matching.publishTopic(request.user!.id, slug);
      return topic
        ? response.json({ topic })
        : response.status(404).json({ error: "topic not found" });
    },
  );

  router.get("/requests", async (request, response) =>
    response.json({ requests: await matching.listRequests(request.user!.id) }),
  );
  router.get("/queue", async (_request, response) =>
    response.json({ requests: liveQueue ? [] : await matching.listQueue() }),
  );
  router.post("/requests", participant, async (request, response) => {
    const input = requestInput(request.body);
    if (!input)
      return response.status(400).json({ error: "invalid debate request" });
    if (liveQueue && input.kind === "queue")
      return response.status(400).json({
        error: "open a topic and queue on a side to be matched live",
      });
    try {
      const created = await matching.createRequest(request.user!.id, input);
      await recordProductAction?.(request, {
        type: "match_requested",
        requestId: created.id,
      });
      return response.status(201).json({
        request: created,
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.post(
    "/requests/:id/accept",
    participant,
    async (request, response) => {
      const id = idFrom(request);
      if (!id) return response.status(404).json({ error: "request not found" });
      const body = object(request.body) ?? {};
      const proposalId = body.proposalId;
      if (
        Object.keys(body).some((key) => key !== "proposalId") ||
        (proposalId !== undefined &&
          (typeof proposalId !== "string" || !uuidPattern.test(proposalId)))
      )
        return response.status(400).json({ error: "invalid proposal" });
      try {
        const event = await matching.acceptRequest(request.user!.id, id, {
          proposalId,
        });
        await recordProductAction?.(request, {
          type: "match_accepted",
          debateId: event.id,
        });
        return response.status(201).json({ event });
      } catch (error) {
        return errorResponse(response, error);
      }
    },
  );
  // Either player answers with one to three new times (Decision 0011).
  router.post(
    "/requests/:id/proposals",
    participant,
    async (request, response) => {
      const id = idFrom(request);
      if (!id) return response.status(404).json({ error: "request not found" });
      const body = object(request.body);
      const times =
        body && Object.keys(body).every((key) => key === "times")
          ? proposedTimes(body.times)
          : null;
      if (!times)
        return response.status(400).json({
          error: "propose one to three times, 1 hour to 90 days ahead",
        });
      try {
        return response.json({
          request: await matching.proposeTimes(request.user!.id, id, times),
        });
      } catch (error) {
        return errorResponse(response, error);
      }
    },
  );
  // People to challenge, by handle prefix or part of a display name.
  router.get("/people", async (request, response) => {
    const query = text(request.query.q, 40, 2);
    if (!query) return response.json({ people: [] });
    return response.json({
      people: await matching.searchPeople(request.user!.id, query),
    });
  });
  router.post("/queue/:id/join", participant, async (request, response) => {
    const id = idFrom(request);
    if (!id)
      return response.status(404).json({ error: "queue entry not found" });
    try {
      const event = await matching.joinQueue(request.user!.id, id);
      await recordProductAction?.(request, {
        type: "match_accepted",
        debateId: event.id,
      });
      return response.status(201).json({ event });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  for (const action of ["declined", "withdrawn"] as const) {
    router.post(
      `/requests/:id/${action}`,
      participant,
      async (request, response) => {
        const id = idFrom(request);
        if (!id)
          return response.status(404).json({ error: "request not found" });
        try {
          return response.json({
            request: await matching.closeRequest(request.user!.id, id, action),
          });
        } catch (error) {
          return errorResponse(response, error);
        }
      },
    );
  }

  router.get("/events", async (request, response) =>
    response.json({ events: await matching.listEvents(request.user!.id) }),
  );
  router.get("/events/:id", async (request, response) => {
    const id = idFrom(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    const event = await matching.getEvent(id);
    if (!event) return response.status(404).json({ error: "event not found" });
    const owned = await matching.isParticipant(request.user!.id, id);
    const operator = (await identity.getRoles(request.user!.id)).includes(
      "operator",
    );
    if (!owned && !operator && event.publicationState !== "published")
      return response.status(404).json({ error: "event not found" });
    return response.json({
      event,
      history: owned || operator ? await matching.getEventHistory(id) : [],
    });
  });
  router.post("/events/:id/ready", participant, async (request, response) => {
    const id = idFrom(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    try {
      if (media) await media.assertDeviceReady(id, request.user!.id);
      const event = await matching.markReady(request.user!.id, id);
      if (debateAutoStart && event.status === "ready")
        try {
          await debateAutoStart.tryStart(id);
        } catch (error) {
          // The jobs worker retries every second until the join window closes.
          request.log.error({ error, id }, "automatic debate start failed");
        }
      return response.json({ event });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.post("/events/:id/transition", operator, async (request, response) => {
    const id = idFrom(request);
    const body = object(request.body);
    if (!id) return response.status(404).json({ error: "event not found" });
    if (
      !body ||
      Object.keys(body).some(
        (key) => !["action", "reason", "scheduledAt"].includes(key),
      ) ||
      ![
        "start",
        "end",
        "replay",
        "void_review",
        "cancel",
        "reschedule",
        "no_show",
      ].includes(String(body.action))
    )
      return response.status(400).json({ error: "invalid transition" });
    const action = body.action as
      | "start"
      | "end"
      | "replay"
      | "void_review"
      | "cancel"
      | "reschedule"
      | "no_show";
    if (media && ["start", "end", "replay"].includes(action))
      return response.status(409).json({
        error: "use the media lifecycle endpoint for this transition",
      });
    if (media && action === "void_review") {
      const event = await matching.getEvent(id);
      if (event?.status === "live")
        return response.status(409).json({ error: "end media before review" });
    }
    const reason = text(body.reason, 500, 5);
    if (!reason)
      return response.status(400).json({ error: "a reason is required" });
    const scheduledAt =
      typeof body.scheduledAt === "string"
        ? new Date(body.scheduledAt)
        : undefined;
    if (
      action === "reschedule" &&
      (!scheduledAt || !Number.isFinite(scheduledAt.getTime()))
    )
      return response
        .status(400)
        .json({ error: "valid scheduledAt is required" });
    try {
      return response.json({
        event: await matching.operatorTransition(
          request.user!.id,
          id,
          action,
          reason,
          scheduledAt,
        ),
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  });

  router.get("/notifications", async (request, response) =>
    response.json({
      notifications: await matching.listNotifications(request.user!.id),
    }),
  );
  router.post("/notifications/:id/read", async (request, response) => {
    const id = request.params.id;
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id))
      return response.status(404).json({ error: "notification not found" });
    return (await matching.markNotificationRead(request.user!.id, id))
      ? response.status(204).end()
      : response.status(404).json({ error: "notification not found" });
  });
  return router;
}
