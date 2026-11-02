export function safeAuthReturn(
  value: string | null,
  origin: string,
): string | null {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const target = new URL(value, origin);
  const path = target.pathname + target.search + target.hash;
  // Parsing removes "." and ".." segments, so "/.//host" becomes "//host",
  // which the browser would treat as another site.
  if (
    target.origin !== origin ||
    target.pathname === "/account" ||
    target.username ||
    target.password ||
    path.startsWith("//")
  )
    return null;
  return path;
}

export type AuthResumeAction =
  | {
      kind: "follow";
      type: "topics" | "people";
      slug: string;
    }
  | {
      kind:
        | "page"
        | "community-chat"
        | "community-like"
        | "community-report"
        | "matching"
        | "a4"
        | "inline-a4";
    };
export type AuthReturnIntent = {
  version: 1;
  next: string;
  expiresAt: number;
  phase: "pending" | "oauth" | "confirmed";
  action: AuthResumeAction;
};
const storageKey = "yaparena-auth-return";
const lifetime = 15 * 60 * 1000;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function resumeAction(value: unknown): AuthResumeAction | null {
  if (!object(value)) return null;
  if (value.kind === "follow") {
    if (
      Object.keys(value).length !== 3 ||
      (value.type !== "topics" && value.type !== "people") ||
      typeof value.slug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{2,79}$/.test(value.slug)
    )
      return null;
    return { kind: "follow", type: value.type, slug: value.slug };
  }
  if (Object.keys(value).length !== 1) return null;
  switch (value.kind) {
    case "page":
    case "community-chat":
    case "community-like":
    case "community-report":
    case "matching":
    case "a4":
    case "inline-a4":
      return { kind: value.kind };
    default:
      return null;
  }
}
export function parseAuthReturnIntent(
  raw: string | null,
  origin: string,
  now = Date.now(),
): AuthReturnIntent | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 1 ||
      typeof value.next !== "string" ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + lifetime ||
      (value.phase !== "pending" &&
        value.phase !== "oauth" &&
        value.phase !== "confirmed")
    )
      return null;
    const next = safeAuthReturn(value.next, origin),
      action = resumeAction(value.action);
    if (!next || !action) return null;
    return {
      version: 1,
      next,
      expiresAt: value.expiresAt,
      phase: value.phase,
      action,
    };
  } catch {
    return null;
  }
}
export function clearAuthReturn(): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Navigation intent is optional and never authentication evidence.
  }
}
export function readAuthReturn(): AuthReturnIntent | null {
  try {
    const raw = sessionStorage.getItem(storageKey),
      intent = parseAuthReturnIntent(raw, location.origin);
    if (raw && !intent) clearAuthReturn();
    return intent;
  } catch {
    return null;
  }
}
function storeAuthReturn(
  value: string | null,
  action: AuthResumeAction,
  phase: AuthReturnIntent["phase"],
): void {
  const next = safeAuthReturn(value, location.origin);
  if (!next) {
    clearAuthReturn();
    return;
  }
  // Only public action locators are stored. Drafts, amounts, destinations,
  // credentials and provider tokens are never copied into navigation storage.
  const raw = JSON.stringify({
    version: 1,
    next,
    expiresAt: Date.now() + lifetime,
    phase,
    action,
  });
  try {
    if (raw.length > 4096) clearAuthReturn();
    else sessionStorage.setItem(storageKey, raw);
  } catch {
    // The same-document opener still works when storage is unavailable.
  }
}
export function captureAuthReturn(
  value: string | null,
  action: AuthResumeAction,
): void {
  storeAuthReturn(value, action, "pending");
}
export function rememberAuthReturn(value: string | null): void {
  const next = safeAuthReturn(value, location.origin),
    intent = readAuthReturn();
  storeAuthReturn(
    next,
    intent?.next === next ? intent.action : { kind: "page" },
    "oauth",
  );
}
export function completeAuthReturn(value: string | null): boolean {
  const target = safeAuthReturn(value, location.origin),
    current = safeAuthReturn(
      location.pathname + location.search + location.hash,
      location.origin,
    ),
    intent = readAuthReturn();
  storeAuthReturn(
    target,
    intent?.next === target ? intent.action : { kind: "page" },
    "confirmed",
  );
  if (target && target === current)
    history.replaceState(history.state, "", target);
  const handled = !window.dispatchEvent(
    new CustomEvent("yap:auth-complete", {
      cancelable: true,
      detail: { returnTo: target },
    }),
  );
  if (!handled && target && target !== current) location.assign(target);
  else if (!handled) clearAuthReturn();
  return handled || Boolean(target);
}
