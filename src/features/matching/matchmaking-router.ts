import { Router } from "express";
import type { Request, Response } from "express";
import type { createMatchmaking } from "./matchmaking.ts";
import type { createIdentityRepository } from "../identity/repository.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";
import { createRequireRole } from "../identity/router.ts";
import type { SseResponse } from "../../platform/sse.ts";
import { MatchConflictError, MatchNotFoundError } from "./repository.ts";

const slugPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ticketInput(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["topicSlug", "side"].includes(key)))
    return null;
  const { topicSlug, side } = value;
  if (typeof topicSlug !== "string" || !slugPattern.test(topicSlug))
    return null;
  if (side !== "A" && side !== "B") return null;
  return { topicSlug, side: side as "A" | "B" };
}

function offerId(request: Request) {
  const id = request.params.id;
  return typeof id === "string" && uuidPattern.test(id) ? id : null;
}

function errorResponse(response: Response, error: unknown) {
  if (error instanceof MatchNotFoundError)
    return response.status(404).json({ error: error.message });
  if (error instanceof MatchConflictError)
    return response.status(409).json({ error: error.message });
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
    return response.status(409).json({ error: "you are already in a queue" });
  throw error;
}

// Live topic queue API (Decision 0011), mounted behind sign-in at /api/matchmaking.
export function createMatchmakingRouter({
  matchmaking,
  identity,
  recordProductAction,
  streams,
}: {
  matchmaking: ReturnType<typeof createMatchmaking>;
  identity: ReturnType<typeof createIdentityRepository>;
  recordProductAction?: ProductActionRecorder;
  streams?: { subscribe(userId: string, response: SseResponse): void };
}) {
  const router = Router();
  const participant = createRequireRole(identity, ["participant"]);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  // Live updates of this player's queue state; without it, clients poll /me.
  router.get("/stream", (request, response) => {
    if (!streams)
      return response
        .status(503)
        .json({ error: "live queue updates are unavailable" });
    return streams.subscribe(request.user!.id, response);
  });
  router.get("/me", async (request, response) =>
    response.json({ state: await matchmaking.state(request.user!.id) }),
  );
  // Clients call this while queued; a waiting ticket without it leaves the queue.
  router.post("/presence", async (request, response) =>
    response.json({ state: await matchmaking.touch(request.user!.id) }),
  );
  router.post("/tickets", participant, async (request, response) => {
    const input = ticketInput(request.body);
    if (!input)
      return response.status(400).json({ error: "choose a topic and a side" });
    try {
      return response
        .status(201)
        .json({ state: await matchmaking.enter(request.user!.id, input) });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.delete("/tickets/current", participant, async (request, response) =>
    response.json({ state: await matchmaking.leave(request.user!.id) }),
  );
  router.post("/offers/:id/accept", participant, async (request, response) => {
    const id = offerId(request);
    if (!id) return response.status(404).json({ error: "match not found" });
    try {
      const result = await matchmaking.accept(request.user!.id, id);
      if (result.debateId)
        await recordProductAction?.(request, {
          type: "match_accepted",
          debateId: result.debateId,
        });
      return response.json({ state: result.state });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.post("/offers/:id/decline", participant, async (request, response) => {
    const id = offerId(request);
    if (!id) return response.status(404).json({ error: "match not found" });
    try {
      return response.json({
        state: await matchmaking.decline(request.user!.id, id),
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  });
  router.get("/topics/:slug/waiting", async (request, response) => {
    const slug = request.params.slug;
    if (typeof slug !== "string" || !slugPattern.test(slug))
      return response.status(404).json({ error: "topic not found" });
    return response.json({ waiting: await matchmaking.waiting(slug) });
  });
  return router;
}
