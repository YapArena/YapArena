import { Router, type Request, type Response } from "express";
import {
  INGEST_MAX_BYTES,
  ingestHeaders,
  ingestPath,
  parseOutlineCleanup,
  parseSessionRequest,
  parseTranscriptUpdate,
  verifyIngest,
  type IngestEndpoint,
} from "./protocol.ts";
import type { createTranscriptionRepository } from "./repository.ts";
import type { createOutlineRepository } from "../outline/repository.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Per-debate token bucket: one agent sends about one update a second. Bounded
// so a stream of unknown debate IDs cannot grow it without limit.
export function createDebateRateLimit({
  capacity = 10,
  perSecond = 5,
  maxDebates = 1000,
  now = Date.now,
} = {}) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (debateId: string) => {
    const time = now();
    let bucket = buckets.get(debateId);
    if (!bucket) {
      if (buckets.size >= maxDebates)
        for (const [id, value] of buckets)
          if (value.tokens + ((time - value.at) / 1000) * perSecond >= capacity)
            buckets.delete(id);
      if (buckets.size >= maxDebates) return false;
      bucket = { tokens: capacity, at: time };
      buckets.set(debateId, bucket);
    }
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((time - bucket.at) / 1000) * perSecond,
    );
    bucket.at = time;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

// Private endpoints for the transcriber agent, authenticated by HMAC-SHA256
// over the method, path, timestamp and raw body with a dedicated secret
// (signature version 2, protocol.ts). Mounted with a raw body parser before
// JSON parsing, cookies and same-origin protection.
export function createTranscriptionIngestRouter({
  repository,
  outlines,
  secret,
  allow = createDebateRateLimit(),
  now = Date.now,
  acceptV1Signatures = true,
}: {
  repository: Pick<
    ReturnType<typeof createTranscriptionRepository>,
    "ingest" | "session"
  >;
  /** Decision 0012: accepts the window cleanup when the outline is on. */
  outlines?: Pick<ReturnType<typeof createOutlineRepository>, "applyCleanup">;
  secret: string;
  allow?: (debateId: string) => boolean;
  now?: () => number;
  /**
   * YA-11 rollout: also accept version 1 (body-only) signatures from an agent
   * deployed before version 2. Remove once every agent signs version 2.
   */
  acceptV1Signatures?: boolean;
}) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  let warnedV1At = -Infinity;
  // Returns the parsed body, or answers the request and returns undefined.
  function authenticated(
    request: Request,
    response: Response,
    endpoint: IngestEndpoint,
  ) {
    const id = request.params.id;
    if (typeof id !== "string" || !uuid.test(id)) {
      response.status(404).json({ error: "debate not found" });
      return undefined;
    }
    const raw = Buffer.isBuffer(request.body) ? request.body : undefined;
    if (!raw || raw.length > INGEST_MAX_BYTES) {
      response.status(raw ? 413 : 400).json({ error: "invalid body" });
      return undefined;
    }
    const body = raw.toString("utf8");
    // The path is rebuilt from the checked debate ID and this route's
    // endpoint, so a signature binds the request to both.
    const version = verifyIngest(
      secret,
      {
        method: "POST",
        path: ingestPath(id, endpoint),
        timestamp: request.get(ingestHeaders.timestamp),
        signature: request.get(ingestHeaders.signature),
        body,
      },
      { now: now(), acceptV1: acceptV1Signatures },
    );
    if (!version) {
      response.status(401).json({ error: "invalid signature" });
      return undefined;
    }
    if (version === "v1" && now() - warnedV1At >= 60_000) {
      // At most once a minute: shows that an agent from an earlier release
      // still signs, so the owner knows when version 1 can go.
      warnedV1At = now();
      request.log?.warn(
        { debateId: id, endpoint },
        "transcription ingest accepted a version 1 signature",
      );
    }
    if (!allow(id)) {
      response.set("Retry-After", "1").status(429).json({ error: "slow down" });
      return undefined;
    }
    try {
      return { id, value: JSON.parse(body) as unknown };
    } catch {
      response.status(400).json({ error: "invalid JSON" });
      return undefined;
    }
  }
  router.post("/debates/:id/updates", async (request, response) => {
    const input = authenticated(request, response, "updates");
    if (!input) return;
    const update = parseTranscriptUpdate(input.value);
    if (!update)
      return response.status(400).json({ error: "invalid transcript update" });
    const result = await repository.ingest(input.id, update);
    return response.status(result.status).json(result.body);
  });
  router.post("/debates/:id/cleanup", async (request, response) => {
    const input = authenticated(request, response, "cleanup");
    if (!input) return;
    const cleanup = parseOutlineCleanup(input.value);
    if (!cleanup || !outlines)
      return response.status(400).json({ error: "invalid outline cleanup" });
    const result = await outlines.applyCleanup(input.id, cleanup);
    return response.status(result.status).json(result.body);
  });
  router.post("/debates/:id/session", async (request, response) => {
    const input = authenticated(request, response, "session");
    if (!input) return;
    const session = parseSessionRequest(input.value);
    if (!session)
      return response.status(400).json({ error: "invalid session request" });
    const state = await repository.session(input.id, session.jobId);
    return state
      ? response.json(state)
      : response.status(404).json({ error: "debate not found" });
  });
  return router;
}
