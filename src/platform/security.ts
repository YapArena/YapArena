import { rateLimit } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import {
  RateLimitStoreUnavailableError,
  type SharedRateLimit,
} from "./shared-abuse.ts";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApiRateLimiter({
  windowMs,
  limit,
  skip,
  keyGenerator,
  uncountedWhen,
  shared,
}: {
  windowMs: number;
  limit: number;
  skip?: (request: Request) => boolean;
  keyGenerator?: (request: Request) => string;
  // A request for which this returns true when its response finishes is taken
  // back off the count, so only the others use up the limit.
  uncountedWhen?: (request: Request, response: Response) => boolean;
  // Without a shared store the limiter keeps its in-memory, per-process count.
  shared?: SharedRateLimit;
}) {
  const limiter = rateLimit({
    windowMs,
    limit,
    skip,
    keyGenerator,
    ...(uncountedWhen
      ? {
          skipSuccessfulRequests: true,
          requestWasSuccessful: uncountedWhen,
        }
      : {}),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...shared,
  });
  if (!shared || shared.passOnStoreError) return limiter;
  // Fail closed with the same retryable response as the shared sign-in limiter.
  return (request: Request, response: Response, next: NextFunction) =>
    limiter(request, response, (error?: unknown) => {
      if (!(error instanceof RateLimitStoreUnavailableError))
        return next(error);
      return response.set("Retry-After", "5").status(503).json({
        error:
          "sign-in protection is temporarily unavailable; try again shortly",
      });
    });
}

export function createCsrfOriginProtection({
  environment,
  applicationOrigin,
}: {
  environment: string;
  applicationOrigin?: string;
}) {
  return function csrfOriginProtection(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    if (environment !== "production" || safeMethods.has(request.method)) {
      return next();
    }

    if (!request.headers.cookie) {
      return next();
    }

    if (request.get("origin") !== applicationOrigin) {
      return response
        .status(403)
        .json({ error: "request origin is not allowed" });
    }

    return next();
  };
}
