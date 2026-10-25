// The one fetch helper for YapArena's own API. Requests stay on this origin,
// send the session cookie, encode JSON bodies, report failures as ApiError and
// accept a caller signal and a timeout together.

export interface ApiErrorBody {
  error?: string;
  code?: string;
  /** The form field the error describes, when there is one. */
  field?: string;
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  declare readonly status: number;
  declare readonly code: string | undefined;
  declare readonly retryAfterSeconds: number | undefined;
  declare readonly field: string | undefined;
  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfterSeconds?: number,
    field?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.field = field;
  }
}

/**
 * The HTTP status of an ApiError, or undefined for any other error. Use this
 * instead of instanceof: classic page scripts bundle their own copy of this
 * module, so the error may come from another copy's class.
 */
export function apiErrorStatus(error: unknown): number | undefined {
  return error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

export interface ApiRequest extends Omit<RequestInit, "credentials"> {
  /** Sent as the request body with a JSON Content-Type. */
  json?: unknown;
  /** Aborts the request after this many milliseconds. */
  timeout?: number;
  /**
   * The account this page last verified. Requests that revoke a session send
   * it so the server can refuse when another tab has switched accounts. It is
   * a comparison hint, never authentication.
   */
  expectedAccount?: string | null;
}

export interface ApiReadOptions extends ApiRequest {
  /** The message for a failure whose body carries no error. */
  errorMessage?: (status: number) => string;
}

export const defaultErrorMessage = (status: number) =>
  `Request failed (${status}).`;

/** Resolves a path against this page and refuses any other origin. */
export function sameOriginUrl(path: string): URL {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin)
    throw new Error("Requests must stay on YapArena.");
  return url;
}

function combinedSignal(
  signal: AbortSignal | null | undefined,
  timeout: number | undefined,
): { signal: AbortSignal | undefined; release(): void } {
  if (timeout === undefined)
    return { signal: signal ?? undefined, release() {} };
  if (!signal) return { signal: AbortSignal.timeout(timeout), release() {} };
  const controller = new AbortController();
  const fromCaller = () => controller.abort(signal.reason);
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("The request timed out.", "TimeoutError"),
      ),
    timeout,
  );
  if (signal.aborted) fromCaller();
  else signal.addEventListener("abort", fromCaller, { once: true });
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      signal.removeEventListener("abort", fromCaller);
    },
  };
}

/** Sends a same-origin API request and returns the raw response. */
export async function apiFetch(
  path: string,
  request: ApiRequest = {},
): Promise<Response> {
  sameOriginUrl(path);
  const {
    json,
    timeout,
    expectedAccount,
    signal: callerSignal,
    ...init
  } = request;
  const headers = new Headers(init.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (expectedAccount)
    headers.set("X-YapArena-Expected-Account", expectedAccount);
  const { signal, release } = combinedSignal(callerSignal, timeout);
  try {
    return await fetch(path, {
      ...init,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } finally {
    release();
  }
}

/** Reads a failed response as an ApiError with the server's message. */
export async function apiError(
  response: Response,
  errorMessage: (status: number) => string = defaultErrorMessage,
): Promise<ApiError> {
  let body: ApiErrorBody = {};
  if (response.headers.get("Content-Type")?.includes("application/json"))
    try {
      body = await response.json();
    } catch {
      // A malformed error body still reports the status.
    }
  const header = response.headers.get("Retry-After");
  return new ApiError(
    body.error || errorMessage(response.status),
    response.status,
    body.code,
    body.retryAfterSeconds ??
      (header && /^\d+$/.test(header) ? Number(header) : undefined),
    typeof body.field === "string" ? body.field : undefined,
  );
}

/**
 * Sends a same-origin API request and returns its JSON body. A 204 response
 * returns undefined; any other failure throws ApiError.
 */
export async function api<T = void>(
  path: string,
  { errorMessage, ...request }: ApiReadOptions = {},
): Promise<T> {
  const response = await apiFetch(path, request);
  if (!response.ok) throw await apiError(response, errorMessage);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
