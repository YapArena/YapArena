declare global {
  interface Window {
    yapMeasurement?: typeof measurement;
  }
  // Global Privacy Control (https://globalprivacycontrol.org); not yet in the
  // DOM library types.
  interface Navigator {
    readonly globalPrivacyControl?: boolean;
  }
}
/* global document, window */
const choiceKey = "yaparena-measurement-declined";
let consented = false;
function declined() {
  try {
    return window.localStorage.getItem(choiceKey) === "1";
  } catch {
    return false;
  }
}
function rememberDecline(value: boolean) {
  try {
    if (value) window.localStorage.setItem(choiceKey, "1");
    else window.localStorage.removeItem(choiceKey);
  } catch {
    // Storage may be unavailable; the server consent cookie remains authoritative.
  }
}

async function sendMeasurement(path: string, body: object) {
  if (!consented) return false;
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function pageEvent() {
  const path = window.location.pathname;
  const debate = document.querySelector<HTMLElement>("[data-media-event]");
  const topic = document.querySelector<HTMLElement>("[data-measure-topic]");
  if (debate) return { surface: "debate", id: debate.dataset.mediaEvent };
  if (topic) return { surface: "topic", id: topic.dataset.measureTopic };
  if (path === "/home") return { surface: "home" };
  if (path === "/debates") return { surface: "debates" };
  if (path === "/topics") return { surface: "topics" };
  if (path === "/match") return { surface: "match" };
  if (path.startsWith("/people/")) return { surface: "profile" };
  return null;
}

function recordPage() {
  const event = pageEvent();
  if (event) void sendMeasurement("/api/measurement/discovery", event);
}

const measurement = {
  get consented() {
    return consented;
  },
  startWatch(debateId: string, mode: "live" | "replay", sessionId: string) {
    return sendMeasurement("/api/measurement/watch", {
      debateId,
      mode,
      sessionId,
      phase: "start",
    });
  },
  progressWatch(
    debateId: string,
    mode: "live" | "replay",
    sessionId: string,
    phase: "progress" | "complete" | "end" = "progress",
  ) {
    return sendMeasurement("/api/measurement/watch", {
      debateId,
      mode,
      sessionId,
      phase,
    });
  },
};
window.yapMeasurement = measurement;

// The cookie banner (founder, 2026-10-30). Essential cookies are always on.
// The analytics cookie is product measurement: it stays off until the visitor
// accepts it, as Québec's privacy-by-default rule requires, and turning it
// off deletes this browser's measurements. Reject and Accept weigh the same.
function cookiePanel() {
  const panel = document.createElement("section");
  panel.className = "cookie-choice";
  panel.setAttribute("aria-label", "Cookie choices");
  panel.hidden = true;
  panel.innerHTML = `<div class="cookie-copy"><p class="cookie-title">We use cookies</p><p>Essential cookies keep you signed in and YAP Arena secure. With your OK, we also use an analytics cookie to count which debates people find and how long they watch. We don't use advertising cookies. <a href="/cookies">Cookie Policy</a></p></div><fieldset class="cookie-options" data-cookie-options hidden><legend>Cookie settings</legend><div class="cookie-option"><span class="cookie-option-text"><strong>Essential</strong><span>Sign-in, security and your choices on this device.</span></span><span class="cookie-always">Always on</span></div><label class="cookie-option"><span class="cookie-option-text"><strong>Analytics</strong><span>Which debates people find, watch time and return visits. Turning it off deletes this browser's analytics data.</span></span><input type="checkbox" role="switch" data-cookie-analytics></label></fieldset><div class="cookie-actions"><button type="button" class="cookie-link" data-cookie-customize>Customize</button><button type="button" data-cookie-save hidden>Save choices</button><button type="button" data-cookie-reject>Reject all</button><button type="button" data-cookie-accept>Accept all</button></div><p role="status" aria-live="polite" data-cookie-status></p>`;
  document.body.append(panel);
  const q = <T extends HTMLElement>(selector: string) =>
    panel.querySelector<T>(selector)!;
  const status = q("[data-cookie-status]");
  const options = q("[data-cookie-options]");
  const analytics = q<HTMLInputElement>("[data-cookie-analytics]");
  const customize = q("[data-cookie-customize]");
  const save = q("[data-cookie-save]");

  function show(settings: boolean) {
    panel.hidden = false;
    status.textContent = "";
    options.hidden = !settings;
    customize.hidden = settings;
    save.hidden = !settings;
    analytics.checked = consented;
  }

  async function choose(allow: boolean) {
    if (allow && !consented) {
      status.textContent = "Saving your choice…";
      try {
        const response = await fetch("/api/measurement/consent", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent: true }),
        });
        if (!response.ok) throw new Error();
      } catch {
        status.textContent = "Could not save your choice. Try again.";
        return;
      }
      consented = true;
      rememberDecline(false);
      recordPage();
    } else if (!allow) {
      if (consented) {
        status.textContent = "Turning off analytics and deleting its data…";
        try {
          const response = await fetch("/api/measurement/consent", {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error();
        } catch {
          status.textContent = "Could not delete analytics data. Try again.";
          return;
        }
      }
      consented = false;
      rememberDecline(true);
    }
    panel.hidden = true;
    window.dispatchEvent(new Event("yap-measurement-changed"));
  }

  q("[data-cookie-accept]").addEventListener("click", () => void choose(true));
  q("[data-cookie-reject]").addEventListener("click", () => void choose(false));
  save.addEventListener("click", () => void choose(analytics.checked));
  customize.addEventListener("click", () => {
    show(true);
    analytics.focus();
  });
  return {
    banner: () => show(false),
    settings: () => {
      show(true);
      analytics.focus();
    },
  };
}

const cookies = cookiePanel();
const settings = document.createElement("button");
settings.type = "button";
settings.className = "cookie-settings";
settings.textContent = "Cookie settings";
settings.addEventListener("click", cookies.settings);
document.querySelector(".footer-inner")?.append(settings);

// /cookies links here with #cookie-settings to open the settings directly.
const openSettings = () => window.location.hash === "#cookie-settings";
// A browser that sends Global Privacy Control has already refused: no banner,
// analytics stays off, and Cookie settings can still turn it on.
const refused = () => declined() || navigator.globalPrivacyControl === true;
fetch("/api/measurement/consent", { credentials: "same-origin" })
  .then((response) => (response.ok ? response.json() : { consented: false }))
  .then((data: { consented: boolean }) => {
    consented = Boolean(data.consented);
    if (consented) recordPage();
    if (openSettings()) cookies.settings();
    else if (!consented && !refused()) cookies.banner();
    window.dispatchEvent(new Event("yap-measurement-changed"));
  })
  .catch(() => {
    if (openSettings()) cookies.settings();
    else if (!refused()) cookies.banner();
  });
