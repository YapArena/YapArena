import { createA4Router } from "./features/a4/router.ts";
import type { createPublicBotRepository } from "./features/a4/public-bots.ts";
import type { createA4Repository } from "./features/a4/repository.ts";
import cookieParser from "cookie-parser";
import express from "express";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import type { ErrorRequestHandler, Request } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { createMessageRepository } from "./features/messages/repository.ts";
import type { createDiscoveryRepository } from "./features/discovery/repository.ts";
import type { createIdentityRepository } from "./features/identity/repository.ts";
import type { createMatchingRepository } from "./features/matching/repository.ts";
import type { createMatchmaking } from "./features/matching/matchmaking.ts";
import { createMediaTelemetry } from "./features/media/telemetry.ts";
import type { createMediaRepository } from "./features/media/repository.ts";
import type { createMediaProvider } from "./features/media/provider.ts";
import type { createCommunityRepository } from "./features/community/repository.ts";
import type { createCommunityStreams } from "./features/community/streams.ts";
import type { createMeasurementRepository } from "./features/measurement/repository.ts";
import type { createSessionRepository } from "./platform/auth/sessions.ts";
import type { AccountOperations } from "./platform/auth/account-operations.ts";
import type { RequestHandler } from "express";
import type { createAccountWallet } from "./features/account-wallet/repository.ts";
import type { createMediaAccountRevocation } from "./features/media/account-revocation.ts";
import { createCoinSandboxRouter } from "./features/account-wallet/sandbox-router.ts";
import { createTurnWindowRouter } from "./features/account-wallet/window-router.ts";
import { createEmailAuthSecurity } from "./platform/auth/browser-security.ts";
import { SessionUnavailableError } from "./platform/auth/sessions.ts";

import { createMessageRouter } from "./features/messages/router.ts";
import { createDiscoveryRouter } from "./features/discovery/router.ts";
import { createIdentityRouter } from "./features/identity/router.ts";
import { createMatchingRouter } from "./features/matching/router.ts";
import { createMatchmakingRouter } from "./features/matching/matchmaking-router.ts";
import { createCommunityRouter } from "./features/community/router.ts";
import {
  createMeasurementRouter,
  createProductActionRecorder,
} from "./features/measurement/router.ts";
import {
  createMediaRouter,
  createMediaWebhookRouter,
} from "./features/media/router.ts";
import { renderUnavailable } from "./features/discovery/web.ts";
import { assetRevision } from "./features/discovery/assets.ts";
import {
  createAuthRouter,
  createRequireAuthentication,
  type Auth0SignIn,
} from "./platform/auth/router.ts";
import { pingDatabase } from "./platform/database.ts";
import { createHttpLogger } from "./platform/logger.ts";
import {
  createMetrics,
  createMetricsAuthorization,
} from "./platform/metrics.ts";
import type { SharedRateLimits } from "./platform/shared-abuse.ts";
import { SharedReadCapacityError } from "./platform/shared-read.ts";
import {
  createViewerAdmission,
  mediaDeliveryLane,
} from "./platform/viewer-admission.ts";
import {
  createApiRateLimiter,
  createCsrfOriginProtection,
} from "./platform/security.ts";

export const handleError: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  void _next;
  if (error instanceof SharedReadCapacityError)
    return response
      .set("Retry-After", "1")
      .status(503)
      .json({ error: "public media temporarily busy; retry shortly" });
  if (error instanceof SessionUnavailableError)
    return response
      .set("Cache-Control", "no-store")
      .status(401)
      .json({ error: "authentication required" });

  if (error instanceof SyntaxError) {
    return response.status(400).json({
      error: "request body contains invalid JSON",
    });
  }

  request.log.error({ error }, "unhandled request error");

  if (
    request.headers?.accept?.includes("text/html") &&
    !request.path.startsWith("/api/")
  ) {
    return response.status(500).type("html").send(renderUnavailable());
  }

  return response.status(500).json({
    error: "internal server error",
  });
};

