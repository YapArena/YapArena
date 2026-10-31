import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { createMeasurementRepository } from "../features/measurement/repository.ts";

type ProductSummary = Awaited<
  ReturnType<ReturnType<typeof createMeasurementRepository>["summary"]>
>;

// With a token, scrapers must send `Authorization: Bearer <token>`. Without one,
// production hides the endpoint and other environments keep it open locally.
export function createMetricsAuthorization({
  token,
  environment,
}: {
  token?: string;
  environment: string;
}) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = token ? digest(`Bearer ${token}`) : undefined;
  return (request: Request, response: Response, next: NextFunction) => {
    if (!expected)
      return environment === "production"
        ? response.status(404).json({ error: "resource not found" })
        : next();
    // Equal-length digests keep the comparison constant time.
    if (!timingSafeEqual(digest(request.get("authorization") ?? ""), expected))
      return response
        .set("WWW-Authenticate", 'Bearer realm="metrics"')
        .status(401)
        .json({ error: "authentication required" });
    return next();
  };
}

export function createMetrics() {
  const registry = new Registry();
  const authJourney = new Counter({
    name: "yaparena_auth_journey_total",
    help: "Aggregate authentication flow outcomes without identifiers",
    labelNames: ["event"],
    registers: [registry],
  });
  const authLatency = new Histogram({
    name: "yaparena_auth_latency_seconds",
    help: "Authentication phase latency without identifiers",
    labelNames: ["phase"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const redisOutcome = new Counter({
    name: "yaparena_redis_security_total",
    help: "Shared abuse store outcomes",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const redisLatency = new Histogram({
    name: "yaparena_redis_security_seconds",
    help: "Shared abuse store latency",
    buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  });
  const mediaControl = new Counter({
    name: "yaparena_media_control_total",
    help: "Bounded media clock, permission repair and delivery admission outcomes",
    labelNames: ["kind"],
    registers: [registry],
  });
  const streamCount = new Gauge({
    name: "yaparena_community_streams",
    help: "Active public streams",
    registers: [registry],
  });
  const roomCount = new Gauge({
    name: "yaparena_community_rooms",
    help: "Active room resources",
    registers: [registry],
  });
  const delivery = new Counter({
    name: "yaparena_community_delivery_total",
    help: "Bounded delivery operations and failures",
    labelNames: ["kind"],
    registers: [registry],
  });
  const deliveryLag = new Histogram({
    name: "yaparena_community_delivery_lag_seconds",
    help: "Event creation to server output queue; browser latency is separate",
    buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60],
    registers: [registry],
  });
  const poolWait = new Histogram({
    name: "yaparena_database_pool_wait_seconds",
    help: "Pool acquisition wait",
    buckets: [0.001, 0.01, 0.1, 1, 5],
    registers: [registry],
  });

  collectDefaultMetrics({
    register: registry,
    prefix: "yaparena_",
  });

  const requests = new Counter({
    name: "yaparena_http_requests_total",
    help: "Total number of completed HTTP requests",
    labelNames: ["method", "route", "status_code"],
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "yaparena_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const productEvents = new Gauge({
    name: "yaparena_product_events_28d",
    help: "Consented product events in the trailing 28 days, plus public debate completions",
    labelNames: ["event_type", "affiliation"],
    registers: [registry],
  });
  const productWatch = new Gauge({
    name: "yaparena_product_watch_seconds_28d",
    help: "Bounded active watch seconds in the trailing 28 days",
    labelNames: ["mode", "affiliation"],
    registers: [registry],
  });
  const productSnapshot = new Gauge({
    name: "yaparena_product_snapshot_fresh",
    help: "One when the product aggregate snapshot was refreshed successfully",
    registers: [registry],
  });
  productSnapshot.set(0);
  // Founder D1: the valueless center and promotional treasuries that back
  // every Yap Coins stake. Two label values; no account or user identifiers.
  const coinTreasury = new Gauge({
    name: "yaparena_coin_treasury_available_usdc",
    help: "Available USDC-equivalent in the Yap Coins center and promotional treasuries",
    labelNames: ["account"],
    registers: [registry],
  });
  const coinTreasuryLow = new Gauge({
    name: "yaparena_coin_treasury_low",
    help: "One while a Yap Coins treasury is below COIN_SANDBOX_TREASURY_ALERT_USDC",
    labelNames: ["account"],
    registers: [registry],
  });
  let coinTreasuryProvider:
    | (() => Promise<
        { account: string; availableUsdc: number; low: boolean }[]
      >)
    | undefined;
  let lastTreasuryRefresh = 0;
  async function refreshTreasury() {
    if (!coinTreasuryProvider || Date.now() - lastTreasuryRefresh < 60_000)
      return;
    try {
      const status = await coinTreasuryProvider();
      for (const entry of status) {
        coinTreasury.set({ account: entry.account }, entry.availableUsdc);
        coinTreasuryLow.set({ account: entry.account }, entry.low ? 1 : 0);
      }
      lastTreasuryRefresh = Date.now();
    } catch {
      // A failed read reports nothing rather than stale balances.
      coinTreasury.reset();
      coinTreasuryLow.reset();
    }
  }
  let productSummaryProvider: (() => Promise<ProductSummary>) | undefined;
  let lastProductRefresh = 0;
  let refreshing: Promise<void> | undefined;

  async function refreshProduct() {
    if (!productSummaryProvider || Date.now() - lastProductRefresh < 60_000)
      return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const summary = await productSummaryProvider();
        productEvents.reset();
        productWatch.reset();
        for (const row of summary.events)
          productEvents.set(
            { event_type: row.eventType, affiliation: row.affiliation },
            row.count,
          );
        for (const row of summary.watch)
          productWatch.set(
            { mode: row.mode, affiliation: row.affiliation },
            row.watchedSeconds,
          );
        productSnapshot.set(1);
        lastProductRefresh = Date.now();
      } catch {
        productSnapshot.set(0);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

  function middleware(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    if (
      request.path === "/metrics" ||
      /^\/api\/community\/events\/[^/]+\/stream$/.test(request.path)
    ) {
      return next();
    }

    const stopTimer = requestDuration.startTimer({ method: request.method });

    response.once("finish", () => {
      const route = request.route?.path
        ? `${request.baseUrl}${request.route.path}`
        : "unmatched";
      const labels = {
        method: request.method,
        route,
        status_code: String(response.statusCode),
      };

      requests.inc(labels);
      stopTimer({ route, status_code: labels.status_code });
    });

    return next();
  }

  async function handler(_request: Request, response: Response) {
    await Promise.all([refreshProduct(), refreshTreasury()]);
    response.type(registry.contentType);
    return response.send(await registry.metrics());
  }

  return Object.freeze({
    middleware,
    handler,
    registry,
    poolWait,
    authJourney,
    authLatency,
    redisOutcome,
    redisLatency,
    mediaControl,
    community: {
      count(kind: string) {
        delivery.inc({ kind });
      },
      streams(value: number) {
        streamCount.set(value);
      },
      rooms(value: number) {
        roomCount.set(value);
      },
      lag(seconds: number) {
        deliveryLag.observe(seconds);
      },
    },
    setProductSummaryProvider(provider: () => Promise<ProductSummary>) {
      productSummaryProvider = provider;
      lastProductRefresh = 0;
    },
    setCoinTreasuryProvider(
      provider: () => Promise<
        { account: string; availableUsdc: number; low: boolean }[]
      >,
    ) {
      coinTreasuryProvider = provider;
      lastTreasuryRefresh = 0;
    },
  });
}
