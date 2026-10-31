import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { PublicUser } from "./users.ts";
import { SessionUnavailableError } from "./sessions.ts";
import type { createSessionRepository } from "./sessions.ts";
import { createSessionToken, hashSessionToken } from "./session-tokens.ts";
import { createApiRateLimiter } from "../security.ts";
import type { SharedRateLimits } from "../shared-abuse.ts";
import {
  Auth0SignInError,
  Auth0UnavailableError,
  createLoginSecrets,
  type Auth0Client,
  type Auth0SignInFailure,
} from "./auth0.ts";
import { SignInError, type Auth0Accounts } from "./auth0-accounts.ts";
import {
  ConfirmationError,
  type AccountOperations,
  type ConfirmationFailure,
} from "./account-operations.ts";
import {
  createBindingValue,
  getBindingCookieSettings,
  safeReturnPath,
  validBindingValue,
  type createSignInState,
} from "./sign-in-state.ts";
import { renderSignInContinue, renderSignInProblem } from "./sign-in-pages.ts";

export type Auth0SignIn = {
  client: Auth0Client;
  accounts: Auth0Accounts;
  state: ReturnType<typeof createSignInState>;
};

const providerFailures: Readonly<
  Record<Auth0SignInFailure, { title: string; message: string }>
> = {
  cancelled: {
    title: "Sign-in cancelled",
    message: "Sign-in was cancelled. Nothing changed.",
  },
  invalid: {
    title: "Sign-in didn't finish",
    message: "We couldn't verify this sign-in. Start again.",
  },
  email_unverified: {
    title: "Email not verified",
    message:
      "Your email address isn't verified, so we can't sign you in. Contact YapArena support for help.",
  },
  unsupported_method: {
    title: "Use Google or an email code",
    message: "YAP Arena accepts Google and email-code sign-in only.",
  },
};

const confirmationFailures: Readonly<Record<ConfirmationFailure, string>> = {
  expired:
    "This confirmation expired or was already used, so nothing changed. Start the action again.",
  other_account:
    "You signed in with a different account, so nothing changed. Sign in as the account that started this action.",
  stale_sign_in:
    "The confirmation needs a new sign-in, so nothing changed. Start the action again.",
};

const operationId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
  }
}

export function getCookieSettings(environment: string) {
  const isProduction = environment === "production";

  return {
    name: isProduction ? "__Host-session" : "session",
    options: Object.freeze({
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict" as const,
      path: "/",
    }),
  };
}

export function createRequireAuthentication({
  sessions,
  environment,
}: {
  sessions: ReturnType<typeof createSessionRepository>;
  environment: string;
}) {
  const cookie = getCookieSettings(environment);

  return async function requireAuthentication(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    // Authentication failures must be private too: downstream feature routers
    // cannot install their cache policy before this middleware rejects access.
    response.set("Cache-Control", "private, no-store");
    response.vary("Cookie");
    const token = request.cookies[cookie.name];

    if (!token) {
      return response.status(401).json({ error: "authentication required" });
    }

    const user = await sessions.findUserByTokenHash(hashSessionToken(token));

    if (!user) {
      return response.status(401).json({ error: "authentication required" });
    }

    request.user = user;
    return next();
  };
}

// For public pages that differ for a signed-in reader, such as the landing
// page at /. A missing, revoked or expired session is simply not signed in.
export function createSessionCheck({
  sessions,
  environment,
}: {
  sessions: ReturnType<typeof createSessionRepository>;
  environment: string;
}) {
  const cookie = getCookieSettings(environment);
  return async function signedIn(request: Request) {
    const token: unknown = request.cookies[cookie.name];
    if (typeof token !== "string") return false;
    return (
      (await sessions.findUserByTokenHash(hashSessionToken(token))) !== null
    );
  };
}

