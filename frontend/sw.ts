// /sw.js is registered only as a service worker, so self has its specialized scope.
// The installed public shell supplies OFFLINE for navigation failures.
/* global self, caches */
const CACHE = "yaparena-public-shell-v1";
const OFFLINE = "/assets/offline.html";

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "install",
  (event) => {
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.addAll([OFFLINE, "/assets/site.css"])),
    );
    (self as WorkerGlobalScope as ServiceWorkerGlobalScope).skipWaiting();
  },
);

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "activate",
  (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith("yaparena-public-shell-") && key !== CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
    );
    (self as WorkerGlobalScope as ServiceWorkerGlobalScope).clients.claim();
  },
);

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "fetch",
  (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(
      fetch(event.request).catch(
        () => caches.match(OFFLINE) as Promise<Response>,
      ),
    );
  },
);

// Web push for "Notify me" (first-run build plan PR 10). The server sends a debate's public
// title and page; the notification opens that page, or focuses a window already on it. Every
// push shows a notification, as browsers require, even one that can't be read.
const PUSH_ICON = "/assets/icons/icon-192.png";

function pushNotice(data: PushMessageData | null) {
  const origin = (self as WorkerGlobalScope).location.origin;
  let message: unknown = null;
  try {
    message = data?.json();
  } catch {
    // Not JSON: the generic notification below.
  }
  const fields =
    typeof message === "object" && message !== null
      ? (message as { title?: unknown; url?: unknown })
      : {};
  let url = new URL("/", origin);
  if (typeof fields.url === "string" && fields.url.startsWith("/")) {
    const target = new URL(fields.url, origin);
    if (target.origin === origin) url = target;
  }
  return typeof fields.title === "string" && fields.title
    ? {
        title: fields.title.slice(0, 200),
        body: "Starts in a few minutes. Tap to watch.",
        url: url.href,
      }
    : {
        title: "YAP Arena",
        body: "A debate you asked to be notified about starts in a few minutes.",
        url: url.href,
      };
}

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "push",
  (event) => {
    const notice = pushNotice(event.data);
    event.waitUntil(
      (
        self as WorkerGlobalScope as ServiceWorkerGlobalScope
      ).registration.showNotification(notice.title, {
        body: notice.body,
        icon: PUSH_ICON,
        // One notification per debate, replaced if the same one arrives again.
        tag: notice.url,
        data: { url: notice.url },
      }),
    );
  },
);

(self as WorkerGlobalScope as ServiceWorkerGlobalScope).addEventListener(
  "notificationclick",
  (event) => {
    event.notification.close();
    const data: unknown = event.notification.data;
    const origin = (self as WorkerGlobalScope).location.origin;
    const saved =
      typeof data === "object" && data !== null && "url" in data
        ? data.url
        : null;
    let url = new URL("/", origin).href;
    try {
      if (typeof saved === "string" && new URL(saved, origin).origin === origin)
        url = new URL(saved, origin).href;
    } catch {
      // Not an address: the home page opens instead.
    }
    const { clients } = self as WorkerGlobalScope as ServiceWorkerGlobalScope;
    event.waitUntil(
      clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((windows) => {
          const open = windows.find((client) => client.url === url);
          return open ? open.focus() : clients.openWindow(url);
        }),
    );
  },
);
