import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import type { Request, RequestHandler } from "express";
import type { createSessionRepository } from "../../platform/auth/sessions.ts";
import { hashSessionToken } from "../../platform/auth/session-tokens.ts";
import { createApiRateLimiter } from "../../platform/security.ts";
import type { createIdentityRepository } from "../identity/repository.ts";
import { createRequireRole } from "../identity/router.ts";
import type {
  createMeasurementRepository,
  DiscoverySurface,
  ProductAction,
  WatchMode,
} from "./repository.ts";
import { renderMeasurementDashboard } from "./web.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const surfaces = new Set<DiscoverySurface>([
  "home",
  "debates",
  "topics",
  "debate",
  "topic",
  "profile",
  "match",
]);
const modes = new Set<WatchMode>(["live", "replay"]);
const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;

export function measurementCookie(environment: string) {
  return environment === "production" ? "__Host-measurement" : "measurement";
}

function tokenHash(request: Request, environment: string) {
  const token = request.cookies?.[measurementCookie(environment)];
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : null;
}

export type ProductActionRecorder = (
  request: Request,
  action: ProductAction,
) => Promise<void>;

export function createProductActionRecorder({
  measurement,
  environment,
}: {
  measurement: ReturnType<typeof createMeasurementRepository>;
  environment: string;
}): ProductActionRecorder {
  return async (request, action) => {
    const hash = tokenHash(request, environment);
    if (!hash || !request.user) return;
    try {
      await measurement.recordAction(hash, request.user.id, action);
    } catch (error) {
      request.log.warn(
        { error, eventType: action.type },
        "product event failed",
      );
    }
  };
}

export function createMeasurementRouter({
  measurement,
  sessions,
  identity,
  requireAuth,
  environment,
  emailFirst = false,
}: {
  measurement: ReturnType<typeof createMeasurementRepository>;
  sessions: Pick<
    ReturnType<typeof createSessionRepository>,
    "findUserByTokenHash"
  >;
  identity: Pick<ReturnType<typeof createIdentityRepository>, "getRoles">;
  requireAuth: RequestHandler;
  environment: string;
  emailFirst?: boolean;
}) {
  const router = Router();
  const cookieName = measurementCookie(environment);
  const secure = environment === "production";
  const operator = createRequireRole(identity, ["operator"]);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  async function optionalUserId(request: Request) {
    const session = request.cookies?.[secure ? "__Host-session" : "session"];
    if (typeof session !== "string") return null;
    const hash = hashSessionToken(session);
    return (await sessions.findUserByTokenHash(hash))?.id ?? null;
  }

  const consentGrants = createApiRateLimiter({
    windowMs: 60 * 60_000,
    limit: 60,
  });
  router.get("/api/measurement/consent", async (request, response) => {
    const hash = tokenHash(request, environment);
    return response.json({
      consented: hash ? await measurement.hasConsent(hash) : false,
    });
  });
  router.post(
    "/api/measurement/consent",
    async (request, response, next) => {
      if (
        !request.body ||
        request.body.consent !== true ||
        Object.keys(request.body).length !== 1
      )
        return response
          .status(400)
          .json({ error: "explicit consent required" });
      const existing = tokenHash(request, environment);
      if (existing && (await measurement.hasConsent(existing)))
        return response.json({ consented: true });
      next();
    },
    // Each new consent stores a row, so new grants are capped per network
    // (YA-14); a browser that already consented is answered above.
    consentGrants,
    async (_request, response) => {
      const token = randomBytes(32).toString("hex");
      await measurement.grant(createHash("sha256").update(token).digest("hex"));
      response.cookie(cookieName, token, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: 180 * 24 * 60 * 60 * 1000,
      });
      return response.status(201).json({ consented: true });
    },
  );
  router.delete("/api/measurement/consent", async (request, response) => {
    const hash = tokenHash(request, environment);
    if (hash) await measurement.withdraw(hash);
    response.clearCookie(cookieName, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
    });
    return response.json({ consented: false });
  });

  router.post("/api/measurement/discovery", async (request, response) => {
    const hash = tokenHash(request, environment);
    if (!hash)
      return response
        .status(403)
        .json({ error: "measurement consent required" });
    const { surface, id } = request.body ?? {};
    if (
      typeof surface !== "string" ||
      !surfaces.has(surface as DiscoverySurface) ||
      (id !== undefined && (typeof id !== "string" || !uuid.test(id))) ||
      Object.keys(request.body).some((key) => !["surface", "id"].includes(key))
    )
      return response.status(400).json({ error: "invalid measurement event" });
    const recorded = await measurement.recordDiscovery(
      hash,
      await optionalUserId(request),
      surface as DiscoverySurface,
      id ?? null,
    );
    return recorded
      ? response.status(204).end()
      : response.status(404).json({ error: "measurement target unavailable" });
  });

  router.post("/api/measurement/watch", async (request, response) => {
    const hash = tokenHash(request, environment);
    if (!hash)
      return response
        .status(403)
        .json({ error: "measurement consent required" });
    const { sessionId, debateId, mode, phase } = request.body ?? {};
    if (
      typeof sessionId !== "string" ||
      !uuid.test(sessionId) ||
      typeof debateId !== "string" ||
      !uuid.test(debateId) ||
      typeof mode !== "string" ||
      !modes.has(mode as WatchMode) ||
      !["start", "progress", "end"].includes(phase) ||
      Object.keys(request.body).some(
        (key) => !["sessionId", "debateId", "mode", "phase"].includes(key),
      )
    )
      return response.status(400).json({ error: "invalid watch event" });
    const recorded =
      phase === "start"
        ? await measurement.startWatch(
            hash,
            await optionalUserId(request),
            sessionId,
            debateId,
            mode as WatchMode,
          )
        : await measurement.progressWatch(hash, sessionId, phase === "end");
    return recorded
      ? response.status(204).end()
      : response.status(404).json({ error: "watch session unavailable" });
  });

  router.get(
    "/api/measurement/dashboard",
    requireAuth,
    operator,
    async (_request, response) => response.json(await measurement.summary()),
  );
  router.get(
    "/api/measurement/affiliations",
    requireAuth,
    operator,
    async (_request, response) =>
      response.json({ items: await measurement.listAffiliations() }),
  );
  router.put(
    "/api/measurement/affiliations",
    requireAuth,
    operator,
    async (request, response) => {
      const { handle, affiliation, reason } = request.body ?? {};
      if (
        typeof handle !== "string" ||
        !handlePattern.test(handle) ||
        !["founder", "independent", "unclassified"].includes(affiliation) ||
        typeof reason !== "string" ||
        reason.trim().length < 10 ||
        reason.trim().length > 500 ||
        Object.keys(request.body).some(
          (key) => !["handle", "affiliation", "reason"].includes(key),
        )
      )
        return response
          .status(400)
          .json({ error: "invalid affiliation review" });
      const updated = await measurement.setAffiliation(
        handle,
        affiliation,
        reason.trim(),
        request.user!.id,
      );
      return updated
        ? response.json({ handle, affiliation })
        : response
            .status(404)
            .json({ error: "published account profile not found" });
    },
  );
  router.get(
    "/measurement",
    requireAuth,
    operator,
    async (_request, response) =>
      response
        .type("html")
        .send(
          renderMeasurementDashboard(
            await measurement.summary(),
            await measurement.listAffiliations(),
            emailFirst,
          ),
        ),
  );

  return router;
}
