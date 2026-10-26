// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  MatchingTopic,
  MatchingRequest,
  MatchingEvent,
  MatchingNotification,
  MatchingPerson,
} from "./matching-types.js";
import {
  formatTime,
  mySide,
  opponentHandle,
  proposedTimes,
  requestActions,
  requestSummary,
} from "./challenge-logic.js";
import { needsDebaterSettings, showSettingsPrompt } from "./settings-prompt.js";
interface RequestForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    topicSlug: HTMLInputElement;
    requestedSide: HTMLSelectElement;
  };
}
/* global document, window */
const notice = document.querySelector<HTMLElement>("#match-notice")!;
// With the live queue on, the page offers direct challenges now or at proposed times
// (Decision 0011); otherwise the original request form.
const challengeForm = document.querySelector<RequestForm>("#challenge-create");
const requestForm =
  challengeForm ?? document.querySelector<RequestForm>("#request-create")!;
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
// A refusal for missing debater settings links to them; other errors show their message.
function sayError(error: unknown) {
  const message = (error as Error).message;
  if (needsDebaterSettings(error)) showSettingsPrompt(notice, message);
  else say(message);
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
  const data: { error?: string; code?: string } = await response.json();
  if (epoch !== accountEpoch) throw new StaleAccountResponse();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "Request failed. Please try again."),
      { code: data.code },
    );
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
      if (epoch === accountEpoch) sayError(error);
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
function date(value: string | null) {
  return value ? formatTime(value) : "now";
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
    sayError(error);
  }),
);

// Accepting a "now" challenge opens its debate, which starts as soon as both speakers join.
async function accept(
  request: MatchingRequest,
  proposal: { id: string; startsAt: string } | null,
) {
  const { label } = mySide(request, currentUser!.id);
  const when = proposal ? date(proposal.startsAt) : date(request.scheduledAt);
  if (
    !window.confirm(
      request.mode === "now" && !proposal
        ? `Debate “${request.proposition}” now, arguing ${label}? It starts as soon as you both join.`
        : `Accept “${request.proposition}” arguing ${label} on ${when}?`,
    )
  )
    return;
  settled(request);
  const { event } = await api<{ event: { slug: string } }>(
    `/api/matching/requests/${request.id}/accept`,
    "POST",
    proposal ? { proposalId: proposal.id } : {},
  );
  if (request.mode === "now" && !proposal) {
    window.location.assign(`/debates/${encodeURIComponent(event.slug)}`);
    return;
  }
  say(
    `Booked for ${when}. You'll both get a reminder 5 minutes before it starts.`,
  );
}

// An inline form for one to three other times; either player can answer this way.
let openProposalForm: HTMLFormElement | null = null;
function proposeForm(item: HTMLLIElement, request: MatchingRequest) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = "Propose times";
  button.addEventListener("click", () => {
    openProposalForm?.remove();
    const form = document.createElement("form");
    form.className = "stack-form challenge-propose";
    const inputs = [
      "First choice, your local time",
      "Second choice (optional)",
      "Third choice (optional)",
    ].map((text) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "datetime-local";
      label.append(text, input);
      form.append(label);
      return input;
    });
    const actions = document.createElement("div");
    actions.className = "challenge-propose-actions";
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "small-button";
    send.textContent = "Send times";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "small-button";
    cancel.textContent = "Cancel";
    actions.append(send, cancel);
    form.append(actions);
    const close = () => {
      form.remove();
      if (openProposalForm === form) openProposalForm = null;
      button.hidden = false;
      button.focus();
      if (stale) void refreshLater();
    };
    cancel.addEventListener("click", close);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const epoch = accountEpoch;
      const checked = proposedTimes(
        inputs.map((input) => input.value),
        Date.now(),
      );
      if ("error" in checked) return say(checked.error);
      send.disabled = true;
      try {
        await api(`/api/matching/requests/${request.id}/proposals`, "POST", {
          times: checked.times,
        });
        if (epoch !== accountEpoch) return;
        say("Times sent. The other player can accept one or propose others.");
        form.remove();
        openProposalForm = null;
        await refresh();
      } catch (error) {
        if (epoch === accountEpoch) sayError(error);
        send.disabled = false;
      }
    });
    button.hidden = true;
    item.append(form);
    openProposalForm = form;
    inputs[0]!.focus();
  });
  item.append(button);
}

function settled(request: MatchingRequest) {
  window.dispatchEvent(
    new CustomEvent("yap:challenge-settled", { detail: request.id }),
  );
}

