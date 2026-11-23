import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { CoinOperationError } from "../account-wallet/external-operations.ts";
import type { SandboxContext } from "../account-wallet/sandbox-repository.ts";
import { hashSessionToken } from "../../platform/auth/session-tokens.ts";
import { SessionUnavailableError } from "../../platform/auth/sessions.ts";
import { createApiRateLimiter } from "../../platform/security.ts";
import { createSharedRead } from "../../platform/shared-read.ts";
import type { SharedRateLimits } from "../../platform/shared-abuse.ts";
import type { MicRepository, PublicMicList } from "./repository.ts";
import { MicError, YC, type Side } from "./rules.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A whole number of Yap Coins, as the API takes amounts (Decision 0018).
const wholeCoins = /^[1-9][0-9]{0,8}$/;

function fields(value: unknown, allowed: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new MicError("invalid request fields", 400);
  return value as Record<string, unknown>;
}
function requestId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new MicError("requestId required", 400);
  return value;
}
function amount(value: unknown) {
  if (typeof value !== "number" || !wholeCoins.test(String(value)))
    throw new MicError("amounts are whole Yap Coins", 400);
  return BigInt(value) * YC;
}
function text(value: unknown, what: string) {
  if (typeof value !== "string") throw new MicError(`${what} required`, 400);
  return value;
}
function side(value: unknown): Side {
  if (value !== "A" && value !== "B")
    throw new MicError("target must be A or B", 400);
  return value;
}
function id(value: unknown, what: string) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new MicError(`${what} not found`, 404);
  return value;
}

/**
 * Decision 0018, borrow the microphone. Mounted only when MIC_ENABLED.
 *
 * GET /api/debates/:id/mic is the public list. The writes need a signed-in
 * account, this application's origin and the account's current session id
 * (X-YapArena-Session), as Yap Coins writes do: each holds, refunds or spends
 * the account's coins. Amounts are whole Yap Coins; requestId makes a retry
 * return the first result without moving anything twice.
 */
export function createMicRouter(options: {
  mic: Pick<
    MicRepository,
    "read" | "submitQuestion" | "pledge" | "withdraw" | "fire"
  >;
  requireAuth: RequestHandler;
  environment: string;
  applicationOrigin: string;
  sharedRateLimits?: SharedRateLimits;
}) {
  const router = Router(),
    { mic } = options;
  const read = createSharedRead<PublicMicList | null>();
  router.get("/api/debates/:id/mic", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const debateId = request.params.id;
    if (!uuid.test(debateId))
      return response.status(404).json({ error: "debate not found" });
    const list = await read(debateId, () => mic.read(debateId));
    return list
      ? response.json(list)
      : response.status(404).json({ error: "debate not found" });
  });
  const context = (request: Request): SandboxContext => ({
    userId: request.user!.id,
    sessionTokenHash: hashSessionToken(
      request.cookies[
        options.environment === "production" ? "__Host-session" : "session"
      ],
    ),
    expectedSessionId: request.get("X-YapArena-Session")!,
  });
  // Each write: signed in, from this application, with the current session,
  // within the account's own mic budget.
  const signedIn: RequestHandler = (request, response, next) => {
    response.set("Cache-Control", "private, no-store").set("Vary", "Cookie");
    if (request.get("origin") !== options.applicationOrigin)
      return response
        .status(403)
        .json({ error: "request origin does not match" });
    if (!/^[1-9][0-9]{0,18}$/.test(request.get("X-YapArena-Session") ?? ""))
      return response.status(409).json({
        error: "account context changed; refresh balances and review again",
        code: "session_changed",
      });
    next();
  };
  const writes = [
    options.requireAuth,
    signedIn,
    createApiRateLimiter({
      windowMs: 60_000,
      limit: 60,
      keyGenerator: (request) => request.user!.id,
      shared: options.sharedRateLimits?.("mic", "open"),
    }),
  ];
  router.post(
    "/api/debates/:id/mic/questions",
    ...writes,
    async (request, response) => {
      const debateId = id(request.params.id, "debate");
      const body = fields(request.body, [
        "target",
        "text",
        "wager",
        "requestId",
      ]);
      response.status(201).json(
        await mic.submitQuestion(context(request), debateId, {
          target: side(body.target),
          text: text(body.text, "question"),
          wager: amount(body.wager),
          requestId: requestId(body.requestId),
        }),
      );
    },
  );
  router.post(
    "/api/debates/:id/mic/questions/:questionId/pledges",
    ...writes,
    async (request, response) => {
      const debateId = id(request.params.id, "debate"),
        questionId = id(request.params.questionId, "question");
      const body = fields(request.body, ["amount", "add", "requestId"]);
      response.status(201).json(
        await mic.pledge(context(request), debateId, questionId, {
          amount: amount(body.amount),
          add:
            body.add === undefined || body.add === null
              ? null
              : text(body.add, "comment"),
          requestId: requestId(body.requestId),
        }),
      );
    },
  );
  router.delete(
    "/api/debates/:id/mic/pledges/:pledgeId",
    ...writes,
    async (request, response) => {
      const debateId = id(request.params.id, "debate"),
        pledgeId = id(request.params.pledgeId, "pledge");
      response.json(await mic.withdraw(context(request), debateId, pledgeId));
    },
  );
  router.post(
    "/api/debates/:id/mic/questions/:questionId/fire",
    ...writes,
    async (request, response) => {
      const debateId = id(request.params.id, "debate"),
        questionId = id(request.params.questionId, "question");
      const body = fields(request.body, ["requestId"]);
      response
        .status(201)
        .json(
          await mic.fire(
            context(request),
            debateId,
            questionId,
            requestId(body.requestId),
          ),
        );
    },
  );
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (error instanceof MicError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof CoinOperationError)
        return response.status(error.status).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      if (error instanceof SessionUnavailableError)
        return response
          .status(401)
          .json({ error: "sign in again", code: "signed_out" });
      return next(error);
    },
  );
  return router;
}
