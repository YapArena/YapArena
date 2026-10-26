// One personal live-update stream per tab, /api/me/stream (interface 10), shared by every module
// on the page through window.yapUserStream. Modules subscribe to event kinds ("state" for the
// live queue, "results" for revealed results). When the stream is unavailable (signed out, busy
// or not configured) each module hears it once and polls instead.

type Handler = (data: unknown) => void;

export interface UserStream {
  /** False once the stream has failed for good on this page. */
  readonly available: boolean;
  /** Receives each event of this kind; returns a function that stops it. */
  on(kind: string, handler: Handler): () => void;
  /** Called once if the stream becomes unavailable. */
  onUnavailable(handler: () => void): () => void;
  /** After an account change: reconnect with the new session. */
  reset(): void;
}

declare global {
  interface Window {
    yapUserStream?: UserStream;
  }
}

/** Where EventSource comes from: the page, or a test double. */
export interface StreamScope {
  EventSource?: typeof EventSource;
}

export function createUserStream(
  scope: StreamScope = globalThis,
  url = "/api/me/stream",
): UserStream {
  const handlers = new Map<string, Set<Handler>>();
  const unavailable = new Set<() => void>();
  const Source = scope.EventSource;
  const supported = Source !== undefined;
  let source: EventSource | null = null;
  let listened = new Set<string>();
  let failed = !supported;

  function listen(kind: string) {
    const opened = source;
    if (!opened || listened.has(kind)) return;
    listened.add(kind);
    opened.addEventListener(kind, (event) => {
      if (source !== opened) return;
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        return;
      }
      for (const handler of [...(handlers.get(kind) ?? [])]) handler(data);
    });
  }
  function open() {
    if (source || failed || !handlers.size || !Source) return;
    const opened = new Source(url);
    source = opened;
    listened = new Set();
    for (const kind of handlers.keys()) listen(kind);
    opened.addEventListener("error", () => {
      if (opened.readyState !== opened.CLOSED || source !== opened) return;
      source = null;
      failed = true;
      for (const handler of [...unavailable]) handler();
    });
  }
  function close() {
    source?.close();
    source = null;
  }

  return {
    get available() {
      return !failed;
    },
    on(kind, handler) {
      const entries = handlers.get(kind) ?? new Set<Handler>();
      entries.add(handler);
      handlers.set(kind, entries);
      listen(kind);
      open();
      return () => {
        entries.delete(handler);
        if (!entries.size) handlers.delete(kind);
        if (!handlers.size) close();
      };
    },
    onUnavailable(handler) {
      unavailable.add(handler);
      return () => unavailable.delete(handler);
    },
    reset() {
      close();
      failed = !supported;
      open();
    },
  };
}

/** This page's shared stream. */
export function userStream(): UserStream {
  return (window.yapUserStream ??= createUserStream());
}