export function createAuthRouter({
  sessions,
  environment,
  applicationOrigin = "http://localhost:3000",
  now = Date.now,
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
  authRateLimit = 10,
  rateLimitWindowMs = 15 * 60 * 1_000,
  auth0,
  operations,
  recordAuth = () => {},
  sharedRateLimits,
}: {
  sessions: ReturnType<typeof createSessionRepository>;
  environment: string;
  applicationOrigin?: string;
  now?: () => number;
  sessionDurationMs?: number;
  authRateLimit?: number;
  rateLimitWindowMs?: number;
  auth0?: Auth0SignIn;
  // Confirmations of sensitive operations by a fresh sign-in.
  operations?: Pick<AccountOperations, "pending" | "confirm">;
  recordAuth?: (event: string, seconds?: number, phase?: "journey") => void;
  sharedRateLimits?: SharedRateLimits;
}) {
  const router = express.Router();
  const cookie = getCookieSettings(environment);
  const bindingCookie = getBindingCookieSettings(environment);
  const requireAuthentication = createRequireAuthentication({
    sessions,
    environment,
  });
  const authLimiter = createApiRateLimiter({
    windowMs: rateLimitWindowMs,
    limit: authRateLimit,
    shared: sharedRateLimits?.("auth", "closed"),
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  function problem(
    response: Response,
    status: number,
    input: { title: string; message: string; back: string; retry?: string },
  ) {
    return response
      .status(status)
      .type("html")
      .send(renderSignInProblem(input));
  }
  const signInLink = (returnPath: string) =>
    `/api/auth/login?return=${encodeURIComponent(returnPath)}`;
  const unavailablePage = (back: string) => ({
    title: "Sign-in unavailable",
    message:
      "Sign-in is temporarily unavailable. You can keep browsing and try again shortly.",
    back,
    retry: signInLink(back),
  });
  // The page that started a confirmation learns which one finished.
  const withConfirmation = (returnPath: string, id: string) => {
    const target = new URL(returnPath, applicationOrigin);
    target.searchParams.set("confirmed", id);
    return target.pathname + target.search + target.hash;
  };

  // One random value per browser binds every pending sign-in to it. Reusing a
  // live value lets two tabs sign in at once.
  function browserBinding(request: Request, response: Response) {
    const current: unknown = request.cookies[bindingCookie.name];
    const binding = validBindingValue(current) ? current : createBindingValue();
    response.cookie(bindingCookie.name, binding, bindingCookie.options);
    return binding;
  }

  async function currentUser(request: Request) {
    const token: unknown = request.cookies[cookie.name];
    if (typeof token !== "string") return null;
    const tokenHash = hashSessionToken(token);
    const user = await sessions.findUserByTokenHash(tokenHash);
    return user ? { user, tokenHash } : null;
  }

  // Public: which sign-in methods this deployment offers.
  router.get("/provider", (_request, response) =>
    response.json(
      auth0
        ? { enabled: true, methods: ["email", "google"] }
        : { enabled: false, methods: [] },
    ),
  );

  router.get("/login", authLimiter, async (request, response) => {
    const returnPath =
      safeReturnPath(request.query.return, applicationOrigin) ?? "/home";
    if (!auth0) return problem(response, 503, unavailablePage(returnPath));
    const connection = request.query.connection;
    if (
      connection !== undefined &&
      connection !== "email" &&
      connection !== "google"
    )
      return problem(response, 400, {
        title: "Sign-in unavailable",
        message: "Choose Google or an email code to sign in.",
        back: returnPath,
      });
    // Already signed in on this device: there is nothing to do.
    if (await currentUser(request)) return response.redirect(303, returnPath);
    try {
      const secrets = createLoginSecrets();
      const url = await auth0.client.authorizationUrl({
        ...secrets,
        ...(connection ? { connection } : {}),
      });
      await auth0.state.create({
        binding: browserBinding(request, response),
        purpose: "sign_in",
        returnPath,
        secrets,
      });
      recordAuth("login_started");
      return response.redirect(303, url.href);
    } catch (error) {
      if (!(error instanceof Auth0UnavailableError)) throw error;
      recordAuth("provider_error");
      return problem(response, 503, unavailablePage(returnPath));
    }
  });

  // Decision 0009, point 8: confirm a pending operation by signing in again
  // (prompt=login, max_age=0). The operation must belong to this device's
  // session and still await confirmation.
  router.get("/confirm", authLimiter, async (request, response) => {
    const returnPath =
      safeReturnPath(request.query.return, applicationOrigin) ?? "/account";
    if (!auth0 || !operations)
      return problem(response, 503, unavailablePage(returnPath));
    const signedIn = await currentUser(request);
    if (!signedIn)
      return problem(response, 401, {
        title: "Sign in first",
        message:
          "This device is signed out. Sign in, then start the action again.",
        back: returnPath,
        retry: signInLink(returnPath),
      });
    const id = request.query.operation;
    if (
      typeof id !== "string" ||
      !operationId.test(id) ||
      !(await operations.pending({
        id,
        userId: signedIn.user.id,
        sessionTokenHash: signedIn.tokenHash,
      }))
    )
      return problem(response, 410, {
        title: "Confirmation expired",
        message: confirmationFailures.expired,
        back: returnPath,
      });
    try {
      const [method] = await auth0.accounts.methods(signedIn.user.id);
      const secrets = createLoginSecrets();
      const url = await auth0.client.authorizationUrl({
        ...secrets,
        ...(method ? { loginHint: method.email } : {}),
        prompt: "login",
        maxAge: 0,
      });
      await auth0.state.create({
        binding: browserBinding(request, response),
        purpose: "confirm",
        returnPath,
        userId: signedIn.user.id,
        operationId: id,
        secrets,
      });
      recordAuth("confirmation_started");
      return response.redirect(303, url.href);
    } catch (error) {
      if (!(error instanceof Auth0UnavailableError)) throw error;
      recordAuth("provider_error");
      return problem(response, 503, unavailablePage(returnPath));
    }
  });

  router.get("/callback", authLimiter, async (request, response) => {
    if (!auth0) return problem(response, 503, unavailablePage("/"));
    const query = new URLSearchParams(
      request.originalUrl.includes("?")
        ? request.originalUrl.slice(request.originalUrl.indexOf("?") + 1)
        : "",
    );
    const state = query.get("state");
    const binding: unknown = request.cookies[bindingCookie.name];
    const transaction =
      state && state.length <= 512 && validBindingValue(binding)
        ? await auth0.state.consume(state, binding)
        : null;
    if (
      !transaction ||
      (transaction.purpose === "confirm" &&
        !(operations && transaction.operationId && transaction.userId))
    ) {
      recordAuth("signin_expired");
      return problem(response, 400, {
        title: "Sign-in expired",
        message:
          "This sign-in expired or was already used, so nothing changed. Start again.",
        back: "/",
        retry: signInLink("/home"),
      });
    }
    const back = transaction.returnPath;
    try {
      if (
        transaction.purpose === "confirm" &&
        operations &&
        transaction.operationId &&
        transaction.userId
      ) {
        // A confirmation never starts a session: this device already has one.
        const identity = await auth0.client.verifyCallback(query, {
          ...transaction.secrets,
          maxAge: 0,
        });
        await operations.confirm({
          id: transaction.operationId,
          userId: transaction.userId,
          identity,
        });
        recordAuth("confirmation_completed");
        return response
          .type("html")
          .send(
            renderSignInContinue(
              withConfirmation(back, transaction.operationId),
              "Confirmed",
            ),
          );
      }
      const identity = await auth0.client.verifyCallback(query, {
        ...transaction.secrets,
      });
      const { token, tokenHash } = createSessionToken();
      const result = await auth0.accounts.signIn(
        identity,
        transaction.purpose === "link" && transaction.pendingLinkId
          ? { purpose: "link", pendingLinkId: transaction.pendingLinkId }
          : { purpose: "sign_in" },
        { tokenHash, expiresAt: new Date(now() + sessionDurationMs) },
      );
      if (result.kind === "link_required") {
        // Decision 0009, point 4: no account and no session until the same
        // address is proven with an email code.
        const secrets = createLoginSecrets();
        const url = await auth0.client.authorizationUrl({
          ...secrets,
          connection: "email",
          loginHint: result.email,
          prompt: "login",
        });
        await auth0.state.create({
          binding: browserBinding(request, response),
          purpose: "link",
          returnPath: back,
          pendingLinkId: result.pendingLinkId,
          secrets,
        });
        recordAuth("link_required");
        return response.redirect(303, url.href);
      }
      response.cookie(cookie.name, token, {
        ...cookie.options,
        maxAge: sessionDurationMs,
      });
      recordAuth(
        result.created
          ? "signup_completed"
          : result.linked.length
            ? "link_completed"
            : "signin_completed",
      );
      return response.type("html").send(renderSignInContinue(back));
    } catch (error) {
      if (error instanceof Auth0UnavailableError) {
        recordAuth("provider_error");
        return problem(response, 503, unavailablePage(back));
      }
      if (error instanceof Auth0SignInError) {
        recordAuth(`signin_${error.code}`);
        return problem(response, error.code === "cancelled" ? 400 : 401, {
          ...providerFailures[error.code],
          back,
          ...(transaction.purpose === "confirm"
            ? {}
            : { retry: signInLink(back) }),
        });
      }
      if (error instanceof ConfirmationError) {
        recordAuth(`confirmation_${error.code}`);
        return problem(response, 403, {
          title: "Not confirmed",
          message: confirmationFailures[error.code],
          back,
        });
      }
      if (error instanceof SignInError) {
        recordAuth(`signin_${error.code}`);
        return problem(response, error.status, {
          title: "Sign-in didn't finish",
          message: error.message,
          back,
          ...(error.code === "link_failed" || error.code === "signup_paused"
            ? { retry: signInLink(back) }
            : {}),
        });
      }
      throw error;
    }
  });

  router.get("/methods", requireAuthentication, async (request, response) =>
    response.json({
      accountId: request.user!.id,
      methods: auth0 ? await auth0.accounts.methods(request.user!.id) : [],
    }),
  );

  router.get("/me", requireAuthentication, (request, response) => {
    return response.json({ user: request.user });
  });

  // Sign out ends this device only (Decision 0009, point 6): it deletes this
  // session row, then the browser visits the provider's logout endpoint so
  // the next sign-in on this device asks for credentials again.
  router.post("/logout", async (request, response) => {
    if (request.body && Object.keys(request.body).length)
      return response.status(400).json({
        error: "this operation accepts no account or session selectors",
      });
    const redirectTo = auth0?.client
      .logoutUrl(new URL("/", applicationOrigin).href)
      .toString();
    const ended = {
      error: "this session has already ended",
      ...(redirectTo ? { redirectTo } : {}),
    };
    const token = request.cookies[cookie.name];
    if (!token) return response.status(401).json(ended);
    const hash = hashSessionToken(token);
    const user = await sessions.findUserByTokenHash(hash);
    if (!user) return response.status(401).json(ended);
    const expectedAccount = request.get("X-YapArena-Expected-Account");
    if (expectedAccount && expectedAccount !== user.id)
      return response.status(409).json({
        error: "the account changed before sign-out; refresh and try again",
      });
    try {
      if (
        !(await sessions.revokeSession(
          user.id,
          hash,
          undefined,
          String(request.id),
        ))
      )
        return response.status(401).json(ended);
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error;
      return response.status(401).json(ended);
    }

    // Revocation is authoritative in PostgreSQL. Do not delete the shared cookie
    // in a delayed response: another tab may have established a newer session.
    return redirectTo
      ? response.json({ redirectTo })
      : response.status(204).end();
  });

  router.get("/sessions", requireAuthentication, async (request, response) => {
    try {
      return response.json(
        await sessions.list(
          request.user!.id,
          hashSessionToken(request.cookies[cookie.name]),
        ),
      );
    } catch (error) {
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "authentication required" });
      throw error;
    }
  });
  // Session revocation remains available when the provider or shared Redis is
  // down.
  router.delete(
    "/sessions/:id",
    requireAuthentication,
    async (request, response) => {
      const expectedAccount = request.get("X-YapArena-Expected-Account");
      if (expectedAccount && expectedAccount !== request.user!.id)
        return response.status(409).json({
          error: "the account changed before sign-out; refresh and try again",
        });
      if (request.body && Object.keys(request.body).length)
        return response
          .status(400)
          .json({ error: "this operation accepts no account selectors" });
      const id = request.params.id;
      if (
        typeof id !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(id) ||
        BigInt(id) > 9223372036854775807n
      )
        return response.status(400).json({ error: "invalid session" });
      try {
        const removed = await sessions.revokeSession(
          request.user!.id,
          hashSessionToken(request.cookies[cookie.name]),
          id,
          String(request.id),
        );
        if (!removed)
          return response.status(404).json({ error: "session unavailable" });
        return response.json(removed);
      } catch (error) {
        if (error instanceof SessionUnavailableError)
          return response
            .status(401)
            .json({ error: "authentication required" });
        throw error;
      }
    },
  );

  return router;
}
