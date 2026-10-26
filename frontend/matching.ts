// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  MatchingTopic,
  MatchingRequest,
  MatchingEvent,
  MatchingNotification,
} from "./matching-types.js";
interface RequestForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    topicSlug: HTMLInputElement;
    requestedSide: HTMLSelectElement;
  };
}
/* global document, window */
const notice = document.querySelector<HTMLElement>("#match-notice")!;
const requestForm = document.querySelector<RequestForm>("#request-create")!;
const topicSlugInput = requestForm.elements.topicSlug;
const sideSelect = requestForm.elements.requestedSide;
const sideMap = document.createElement("p");
sideMap.className = "form-note";
sideMap.setAttribute("role", "status");
sideMap.textContent = "Choose a published topic to see its side mapping.";
topicSlugInput.closest("label")!.after(sideMap);
let currentUser: { id: string } | null = null;
let accountEpoch = 0;
class StaleAccountResponse extends Error {}

function say(message: string) {
  notice.textContent = message;
}
async function api<T = void>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const epoch = accountEpoch;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (epoch !== accountEpoch) throw new StaleAccountResponse();
  if (response.status === 204) return null as T;
  const data: { error?: string } = await response.json();
  if (epoch !== accountEpoch) throw new StaleAccountResponse();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data as T;
}

function row(label: string, href?: string | null) {
  const item = document.createElement("li");
  const content = document.createElement(href ? "a" : "span");
  content.textContent = label;
  if (href) (content as HTMLAnchorElement).href = href;
  item.append(content);
  return item;
}
function action(
  item: HTMLLIElement,
  label: string,
  handler: () => Promise<void>,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    const epoch = accountEpoch;
    button.disabled = true;
    try {
      await handler();
      await refresh();
    } catch (error) {
      if (epoch === accountEpoch) say((error as Error).message);
    } finally {
      if (epoch === accountEpoch) button.disabled = false;
    }
  });
  item.append(button);
}
function fill<T>(
  selector: string,
  entries: T[],
  render: (entry: T) => HTMLLIElement,
) {
  const list = document.querySelector<HTMLElement>(selector)!;
  list.replaceChildren();
  if (!entries.length) list.append(row("Nothing here yet."));
  for (const entry of entries) list.append(render(entry));
}
function date(value: string) {
  return new Date(value).toLocaleString();
}
async function loadTopic() {
  const slug = topicSlugInput.value.trim();
  if (!slug) throw new Error("Choose a published topic first.");
  const topic = await api<MatchingTopic>(
    `/api/public/topics/${encodeURIComponent(slug)}`,
  );
  sideSelect.options[0]!.textContent = `Side A — ${topic.sideALabel}`;
  sideSelect.options[1]!.textContent = `Side B — ${topic.sideBLabel}`;
  sideMap.textContent = `A: ${topic.sideALabel} · B: ${topic.sideBLabel}`;
  return topic;
}
topicSlugInput.addEventListener("change", () =>
  loadTopic().catch((error: unknown) => {
    if (error instanceof StaleAccountResponse) return;
    sideMap.textContent = "Choose a published topic to see its side mapping.";
    say((error as Error).message);
  }),
);