function requestItem(request: MatchingRequest, userId: string) {
  const item = row(
    requestSummary(request, userId, Date.now()),
    request.debateSlug
      ? `/debates/${encodeURIComponent(request.debateSlug)}`
      : null,
  );
  const actions = requestActions(request, userId);
  if (actions.acceptNow)
    action(item, "Accept now", () => accept(request, null));
  if (actions.acceptOriginal)
    action(item, "Accept", () => accept(request, null));
  for (const proposal of actions.theirTimes)
    action(item, `Accept ${date(proposal.startsAt)}`, () =>
      accept(request, proposal),
    );
  if (actions.myTimes.length) {
    const mine = document.createElement("span");
    mine.className = "form-note";
    mine.textContent = `You proposed ${actions.myTimes.map((proposal) => date(proposal.startsAt)).join(", ")}`;
    item.append(mine);
  }
  if (actions.propose) proposeForm(item, request);
  if (actions.decline)
    action(item, "Decline", async () => {
      settled(request);
      await api(`/api/matching/requests/${request.id}/declined`, "POST");
      say("Challenge declined.");
    });
  if (actions.withdraw)
    action(item, "Withdraw", async () => {
      settled(request);
      await api(`/api/matching/requests/${request.id}/withdrawn`, "POST");
      say("Request withdrawn.");
    });
  return item;
}

// The live stream says something changed; reload the lists unless a reply is being typed.
let stale = false;
let refreshTimer: number | undefined;
function refreshLater() {
  if (!currentUser) return;
  if (openProposalForm) {
    stale = true;
    return;
  }
  stale = false;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refresh().catch((error: unknown) => {
      if (!(error instanceof StaleAccountResponse)) sayError(error);
    });
  }, 300);
}
window.addEventListener("yap:matching-changed", refreshLater);

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
  fill("#my-requests", requests.requests, (request) =>
    requestItem(request, currentUser!.id),
  );
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
      if (epoch === accountEpoch) sayError(error);
    }
  });

function challengeBody(data: Record<string, FormDataEntryValue>) {
  const targetHandle = opponentHandle(String(data.targetHandle ?? ""));
  if (!targetHandle)
    throw new Error(
      "Choose a person from the suggestions or type their handle.",
    );
  const proposition = String(data.proposition ?? "").trim();
  if (proposition.length < 10)
    throw new Error("Write a proposition of at least 10 characters.");
  const base = {
    kind: "direct",
    topicSlug: data.topicSlug,
    proposition,
    requestedSide: data.requestedSide,
    targetHandle,
  };
  if (data.mode === "now") return { ...base, mode: "now" };
  const checked = proposedTimes(
    [data.time1, data.time2, data.time3].map((value) => String(value ?? "")),
    Date.now(),
  );
  if ("error" in checked) throw new Error(checked.error);
  return { ...base, proposedTimes: checked.times };
}

if (challengeForm) {
  const times = challengeForm.querySelector<HTMLElement>(
    "[data-challenge-times]",
  )!;
  const showTimes = () => {
    const scheduled =
      challengeForm.querySelector<HTMLInputElement>(
        'input[name="mode"]:checked',
      )?.value === "scheduled";
    times.hidden = !scheduled;
    for (const input of times.querySelectorAll("input"))
      input.disabled = !scheduled;
  };
  for (const radio of challengeForm.querySelectorAll<HTMLInputElement>(
    'input[name="mode"]',
  ))
    radio.addEventListener("change", showTimes);
  // A reset restores "Now" after the reset event itself.
  challengeForm.addEventListener("reset", () => window.setTimeout(showTimes));
  showTimes();

  // Suggestions by handle prefix or part of a display name, as the player types.
  const person = challengeForm.querySelector<HTMLInputElement>(
    'input[name="targetHandle"]',
  )!;
  const people =
    document.querySelector<HTMLDataListElement>("#people-options")!;
  let searchTimer: number | undefined;
  let searched = "";
  person.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const query = person.value.trim().replace(/^@/, "");
    if (query.length < 2 || query === searched) return;
    searchTimer = window.setTimeout(async () => {
      searched = query;
      try {
        const found = await api<{ people: MatchingPerson[] }>(
          `/api/matching/people?q=${encodeURIComponent(query)}`,
        );
        people.replaceChildren(
          ...found.people.map((entry) => {
            const option = document.createElement("option");
            option.value = entry.handle;
            option.label = entry.displayName;
            return option;
          }),
        );
      } catch {
        // Typing again searches again.
        searched = "";
      }
    }, 250);
  });
}

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const epoch = accountEpoch;
  const form = event.currentTarget as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form));
  if (form === challengeForm) {
    try {
      const body = challengeBody(data);
      await loadTopic();
      const { request } = await api<{ request: MatchingRequest }>(
        "/api/matching/requests",
        "POST",
        body,
      );
      form.reset();
      sideSelect.options[0]!.textContent = "Side A";
      sideSelect.options[1]!.textContent = "Side B";
      sideMap.textContent = "Choose a published topic to see its side mapping.";
      say(
        request.mode === "now"
          ? request.respondBy
            ? `Challenge sent. @${body.targetHandle} has 2 minutes to answer.`
            : `@${body.targetHandle} isn't online. Your challenge waits for them for 7 days.`
          : "Challenge sent. They can accept a time or propose others.",
      );
      await refresh();
    } catch (error) {
      if (epoch === accountEpoch) sayError(error);
    }
    return;
  }
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
    if (epoch === accountEpoch) sayError(error);
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
    } else sayError(error);
  }
}

window.addEventListener("yap:account-changed", () => void initialize());
initialize();
