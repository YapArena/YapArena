import { Router, type Request, type RequestHandler } from "express";
import type { createCoinSandboxRepository } from "./sandbox-repository.ts";
import type { createCoinDebateSandbox } from "./debate-sandbox.ts";
import type { createSandboxErrorReports } from "./sandbox-reports.ts";
import { CoinOperationError } from "./external-operations.ts";
import {
  AccountOperationError,
  parseConfirmation,
  type AccountOperations,
} from "../../platform/auth/account-operations.ts";
import { hashSessionToken } from "../../platform/auth/session-tokens.ts";
import { createApiRateLimiter } from "../../platform/security.ts";
import type { SharedRateLimits } from "../../platform/shared-abuse.ts";
import { SessionUnavailableError } from "../../platform/auth/sessions.ts";
import { A4Error, purchaseLimit } from "../a4/engine.ts";

function body(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    throw new CoinOperationError("invalid request fields", 400);
  return value as Record<string, unknown>;
}
function text(value: unknown) {
  if (typeof value !== "string")
    throw new CoinOperationError("text value required", 400);
  return value;
}
function id(value: unknown) {
  const valueText = text(value);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      valueText,
    )
  )
    throw new CoinOperationError("request unavailable", 404);
  return valueText;
}
export function createCoinSandboxRouter(options: {
  sandbox: ReturnType<typeof createCoinSandboxRepository>;
  debates: ReturnType<typeof createCoinDebateSandbox>;
  operations: Pick<AccountOperations, "create" | "prepare">;
  reports?: ReturnType<typeof createSandboxErrorReports>;
  environment: string;
  applicationOrigin: string;
  sharedWriteLimiter?: RequestHandler;
  sharedRateLimits?: SharedRateLimits;
}) {
  const router = Router(),
    { sandbox, debates, operations } = options;
  const context = (r: Request) => ({
    userId: r.user!.id,
    sessionTokenHash: hashSessionToken(
      r.cookies[
        options.environment === "production" ? "__Host-session" : "session"
      ],
    ),
    ...(!["GET", "HEAD"].includes(r.method)
      ? { expectedSessionId: r.get("X-YapArena-Session")! }
      : {}),
  });
  const key = (r: Request) => {
    const k = r.get("Idempotency-Key");
    if (!k || k.length > 200)
      throw new CoinOperationError("Idempotency-Key required", 400);
    return k;
  };
  router.use((r, s, next) => {
    s.set("Cache-Control", "private, no-store").set("Vary", "Cookie");
    if (
      !["GET", "HEAD"].includes(r.method) &&
      r.get("origin") !== options.applicationOrigin
    )
      return s.status(403).json({ error: "request origin does not match" });
    if (
      !["GET", "HEAD"].includes(r.method) &&
      !/^[1-9][0-9]{0,18}$/.test(r.get("X-YapArena-Session") ?? "")
    )
      return s.status(409).json({
        error: "account context changed; refresh balances and review again",
      });
    next();
  });
  router.use(
    createApiRateLimiter({
      windowMs: 60_000,
      limit: 120,
      keyGenerator: (r) => r.user!.id,
      shared: options.sharedRateLimits?.("coin-sandbox", "open"),
    }),
  );
  router.use((r, s, next) => {
    if (!["GET", "HEAD"].includes(r.method) && options.sharedWriteLimiter)
      return options.sharedWriteLimiter(r, s, next);
    next();
  });
  router.get("/summary", async (r, s) =>
    s.json(await sandbox.summary(context(r))),
  );
  // Decision 0013: Yap Coins are always on. There is no opening
  // confirmation; the first request opens the sandbox and this claims the
  // welcome grant once. Withdrawals and recovery consents still confirm.
  router.post("/initialize", async (r, s) => {
    body(r.body, []);
    s.json(await sandbox.initialize(context(r)));
  });
  router.post("/grants/daily", async (r, s) => {
    body(r.body, []);
    s.json(await sandbox.claimGrant(context(r), "daily"));
  });
  router.post("/funding/quotes", async (r, s) => {
    const b = body(r.body, ["amount"]);
    s.status(201).json(
      await sandbox.quoteFunding(context(r), {
        amount: text(b.amount),
        idempotencyKey: key(r),
      }),
    );
  });
  router.post("/funding/:id/confirm", async (r, s) => {
    body(r.body, []);
    s.json(
      await sandbox.confirmSimulatedFunding(context(r), {
        requestId: id(r.params.id),
      }),
    );
  });
  router.post("/withdrawals/quotes", async (r, s) => {
    const b = body(r.body, ["gross", "destination"]);
    s.status(201).json(
      await sandbox.quoteWithdrawal(context(r), {
        gross: text(b.gross),
        destination: text(b.destination),
        idempotencyKey: key(r),
      }),
    );
  });
  router.post("/withdrawals/:id/operations", async (r, s) => {
    body(r.body, []);
    const actor = context(r);
    const request = await sandbox.getRequest(actor, id(r.params.id));
    if (request.kind !== "withdrawal")
      throw new CoinOperationError("withdrawal request required", 400);
    const operation = await operations.create({
      userId: actor.userId,
      sessionTokenHash: actor.sessionTokenHash,
      purpose: "withdrawal.request",
      terms: request.terms,
    });
    s.status(201).json({ ...operation, terms: request.terms });
  });
  router.post("/withdrawals/:id", async (r, s) => {
    const b = body(r.body, ["approval"]),
      actor = context(r),
      confirmation = parseConfirmation(b.approval);
    const request = await sandbox.getRequest(actor, id(r.params.id));
    if (request.kind !== "withdrawal")
      throw new CoinOperationError("withdrawal request required", 400);
    const approval = await operations.prepare({
      ...actor,
      id: confirmation.id,
      purpose: "withdrawal.request",
      terms: request.terms,
      requestId: String(r.id),
    });
    s.json(
      await sandbox.requestWithdrawal(actor, {
        requestId: request.id,
        approval,
      }),
    );
  });
  router.get("/debates/:id/rounds", async (r, s) =>
    s.json(await debates.view(context(r), id(r.params.id))),
  );
  router.post("/debates/:id/rounds", async (r, s) => {
    body(r.body, []);
    s.status(201).json(
      await debates.create(context(r), id(r.params.id), key(r)),
    );
  });
  router.post("/rounds/:id/submit", async (r, s) => {
    const b = body(r.body, [
      "side",
      "ceiling",
      "quantity",
      "replayPositionSeconds",
    ]);
    if ((b.side !== "YES" && b.side !== "NO") || typeof b.quantity !== "number")
      throw new CoinOperationError("side and integer quantity required", 400);
    // Decision 0012 (F10): a replay viewer's position in the recording.
    const position = b.replayPositionSeconds;
    if (
      position !== undefined &&
      (typeof position !== "number" ||
        !Number.isFinite(position) ||
        position < 0 ||
        position > 86_400)
    )
      throw new CoinOperationError("invalid replay position", 400);
    const limit = purchaseLimit(b.side, text(b.ceiling)),
      micro = (BigInt(limit.n) * 1_000_000n) / BigInt(limit.d);
    s.status(201).json(
      await debates.submit(context(r), id(r.params.id), key(r), {
        side: b.side,
        quantity: b.quantity,
        limit: `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, "0")}`,
        ...(position === undefined
          ? {}
          : { replayPositionMs: Math.floor(position * 1000) }),
      }),
    );
  });
  router.post("/settlements", async (r, s) => {
    body(r.body, []);
    s.json(await debates.advance(20, context(r)));
  });
  if (options.reports) {
    const reports = options.reports;
    router.get("/reports", async (r, s) =>
      s.json(await reports.list(context(r))),
    );
    router.post("/reports", async (r, s) => {
      const b = body(r.body, ["requestId", "description"]);
      s.status(201).json(
        await reports.submit(context(r), {
          requestId: id(b.requestId),
          message: text(b.description),
          idempotencyKey: key(r),
        }),
      );
    });
    router.get("/reports/:id", async (r, s) =>
      s.json(await reports.get(context(r), id(r.params.id))),
    );
    router.get("/reports/:id/recovery-quotes/:quoteId", async (r, s) =>
      s.json(
        await reports.getConsentTerms(context(r), {
          reportId: id(r.params.id),
          quoteId: id(r.params.quoteId),
        }),
      ),
    );
    router.post(
      "/reports/:id/recovery-consents/authorization",
      async (r, s) => {
        const b = body(r.body, ["quoteId"]),
          actor = context(r),
          quoted = await reports.getConsentTerms(actor, {
            reportId: id(r.params.id),
            quoteId: id(b.quoteId),
          }),
          operation = await operations.create({
            userId: actor.userId,
            sessionTokenHash: actor.sessionTokenHash,
            purpose: "recovery.cost.consent",
            terms: quoted.terms,
          });
        s.status(201).json({ ...operation, terms: quoted.terms });
      },
    );
    router.post("/reports/:id/recovery-consents", async (r, s) => {
      const b = body(r.body, ["quoteId", "approval"]),
        actor = context(r),
        reportId = id(r.params.id),
        quoteId = id(b.quoteId),
        confirmation = parseConfirmation(b.approval),
        quoted = await reports.getConsentTerms(actor, { reportId, quoteId }),
        approval = await operations.prepare({
          ...actor,
          id: confirmation.id,
          purpose: "recovery.cost.consent",
          terms: quoted.terms,
          requestId: String(r.id),
        });
      s.json(
        await reports.consent(actor, {
          reportId,
          quoteId,
          approval,
          idempotencyKey: key(r),
        }),
      );
    });
  }
  router.use(
    (
      error: unknown,
      _r: Request,
      s: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      if (
        error instanceof CoinOperationError ||
        error instanceof AccountOperationError ||
        error instanceof A4Error
      )
        return s.status(error.status).json({ error: error.message });
      if (error instanceof SessionUnavailableError)
        return s.status(401).json({ error: "sign in again" });
      return next(error);
    },
  );
  return router;
}
