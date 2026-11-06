import * as oidc from "openid-client";
import type { Auth0Config } from "./auth0-config.ts";

// Decision 0009, point 1: authorization code flow with PKCE (S256), state and
// nonce, as a confidential client. Only sign-in, linking and confirmation call
// Auth0; ordinary requests never do.
export type SignInMethod = "email" | "google";
export const auth0Connections: Readonly<Record<SignInMethod, string>> =
  Object.freeze({ email: "email", google: "google-oauth2" });

export type VerifiedIdentity = Readonly<{
  subject: string;
  email: string;
  method: SignInMethod;
  // Seconds since the epoch, from the ID token's auth_time claim when present.
  authTime: number | null;
}>;

export type LoginSecrets = Readonly<{
  state: string;
  nonce: string;
  codeVerifier: string;
}>;

export type AuthorizationRequest = LoginSecrets &
  Readonly<{
    connection?: SignInMethod;
    loginHint?: string;
    // New-user buttons open Universal Login on Sign up instead of Log in.
    screenHint?: "signup";
    // Linking and confirmation ask for credentials again.
    prompt?: "login";
    // Confirmation also requires a new authentication (max_age=0).
    maxAge?: 0;
  }>;

export type Auth0Client = Readonly<{
  authorizationUrl(request: AuthorizationRequest): Promise<URL>;
  verifyCallback(
    query: URLSearchParams,
    checks: LoginSecrets & { maxAge?: 0 },
  ): Promise<VerifiedIdentity>;
  logoutUrl(returnTo: string): URL;
}>;

// Auth0 did not answer, or answered with a server error. Retry later.
export class Auth0UnavailableError extends Error {}
export type Auth0SignInFailure =
  "cancelled" | "invalid" | "email_unverified" | "unsupported_method";
export class Auth0SignInError extends Error {
  constructor(readonly code: Auth0SignInFailure) {
    super(`sign-in failed: ${code}`);
  }
}

export function createLoginSecrets(): LoginSecrets {
  return Object.freeze({
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier: oidc.randomPKCECodeVerifier(),
  });
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+$/u.test(email)
    ? email
    : null;
}

export function signInMethod(subject: string): SignInMethod | null {
  if (subject.length > 256) return null;
  if (/^email\|[^\s|]+$/.test(subject)) return "email";
  if (/^google-oauth2\|[^\s|]+$/.test(subject)) return "google";
  return null;
}

function unavailable(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")) ||
    (error instanceof oidc.ResponseBodyError && error.status >= 500) ||
    (error instanceof oidc.ClientError &&
      error.code === "OAUTH_RESPONSE_IS_NOT_CONFORM")
  );
}

const discoveryRetryMs = 15_000;

export function createAuth0Client(
  config: Auth0Config,
  {
    redirectUri,
    fetch,
    now = Date.now,
  }: {
    // The exact callback URL registered with Auth0.
    redirectUri: string;
    fetch?: oidc.CustomFetch;
    now?: () => number;
  },
): Auth0Client {
  const callback = new URL(redirectUri);
  let discovered: Promise<oidc.Configuration> | undefined;
  let retryAt = 0;

  function configuration() {
    if (discovered) return discovered;
    if (now() < retryAt)
      return Promise.reject(
        new Auth0UnavailableError("sign-in provider unavailable"),
      );
    discovered = oidc
      .discovery(
        config.issuer,
        config.clientId,
        undefined,
        oidc.ClientSecretPost(config.clientSecret),
        {
          ...(fetch ? { [oidc.customFetch]: fetch } : {}),
          // The settings loader admits HTTP only for a loopback issuer
          // outside production, which the tests' local issuer uses.
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(config.issuer.protocol === "http:"
              ? [oidc.allowInsecureRequests]
              : []),
          ],
          timeout: 10,
        },
      )
      .then((value) => {
        value.timeout = 10;
        return value;
      })
      .catch((error: unknown) => {
        discovered = undefined;
        retryAt = now() + discoveryRetryMs;
        throw new Auth0UnavailableError("sign-in provider unavailable", {
          cause: error,
        });
      });
    return discovered;
  }

  return Object.freeze({
    async authorizationUrl(request: AuthorizationRequest) {
      const server = await configuration();
      const parameters: Record<string, string> = {
        redirect_uri: callback.href,
        response_type: "code",
        scope: "openid email",
        state: request.state,
        nonce: request.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(
          request.codeVerifier,
        ),
        code_challenge_method: "S256",
      };
      if (request.connection)
        parameters.connection = auth0Connections[request.connection];
      if (request.loginHint) parameters.login_hint = request.loginHint;
      if (request.screenHint) parameters.screen_hint = request.screenHint;
      if (request.prompt) parameters.prompt = request.prompt;
      if (request.maxAge !== undefined)
        parameters.max_age = String(request.maxAge);
      return oidc.buildAuthorizationUrl(server, parameters);
    },

    async verifyCallback(query, checks) {
      const server = await configuration();
      const current = new URL(callback.href);
      for (const [key, value] of query) current.searchParams.append(key, value);
      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(server, current, {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
          // A confirmation sent max_age=0, so auth_time is required.
          ...(checks.maxAge !== undefined ? { maxAge: checks.maxAge } : {}),
        });
        claims = tokens.claims();
      } catch (error) {
        if (unavailable(error))
          throw new Auth0UnavailableError("sign-in provider unavailable", {
            cause: error,
          });
        if (error instanceof oidc.AuthorizationResponseError)
          throw new Auth0SignInError(
            error.error === "access_denied" ? "cancelled" : "invalid",
          );
        throw new Auth0SignInError("invalid");
      }
      if (!claims) throw new Auth0SignInError("invalid");
      const method = signInMethod(claims.sub);
      if (!method) throw new Auth0SignInError("unsupported_method");
      const email = normalizeEmail(claims.email);
      if (!email || claims.email_verified !== true)
        throw new Auth0SignInError("email_unverified");
      const authTime =
        typeof claims.auth_time === "number" &&
        Number.isSafeInteger(claims.auth_time)
          ? claims.auth_time
          : null;
      if (checks.maxAge !== undefined && authTime === null)
        throw new Auth0SignInError("invalid");
      return Object.freeze({ subject: claims.sub, email, method, authTime });
    },

    logoutUrl(returnTo: string) {
      const url = new URL("v2/logout", config.issuer);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("returnTo", returnTo);
      return url;
    },
  });
}
