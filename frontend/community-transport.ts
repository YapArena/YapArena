interface ErrorResponse {
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
}
export class CommunityApiError extends Error {
  declare status: number;
  declare code: string | undefined;
  declare retryAfterSeconds: number | undefined;
  constructor(
    message: string,
    status = 0,
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      signal: controller.signal,
    });
    let data: ErrorResponse;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const header = response.headers.get("Retry-After");
      const seconds =
        data.retryAfterSeconds ??
        (header && /^\d+$/.test(header) ? Number(header) : undefined);
      throw new CommunityApiError(
        response.status === 401
          ? "Sign in to continue."
          : data.error || `Request failed (${response.status}).`,
        response.status,
        data.code,
        seconds,
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof CommunityApiError) throw error;
    throw new CommunityApiError(
      "Connection interrupted or request timed out. Delivery is unconfirmed.",
      0,
      "DELIVERY_UNCONFIRMED",
    );
  } finally {
    clearTimeout(timeout);
  }
}