async function refresh() {
  const epoch = accountEpoch;
  // With the live queue on, the page has no open-request list (Decision 0011).
  const openQueue = document.querySelector("#open-queue");
  const [topics, requests, queue, events, notifications] = await Promise.all([
    api<{ topics: MatchingTopic[] }>("/api/matching/topics/mine"),
    api<{ requests: MatchingRequest[] }>("/api/matching/requests"),
    openQueue
      ? api<{ requests: MatchingRequest[] }>("/api/matching/queue")
      : { requests: [] },
    api<{ events: MatchingEvent[] }>("/api/matching/events"),
    api<{ notifications: MatchingNotification[] }>(
      "/api/matching/notifications",
    ),
  ]);
  if (epoch !== accountEpoch || !currentUser) return;
  fill("#my-topics", topics.topics, (topic) => {
    const item = row(
      `${topic.title} · ${topic.publicationState}`,
      topic.publicationState === "published"
        ? `/topics/${encodeURIComponent(topic.slug)}`
        : null,
    );
    if (topic.publicationState === "draft")
      action(item, "Publish", async () => {
        await api(
          `/api/matching/topics/${encodeURIComponent(topic.slug)}/publish`,
          "POST",
        );
        say("Topic published.");
      });
    return item;
  });
  fill("#my-requests", requests.requests, (request) => {
    const mySide =
      request.initiatorUserId === currentUser!.id
        ? request.requestedSide
        : request.requestedSide === "A"
          ? "B"
          : "A";
    const myLabel = mySide === "A" ? request.sideALabel : request.sideBLabel;
    const item = row(
      `${request.kind === "direct" ? "Challenge" : "Queue"}: ${request.proposition} · your side ${mySide} (${myLabel}) · ${request.status} · ${date(request.scheduledAt)}`,
      request.debateSlug
        ? `/debates/${encodeURIComponent(request.debateSlug)}`
        : null,
    );
    if (request.status === "open" && request.targetUserId === currentUser!.id)
      action(item, "Accept", async () => {
        if (
          !window.confirm(
            `Accept “${request.proposition}” on side ${mySide} (${myLabel}) at ${date(request.scheduledAt)}?`,
          )
        )
          return;
        await api(`/api/matching/requests/${request.id}/accept`, "POST");
        say("Challenge accepted. Your event is scheduled.");
      });
    if (request.status === "open" && request.targetUserId === currentUser!.id)
      action(item, "Decline", async () => {
        await api(`/api/matching/requests/${request.id}/declined`, "POST");
        say("Challenge declined.");
      });
    if (
      request.status === "open" &&
      request.initiatorUserId === currentUser!.id
    )
      action(item, "Withdraw", async () => {
        await api(`/api/matching/requests/${request.id}/withdrawn`, "POST");
        say("Request withdrawn.");
      });
    return item;
  });
  if (openQueue)
    fill(
      "#open-queue",
      queue.requests.filter(
        (request) => request.initiatorUserId !== currentUser!.id,
      ),
      (request) => {
        const opposite = request.requestedSide === "A" ? "B" : "A";
        const oppositeLabel =
          opposite === "A" ? request.sideALabel : request.sideBLabel;
        const item = row(
          `${request.proposition} · ${request.topicSlug} · take side ${opposite} (${oppositeLabel}) · ${date(request.scheduledAt)}`,
        );
        action(item, "Join", async () => {
          if (
            !window.confirm(
              `Join on side ${opposite} (${oppositeLabel}) for “${request.proposition}” at ${date(request.scheduledAt)}?`,
            )
          )
            return;
          await api(`/api/matching/queue/${request.id}/join`, "POST");
          say("Joined. Your event is scheduled.");
        });
        return item;
      },
    );
  fill("#my-events", events.events, (event) => {
    const item = row(
      `${event.proposition} · ${event.status} · ${date(event.scheduledAt)}`,
      `/debates/${encodeURIComponent(event.slug)}`,
    );
    if (event.status === "scheduled" || event.status === "ready")
      item.append(
        document.createTextNode(" · Open event to check camera and join"),
      );
    return item;
  });
  fill("#match-notifications", notifications.notifications, (entry) => {
    const item = row(`${entry.message} · ${date(entry.createdAt)}`);
    if (!entry.readAt)
      action(item, "Mark read", async () => {
        await api(`/api/matching/notifications/${entry.id}/read`, "POST");
      });
    return item;
  });
}

document
  .querySelector<HTMLFormElement>("#topic-create")!
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const epoch = accountEpoch;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      await api("/api/matching/topics", "POST", Object.fromEntries(data));
      form.reset();
      say("Topic created as a private draft. Publish it when ready.");
      await refresh();
    } catch (error) {
      if (epoch === accountEpoch) say((error as Error).message);
    }
  });

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const epoch = accountEpoch;
  const form = event.currentTarget as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form));
  try {
    await loadTopic();
    const scheduledAt = new Date(data.scheduledAt as string);
    if (!Number.isFinite(scheduledAt.getTime()))
      throw new Error("Choose a valid start time.");
    const body = {
      kind: data.kind,
      topicSlug: data.topicSlug,
      proposition: data.proposition,
      requestedSide: data.requestedSide,
      scheduledAt: scheduledAt.toISOString(),
      ...(data.kind === "direct" ? { targetHandle: data.targetHandle } : {}),
    };
    await api("/api/matching/requests", "POST", body);
    form.reset();
    sideSelect.options[0]!.textContent = "Side A";
    sideSelect.options[1]!.textContent = "Side B";
    sideMap.textContent = "Choose a published topic to see its side mapping.";
    say(
      "Request opened. It expires after 24 hours or 30 minutes before the proposed start.",
    );
    await refresh();
  } catch (error) {
    if (epoch === accountEpoch) say((error as Error).message);
  }
});

async function initialize() {
  const epoch = ++accountEpoch;
  currentUser = null;
  document.querySelector<HTMLElement>("#match-signed-in")!.hidden = true;
  document.querySelector<HTMLElement>("#match-signed-out")!.hidden = true;
  for (const id of [
    "my-topics",
    "my-requests",
    "open-queue",
    "my-events",
    "match-notifications",
  ])
    document.querySelector<HTMLElement>(`#${id}`)?.replaceChildren();
  say("Checking your account…");
  try {
    const user = (await api<{ user: { id: string } }>("/api/auth/me")).user;
    if (epoch !== accountEpoch) return;
    currentUser = user;
    document.querySelector<HTMLElement>("#match-signed-out")!.hidden = true;
    document.querySelector<HTMLElement>("#match-signed-in")!.hidden = false;
    await refresh();
    if (epoch === accountEpoch)
      say("Matching ready. Review your request before submitting.");
  } catch (error) {
    if (epoch !== accountEpoch) return;
    currentUser = null;
    document.querySelector<HTMLElement>("#match-signed-in")!.hidden = true;
    if ((error as Error).message === "authentication required") {
      document.querySelector<HTMLElement>("#match-signed-out")!.hidden = false;
      say("Sign in to create topics and arrange debates.");
    } else say((error as Error).message);
  }
}

window.addEventListener("yap:account-changed", () => void initialize());
initialize();
