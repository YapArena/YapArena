declare global {
  interface Window {
    yapMeasurement?: typeof measurement;
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

function choicePanel() {
  const panel = document.createElement("section");
  panel.className = "measurement-choice";
  panel.setAttribute("aria-label", "Usage measurement choice");
  panel.hidden = true;
  panel.innerHTML = `<p><strong>Help improve YAP Arena?</strong> With your permission, we count which pages people discover and how long they watch. You can change this choice anytime. <a href="/about#measurement">How measurement works</a></p><div><button type="button" data-measurement-allow>Allow measurement</button><button type="button" data-measurement-decline>Not now</button></div><p role="status" aria-live="polite" data-measurement-status></p>`;
  document.body.append(panel);
  const status = panel.querySelector<HTMLElement>("[data-measurement-status]")!;
  panel
    .querySelector<HTMLElement>("[data-measurement-allow]")!
    .addEventListener("click", async () => {
      status.textContent = "Saving your choice…";
      try {
        const response = await fetch("/api/measurement/consent", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent: true }),
        });
        if (!response.ok) throw new Error();
        consented = true;
        rememberDecline(false);
        panel.hidden = true;
        recordPage();
        window.dispatchEvent(new Event("yap-measurement-changed"));
      } catch {
        status.textContent = "Could not save your choice. Try again.";
      }
    });
  panel
    .querySelector<HTMLElement>("[data-measurement-decline]")!
    .addEventListener("click", async () => {
      if (consented) {
        status.textContent = "Removing measurement data…";
        try {
          const response = await fetch("/api/measurement/consent", {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error();
        } catch {
          status.textContent = "Could not remove measurement data. Try again.";
          return;
        }
      }
      consented = false;
      rememberDecline(true);
      panel.hidden = true;
      window.dispatchEvent(new Event("yap-measurement-changed"));
    });
  return panel;
}

const panel = choicePanel();
const settings = document.createElement("button");
settings.type = "button";
settings.className = "measurement-settings";
settings.textContent = "Measurement settings";
settings.addEventListener("click", () => {
  panel.hidden = false;
  panel.querySelector<HTMLElement>("[data-measurement-allow]")!.textContent =
    consented ? "Keep measurement on" : "Allow measurement";
  panel.querySelector<HTMLElement>("[data-measurement-decline]")!.textContent =
    consented ? "Turn off and delete data" : "Not now";
  panel.querySelector<HTMLElement>("[data-measurement-status]")!.textContent =
    "";
  panel.querySelector<HTMLElement>("button")!.focus();
});
document.querySelector(".footer-inner")?.append(settings);

fetch("/api/measurement/consent", { credentials: "same-origin" })
  .then((response) => (response.ok ? response.json() : { consented: false }))
  .then((data: { consented: boolean }) => {
    consented = Boolean(data.consented);
    if (consented) recordPage();
    else if (!declined()) panel.hidden = false;
    window.dispatchEvent(new Event("yap-measurement-changed"));
  })
  .catch(() => {
    if (!declined()) panel.hidden = false;
  });
