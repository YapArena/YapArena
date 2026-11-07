// "Notify me" on a scheduled debate (first-run build plan PR 9). The button reads the viewer's
// request, saves or removes it, and goes away at the start. Like the follow buttons, a
// signed-out click asks for an account and comes back to this button after sign-in.
import {
  notifyEndpoint,
  notifyError,
  notifyFailure,
  notifyLabel,
  notifyMessage,
  untilStart,
} from "./debate-notify-logic.js";
import { browserPushDevice, startPush, type PushDevice } from "./web-push.js";

export function connectDebateNotify(
  button: HTMLButtonElement,
  status: HTMLElement,
  // Web push (first-run build plan PR 10), when the page carries the public key.
  device: PushDevice = browserPushDevice(),
) {
  const label = button.querySelector<HTMLElement>(
    "[data-debate-notify-label]",
  )!;
  const endpoint = notifyEndpoint(button.dataset.debateNotify!);
  const pushKey = button.dataset.pushKey;
  let notifying = false;
  // Known from the viewer's own request: only a signed-in viewer is asked about notifications.
  let signedIn = false;
  // Changes when the account does, so an older answer can't overwrite a newer state.
  let epoch = 0;
  function show(value: boolean) {
    notifying = value;
    button.setAttribute("aria-pressed", String(value));
    label.textContent = notifyLabel(value);
  }
  function close() {
    button.hidden = true;
    status.hidden = true;
  }
  const left = untilStart(button.dataset.startsAt, Date.now());
  if (left === null) return close();
  // Timers longer than about 24.8 days fire at once, so a far-off start never sets one.
  if (left < 2 ** 31 - 1) window.setTimeout(close, left);

  async function read() {
    const version = epoch;
    try {
      const response = await fetch(endpoint, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (version !== epoch) return;
      signedIn = response.ok;
      // Signed out (401), the button stays "Notify me".
      if (!response.ok) return;
      const data = (await response.json()) as { notifying?: unknown };
      if (version === epoch) show(data.notifying === true);
    } catch {
      // The button still works; the next click reports a failure.
    }
  }

  button.addEventListener("click", async (event) => {
    const version = epoch;
    const next = !notifying;
    // Web push asks for permission only here, inside the viewer's own tap on "Notify me",
    // never when a page loads.
    const pushing =
      next && pushKey && signedIn && event.isTrusted
        ? startPush(device, pushKey)
        : null;
    button.disabled = true;
    try {
      const response = await fetch(endpoint, {
        method: next ? "PUT" : "DELETE",
        credentials: "same-origin",
      });
      if (version !== epoch) return;
      if (response.status === 401) {
        signedIn = false;
        const returnTo =
          window.location.pathname +
          window.location.search +
          window.location.hash;
        if (
          window.dispatchEvent(
            new CustomEvent("yap:request-auth", {
              cancelable: true,
              detail: { returnTo, source: button },
            }),
          )
        )
          window.location.assign(
            `/account?next=${encodeURIComponent(returnTo)}`,
          );
        return;
      }
      if (!response.ok) {
        status.textContent = notifyError(
          await response.json().catch(() => null),
        );
        return;
      }
      signedIn = true;
      show(next);
      status.textContent = notifyMessage(next);
      if (pushing)
        void pushing.then((result) => {
          if (version === epoch && notifying === next)
            status.textContent = notifyMessage(next, result);
        });
    } catch {
      if (version === epoch) status.textContent = notifyFailure;
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener("yap:account-changed", () => {
    epoch += 1;
    signedIn = false;
    show(false);
    status.textContent = "";
    void read();
  });
  void read();
}

const button =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLButtonElement>("[data-debate-notify]");
const status =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-debate-notify-status]");
if (button && status) connectDebateNotify(button, status);
