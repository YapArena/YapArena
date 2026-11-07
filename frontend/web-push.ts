// Web push for "Notify me" (first-run build plan PR 10). The browser asks for notification
// permission only inside the viewer's tap on "Notify me", subscribes with the site's public
// VAPID key and saves the subscription on the server. Anything missing, refused or failing
// leaves "Notify me" working in-app exactly as before.

export const pushSubscriptionEndpoint = "/api/matching/push-subscription";

// "on": this browser gets a notification too. "install": a Safari tab on iPhone or iPad, where
// only an app added to the Home Screen gets push. "off": no push here (unsupported, blocked or
// failed).
export type PushResult = "on" | "install" | "off";

export interface PushDevice {
  availability(): "ready" | "install" | "off";
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscribe(key: string): Promise<PushSubscriptionJSON>;
}

// The base64url public key as the bytes PushManager.subscribe takes.
export function keyBytes(key: string) {
  const base64 = key.replaceAll("-", "+").replaceAll("_", "/");
  const text = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

const readyTimeoutMs = 10_000;

export function browserPushDevice(
  scope: Window & typeof globalThis = window,
): PushDevice {
  return {
    availability() {
      const { navigator } = scope;
      if (
        "serviceWorker" in navigator &&
        "PushManager" in scope &&
        "Notification" in scope
      )
        return "ready";
      // Safari on iPhone and iPad offers push only to Home Screen apps; its tabs say
      // navigator.standalone is false.
      return "standalone" in navigator && navigator.standalone === false
        ? "install"
        : "off";
    },
    permission: () => scope.Notification.permission,
    requestPermission: () => scope.Notification.requestPermission(),
    async subscribe(key) {
      // site.ts registers /sw.js after the page loads; a worker that never starts fails here.
      const registration = await new Promise<ServiceWorkerRegistration>(
        (resolve, reject) => {
          scope.setTimeout(
            () => reject(new Error("service worker unavailable")),
            readyTimeoutMs,
          );
          scope.navigator.serviceWorker.ready.then(resolve, reject);
        },
      );
      const options = {
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      };
      try {
        return (await registration.pushManager.subscribe(options)).toJSON();
      } catch (error) {
        // A subscription made with another key blocks a new one: replace it once.
        const previous = await registration.pushManager.getSubscription();
        if (!previous) throw error;
        await previous.unsubscribe();
        return (await registration.pushManager.subscribe(options)).toJSON();
      }
    },
  };
}

// Starts at once, so the permission prompt opens inside the tap that called it: browsers show
// it only from a user gesture. Resolves when the subscription is saved or push is out.
export function startPush(
  device: PushDevice,
  key: string,
): Promise<PushResult> {
  let answer: Promise<NotificationPermission>;
  try {
    const availability = device.availability();
    if (availability !== "ready") return Promise.resolve(availability);
    const permission = device.permission();
    if (permission === "denied") return Promise.resolve("off");
    // Called directly, not after an await, so Safari still sees the tap.
    answer = Promise.resolve(
      permission === "granted" ? permission : device.requestPermission(),
    );
  } catch {
    return Promise.resolve("off");
  }
  return answer
    .then(async (granted): Promise<PushResult> => {
      if (granted !== "granted") return "off";
      const subscription = await device.subscribe(key);
      const response = await fetch(pushSubscriptionEndpoint, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      return response.ok ? "on" : "off";
    })
    .catch((): PushResult => "off");
}