export function createApp({
  messages,
  database,
  a4,
  discovery,
  identity,
  matching,
  matchmaking,
  debateAutoStart,
  media,
  mediaProvider,
  mediaAccountRevocation,
  mediaAdmissionSecret,
  community,
  communityStreams,
  measurement,
  sessions,
  logger,
  environment = "development",
  homepageReferenceEnabled = false,
  publicBots,
  metrics = createMetrics(),
  metricsToken,
  applicationOrigin,
  trustProxy = false,
  requestBodyLimit = "10kb",
  apiRateLimit = 300,
  authRateLimit = 10,
  rateLimitWindowMs = 15 * 60 * 1_000,
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
  auth0,
  accountSecurity,
  coinSandbox,
  coinWebhook,
  turnWindows,
  sharedAuthLimiter,
  sharedAccountLimiter,
  sharedRateLimits,
  accountWallet,
}: {
  messages: ReturnType<typeof createMessageRepository>;
  // Readiness pings this pool. Without it the service reports not ready.
  database?: Pick<Pool, "query">;
  a4?: ReturnType<typeof createA4Repository>;
  discovery?: ReturnType<typeof createDiscoveryRepository>;
  identity?: ReturnType<typeof createIdentityRepository>;
  matching?: ReturnType<typeof createMatchingRepository>;
  // Live topic queue (Decision 0011); present only when MATCHMAKING_ENABLED=true.
  matchmaking?: ReturnType<typeof createMatchmaking>;
  debateAutoStart?: { tryStart(debateId: string): Promise<boolean> };
  media?: ReturnType<typeof createMediaRepository>;
  mediaProvider?: ReturnType<typeof createMediaProvider>;
  mediaAccountRevocation?: ReturnType<typeof createMediaAccountRevocation>;
  mediaAdmissionSecret?: string;
  community?: ReturnType<typeof createCommunityRepository>;
  communityStreams?: Pick<
    ReturnType<typeof createCommunityStreams>,
    "subscribe"
  >;
  measurement?: ReturnType<typeof createMeasurementRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  logger: Logger;
  environment?: string;
  homepageReferenceEnabled?: boolean;
  publicBots?: ReturnType<typeof createPublicBotRepository>;
  metrics?: ReturnType<typeof createMetrics>;
  metricsToken?: string;
  applicationOrigin?: string;
  trustProxy?: number | false;
  requestBodyLimit?: string;
  apiRateLimit?: number;
  authRateLimit?: number;
  rateLimitWindowMs?: number;
  sessionDurationMs?: number;
  // Auth0 sign-in (Decision 0009). Without it, sign-in is unavailable; local
  // tests sign in through the test identity entry under scripts/.
  auth0?: Auth0SignIn;
  // Sensitive operations confirmed by a fresh sign-in (Decision 0009,
  // point 8).
  accountSecurity?: { operations: AccountOperations };
  sharedAuthLimiter?: RequestHandler;
  sharedAccountLimiter?: RequestHandler;
  // Backs the general, auth and account-security API limiters with the shared
  // Redis abuse store.
  sharedRateLimits?: SharedRateLimits;
  accountWallet?: ReturnType<typeof createAccountWallet>;
  coinSandbox?: Pick<
    Parameters<typeof createCoinSandboxRouter>[0],
    "sandbox" | "debates" | "operations" | "reports"
  >;
  coinWebhook?: RequestHandler;
  // Decision 0012: public turn-window timing, mounted only when enabled.
  turnWindows?: Parameters<typeof createTurnWindowRouter>[0];
}) {
  const app = express();
  const mediaUrl = mediaProvider ? new URL(mediaProvider.publicUrl) : undefined;
  const mediaHttpOrigin = mediaUrl
    ? `${mediaUrl.protocol === "wss:" ? "https:" : "http:"}//${mediaUrl.host}`
    : undefined;

  app.disable("x-powered-by");
  if (measurement)
    metrics.setProductSummaryProvider(() => measurement.summary());
  app.set("trust proxy", trustProxy);
  app.use(createHttpLogger(logger));
  app.use(metrics.middleware);
  app.use(
    mediaProvider
      ? helmet({
          contentSecurityPolicy: {
            directives: {
              "connect-src": [
                "'self'",
                mediaUrl!.origin,
                mediaHttpOrigin!,
                ...(mediaProvider.playbackOrigins ?? [
                  mediaProvider.playbackOrigin,
                ]),
              ],
              "worker-src": ["'self'", "blob:"],
              "media-src": [
                "'self'",
                "blob:",
                ...(mediaProvider.playbackOrigins ?? [
                  mediaProvider.playbackOrigin,
                ]),
              ],
              "upgrade-insecure-requests":
                environment === "production" ? [] : null,
            },
          },
        })
      : helmet(),
  );
  if (auth0)
    app.use(
      createEmailAuthSecurity(
        environment,
        mediaProvider
          ? {
              connect: [
                mediaUrl!.origin,
                mediaHttpOrigin!,
                ...(mediaProvider.playbackOrigins ?? [
                  mediaProvider.playbackOrigin,
                ]),
              ],
              playback: [
                ...(mediaProvider.playbackOrigins ?? [
                  mediaProvider.playbackOrigin,
                ]),
              ],
            }
          : undefined,
      ),
    );
  const liveRead = (request: Request) =>
    request.method === "GET" &&
    /^\/api\/community\/events\/[0-9a-f-]{36}(?:\/my-like|\/chat\/sync|\/updates)?$/i.test(
      request.path,
    );
  const streamRead = (request: Request) =>
    request.method === "GET" &&
    /^\/api\/community\/events\/[^/]+\/stream$/.test(request.path);
  app.use(
    createViewerAdmission({
      secret: mediaAdmissionSecret,
      secure: environment === "production",
      refused: (reason) =>
        metrics.mediaControl.inc({ kind: `admission_${reason}` }),
    }),
  );
  app.use(
    createApiRateLimiter({
      windowMs: 60_000,
      limit: 600,
      skip: (request) =>
        !liveRead(request) ||
        streamRead(request) ||
        Boolean(mediaDeliveryLane(request)),
      shared: sharedRateLimits?.("api-live", "open"),
    }),
  );
  app.use(
    createApiRateLimiter({
      windowMs: rateLimitWindowMs,
      limit: apiRateLimit,
      skip: (request) =>
        liveRead(request) ||
        streamRead(request) ||
        Boolean(mediaDeliveryLane(request)),
      shared: sharedRateLimits?.("api", "open"),
    }),
  );
  if (media && mediaProvider) {
    app.use(
      "/api/media/webhook",
      express.raw({ type: "application/webhook+json", limit: "256kb" }),
      createMediaWebhookRouter({
        media,
        provider: mediaProvider,
        accountRevocation: mediaAccountRevocation,
      }),
    );
  }
  if (coinWebhook) app.use("/api/coin-sandbox/webhook", coinWebhook);
  app.use(express.json({ limit: requestBodyLimit }));
  app.use(cookieParser());
  app.use(createCsrfOriginProtection({ environment, applicationOrigin }));
  if (sharedAuthLimiter)
    app.use("/api/auth", (request, response, next) => {
      // An abuse-store outage must never prevent logout or session inspection.
      if (request.method !== "POST" || request.path === "/logout")
        return next();
      return sharedAuthLimiter(request, response, next);
    });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/ready", async (_request, response) => {
    try {
      if (!database) throw new Error("database is not configured");
      await pingDatabase(database);
      return response.json({ status: "ready" });
    } catch (error) {
      _request.log.error({ error }, "readiness check failed");

      return response.status(503).json({ status: "not ready" });
    }
  });

  app.get(
    "/metrics",
    createMetricsAuthorization({ token: metricsToken, environment }),
    metrics.handler,
  );

  const recordProductAction = measurement
    ? createProductActionRecorder({ measurement, environment })
    : undefined;

  if (discovery) {
    app.get("/sw.js", (_request, response) => {
      response
        .set("Cache-Control", "no-cache")
        .sendFile(fileURLToPath(new URL("../public/sw.js", import.meta.url)));
    });
    const assetRoot = fileURLToPath(new URL("../public", import.meta.url));
    const assets = express.static(assetRoot, { maxAge: 0 });
    // Only the current revision is immutable: a stale ?v= from another
    // deploy must not pin this build's content under an old URL.
    const versionedAssets = express.static(assetRoot, {
      maxAge: "1y",
      immutable: true,
    });
    // Shared ESM chunks are imported without ?v=; their names carry an esbuild
    // content hash, so a changed chunk always gets a new URL.
    const hashedChunk = /^\/chunks\/[\w-]+-[A-Z2-7]{8}\.js$/;
    app.use("/assets", (request, response, next) =>
      (request.query.v === assetRevision && request.path !== "/offline.html") ||
      hashedChunk.test(request.path)
        ? versionedAssets(request, response, next)
        : assets(request, response, next),
    );
    app.use(
      createDiscoveryRouter({
        discovery,
        publicBots,
        homepageReferenceEnabled:
          homepageReferenceEnabled && environment !== "production",
        a4Enabled: a4?.mode !== undefined && a4.mode !== "disabled",
        mediaEnabled: Boolean(media && mediaProvider && matching && identity),
        applicationOrigin: applicationOrigin ?? "http://localhost:3000",
        emailFirst: true,
      }),
    );
  }

  app.use(
    "/api/auth",
    createAuthRouter({
      sessions,
      environment,
      applicationOrigin,
      sessionDurationMs,
      authRateLimit,
      rateLimitWindowMs,
      auth0,
      operations: accountSecurity?.operations,
      sharedRateLimits,
      recordAuth: (event, seconds, phase = "journey") => {
        metrics.authJourney.inc({ event });
        if (seconds !== undefined)
          metrics.authLatency.observe({ phase }, seconds);
      },
    }),
  );
  if (coinSandbox)
    app.use(
      "/api/coin-sandbox",
      createRequireAuthentication({ sessions, environment }),
      createCoinSandboxRouter({
        ...coinSandbox,
        environment,
        applicationOrigin: applicationOrigin ?? "http://localhost:3000",
        sharedWriteLimiter: sharedAccountLimiter,
        sharedRateLimits,
      }),
    );
  if (turnWindows) app.use(createTurnWindowRouter(turnWindows));
  if (a4)
    app.use(
      "/api/a4",
      createRequireAuthentication({ sessions, environment }),
      createA4Router(a4, environment, sharedRateLimits),
    );
  if (accountWallet)
    app.get(
      "/api/account-wallet",
      createRequireAuthentication({ sessions, environment }),
      async (request, response) => {
        response
          .set("Cache-Control", "private, no-store")
          .set("Vary", "Cookie");
        return response.json({
          enabled: Boolean(auth0),
          withdrawalsEnabled: false,
          ...(await accountWallet.balances(request.user!.id)),
        });
      },
    );
  app.use(
    "/api/messages",
    createRequireAuthentication({ sessions, environment }),
    createMessageRouter({ messages }),
  );
  if (identity) {
    app.use(
      "/api/me",
      createRequireAuthentication({ sessions, environment }),
      createIdentityRouter({
        identity,
        recordProductAction,
        exportSources: auth0
          ? { signInMethods: (userId) => auth0.accounts.methods(userId) }
          : {},
      }),
    );
  }
  if (matching && identity) {
    app.use(
      "/api/matching",
      createRequireAuthentication({ sessions, environment }),
      createMatchingRouter({
        matching,
        identity,
        media,
        recordProductAction,
        debateAutoStart,
      }),
    );
  }
  if (matchmaking && identity) {
    app.use(
      "/api/matchmaking",
      createRequireAuthentication({ sessions, environment }),
      createMatchmakingRouter({ matchmaking, identity, recordProductAction }),
    );
  }
  if (media && mediaProvider && matching && identity) {
    app.use(
      "/api/media",
      createMediaRouter({
        media,
        provider: mediaProvider,
        accountRevocation: mediaAccountRevocation,
        environment,
        recordPlayback: createMediaTelemetry(metrics.registry),
        matching,
        identity,
        requireAuth: createRequireAuthentication({ sessions, environment }),
      }),
    );
  }
  if (community && identity) {
    app.use(
      createCommunityRouter({
        community,
        identity,
        requireAuth: createRequireAuthentication({ sessions, environment }),
        applicationOrigin: applicationOrigin ?? "http://localhost:3000",
        recordProductAction,
        streams: communityStreams,
        emailFirst: true,
      }),
    );
  }
  if (measurement && identity) {
    app.use(
      createMeasurementRouter({
        measurement,
        sessions,
        identity,
        requireAuth: createRequireAuthentication({ sessions, environment }),
        environment,
        emailFirst: true,
      }),
    );
  }

  app.use((_request, response) => {
    response.status(404).json({
      error: "resource not found",
    });
  });

  app.use(handleError);

  return app;
}
