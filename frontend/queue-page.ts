// The Queue tab (/queue, first-run plan PR 3). It fills "Someone's waiting"
// from GET /api/matchmaking/waiting, notes waiting counts on the questions
// below, and hands every side button's tap to frontend/matchmaking.ts as a
// yap:queue-request, so queuing keeps the topic page's sign-in, camera,
// one-queue and overlay rules. "+ Create" opens a sheet that creates,
// publishes and queues a new question in one step. Loaded only when the queue
// is on.
import { api, apiErrorStatus } from "./lib/api.js";
import type { QueueState, Side } from "./matchmaking-logic.js";
import {
  newQuestionError,
  rowWaitingText,
  sideButtonView,
  similarQuery,
  slugFromTitle,
  waitingRows,
  waitingText,
  type NewQuestion,
  type WaitingTopic,
} from "./queue-page-model.js";

const REFRESH_MS = 20_000;
const note = document.querySelector<HTMLElement>("[data-queue-page-note]");
const section = document.querySelector<HTMLElement>("[data-waiting-section]");
const list = document.querySelector<HTMLOListElement>("[data-waiting-list]");
let state: QueueState | null = null;
let timer: number | undefined;

const isSide = (value: string | undefined): value is Side =>
  value === "A" || value === "B";

function sideButton(slug: string, side: Side, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-secondary btn-sm queue-request";
  button.dataset.queueRequest = slug;
  button.dataset.requestSide = side;
  button.dataset.sideLabel = label;
  button.textContent = label;
  return button;
}

// Every side button, server-drawn or from the waiting list, follows the queue.
function renderButtons() {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-queue-request]",
  )) {
    const side = button.dataset.requestSide;
    if (!isSide(side)) continue;
    const view = sideButtonView(
      state,
      button.dataset.queueRequest ?? "",
      side,
      button.dataset.sideLabel ?? "",
    );
    if (button.textContent !== view.text) button.textContent = view.text;
    button.setAttribute("aria-pressed", String(view.pressed));
    button.disabled = view.disabled;
  }
}

function renderWaiting(topics: readonly WaitingTopic[]) {
  if (section && list) {
    const rows = waitingRows(topics);
    list.replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement("li");
        item.className = "queue-row";
        const copy = document.createElement("div");
        copy.className = "queue-row-copy";
        const title = document.createElement("a");
        title.className = "queue-row-title";
        title.href = `/topics/${encodeURIComponent(row.slug)}`;
        title.textContent = row.title;
        const meta = document.createElement("p");
        meta.className = "queue-row-meta";
        meta.textContent = waitingText(row.count, row.waitingLabel);
        copy.append(title, meta);
        const sides = document.createElement("div");
        sides.className = "queue-row-sides";
        sides.append(sideButton(row.slug, row.argueSide, row.argueLabel));
        item.append(copy, sides);
        return item;
      }),
    );
    section.hidden = rows.length === 0;
  }
  const bySlug = new Map(topics.map((topic) => [topic.slug, topic]));
  for (const row of document.querySelectorAll<HTMLElement>(
    "[data-queue-row]",
  )) {
    const target = row.querySelector<HTMLElement>("[data-queue-row-waiting]");
    const topic = bySlug.get(row.dataset.queueRow ?? "");
    if (target) target.textContent = topic ? rowWaitingText(topic) : "";
  }
  renderButtons();
}

async function refresh() {
  try {
    const { topics } = await api<{ topics: WaitingTopic[] }>(
      "/api/matchmaking/waiting",
      { timeout: 8000 },
    );
    renderWaiting(topics);
  } catch {
    // The list is a shortcut; the questions below still work without it.
  }
}

function schedule() {
  window.clearInterval(timer);
  timer = undefined;
  if (!document.hidden)
    timer = window.setInterval(() => void refresh(), REFRESH_MS);
}

function requestQueue(topicSlug: string, side: Side, source: HTMLElement) {
  if (note) note.textContent = "";
  window.dispatchEvent(
    new CustomEvent("yap:queue-request", {
      detail: { topicSlug, side, source },
    }),
  );
}

document.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-queue-request]")
      : null;
  const side = button?.dataset.requestSide;
  if (!button || !isSide(side) || button.disabled) return;
  // A similar question's side, from inside the Create sheet: the sheet closes
  // and the "+ Create" link keeps focus.
  const inSheet = Boolean(createDialog?.contains(button));
  if (inSheet) createDialog?.close();
  requestQueue(
    button.dataset.queueRequest ?? "",
    side,
    inSheet && createOpener ? createOpener : button,
  );
});
window.addEventListener("yap:matchmaking", (event) => {
  state = event.detail;
  renderButtons();
});
window.addEventListener("yap:queue-note", (event) => {
  if (note) note.textContent = event.detail;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
  schedule();
});

// ---- "+ Create" -------------------------------------------------------------
// A signed-in player writes a question and picks a side; it is created and
// published with the Create page's own calls, then queued like any side
// button. Guests follow the link to the Create page, which signs them in.
const createOpener =
  document.querySelector<HTMLAnchorElement>("[data-create-open]");
const createDialog = document.querySelector<HTMLDialogElement>(
  "[data-create-dialog]",
);
const createForm =
  document.querySelector<HTMLFormElement>("[data-create-form]");
const createError = document.querySelector<HTMLElement>("[data-create-error]");
const similar = document.querySelector<HTMLElement>("[data-similar]");
const similarList = document.querySelector<HTMLOListElement>(
  "[data-similar-list]",
);
const SIMILAR_DELAY_MS = 350;
let similarTimer: number | undefined;
let similarSearch: AbortController | null = null;
let creating = false;

// A question row like the server's; a null meta entry holds the waiting note.
function topicRow(
  slug: string,
  title: string,
  sideALabel: string,
  sideBLabel: string,
  meta: readonly (string | null)[],
) {
  const item = document.createElement("li");
  item.className = "queue-row";
  const copy = document.createElement("div");
  copy.className = "queue-row-copy";
  const link = document.createElement("a");
  link.className = "queue-row-title";
  link.href = `/topics/${encodeURIComponent(slug)}`;
  link.textContent = title;
  const details = document.createElement("p");
  details.className = "queue-row-meta";
  details.append(
    ...meta.map((text) => {
      const span = document.createElement("span");
      if (text === null) span.dataset.queueRowWaiting = "";
      else span.textContent = text;
      return span;
    }),
  );
  copy.append(link, details);
  const sides = document.createElement("div");
  sides.className = "queue-row-sides";
  sides.setAttribute("role", "group");
  sides.setAttribute("aria-label", `Argue a side: ${title}`);
  sides.append(
    sideButton(slug, "A", sideALabel),
    sideButton(slug, "B", sideBLabel),
  );
  item.append(copy, sides);
  return item;
}

function field(name: string) {
  const value = createForm ? new FormData(createForm).get(name) : null;
  return typeof value === "string" ? value : "";
}

function sayCreateError(message: string) {
  if (createError) createError.textContent = message;
}

function hideSimilar() {
  similarSearch?.abort();
  similarSearch = null;
  if (similar) similar.hidden = true;
  similarList?.replaceChildren();
}

// Questions already asked with the same words, so two people don't wait in
// two queues for one debate.
async function findSimilar() {
  const title = field("title");
  const query = title.trim().length >= 5 ? similarQuery(title) : "";
  if (!query || !similar || !similarList) return hideSimilar();
  similarSearch?.abort();
  const search = new AbortController();
  similarSearch = search;
  try {
    const { items } = await api<{
      items: {
        slug: string;
        title: string;
        sideALabel: string;
        sideBLabel: string;
        isDemo: boolean;
      }[];
    }>(`/api/public/topics?q=${encodeURIComponent(query)}&limit=6`, {
      signal: search.signal,
      timeout: 8000,
    });
    if (search.signal.aborted) return;
    // Demo examples can't be queued on, so they are never offered.
    const joinable = items.filter((topic) => !topic.isDemo).slice(0, 3);
    similarList.replaceChildren(
      ...joinable.map((topic) =>
        topicRow(topic.slug, topic.title, topic.sideALabel, topic.sideBLabel, [
          `${topic.sideALabel} vs ${topic.sideBLabel}`,
        ]),
      ),
    );
    similar.hidden = joinable.length === 0;
    renderButtons();
  } catch {
    // Only a hint: the question can still be created without it.
  }
}

// The new question at the top of "All questions", when this page lists its
// category and is the first page.
function showCreated(slug: string, question: NewQuestion) {
  const questions = document.querySelector<HTMLOListElement>(
    "[data-question-list]",
  );
  const shown = new URLSearchParams(window.location.search);
  if (
    !questions ||
    Number(shown.get("offset") ?? 0) > 0 ||
    (shown.has("category") && shown.get("category") !== question.category)
  )
    return null;
  const select = createForm?.querySelector<HTMLSelectElement>(
    'select[name="category"]',
  );
  const row = topicRow(
    slug,
    question.title.trim(),
    question.sideALabel.trim(),
    question.sideBLabel.trim(),
    [select?.selectedOptions[0]?.textContent ?? "", null, "Your question"],
  );
  row.dataset.queueRow = slug;
  questions.prepend(row);
  questions.hidden = false;
  const empty = questions.nextElementSibling;
  if (empty instanceof HTMLElement && empty.classList.contains("state-quiet"))
    empty.hidden = true;
  renderButtons();
  return row;
}

function createdMessage(error: unknown, created: boolean) {
  if (created)
    return "Your question is saved as a private draft but couldn't be published. Publish it from Create.";
  const status = apiErrorStatus(error);
  if (status === 401) return "Sign in again to create a question.";
  if (status !== undefined && error instanceof Error) return error.message;
  return "Couldn't reach YAP Arena. Check your connection and try again.";
}

function resetCreateForm() {
  createForm?.reset();
  for (const key of ["A", "B"] as const) {
    const name = createForm?.querySelector<HTMLElement>(
      `[data-side-name="${key}"]`,
    );
    if (name) name.textContent = `Side ${key}`;
  }
  hideSimilar();
}

async function createQuestion(joining: boolean) {
  if (creating || !createForm || !createDialog) return;
  const side = field("side");
  const question: NewQuestion = {
    title: field("title"),
    summary: field("summary"),
    sideALabel: field("sideALabel"),
    sideBLabel: field("sideBLabel"),
    category: field("category"),
    side: isSide(side) ? side : null,
  };
  const problem = newQuestionError(question, joining);
  if (problem) return sayCreateError(problem);
  sayCreateError("");
  creating = true;
  createForm.setAttribute("aria-busy", "true");
  const buttons = createForm.querySelectorAll<HTMLButtonElement>("button");
  for (const button of buttons) button.disabled = true;
  const topic = {
    title: question.title.trim(),
    summary: question.summary.trim(),
    sideALabel: question.sideALabel.trim(),
    sideBLabel: question.sideBLabel.trim(),
    category: question.category,
  };
  let created = false;
  try {
    let slug = slugFromTitle(topic.title);
    const send = () =>
      api("/api/matching/topics", {
        method: "POST",
        json: { slug, ...topic },
        timeout: 8000,
      });
    try {
      await send();
    } catch (error) {
      // The address is taken: one more try with a short random ending.
      if (apiErrorStatus(error) !== 409) throw error;
      slug = slugFromTitle(topic.title, Math.random().toString(36).slice(2, 6));
      await send();
    }
    created = true;
    if (!joining) {
      resetCreateForm();
      createDialog.close();
      if (note)
        note.textContent =
          "Saved as a private draft. Publish it from Create when you're ready.";
      return;
    }
    await api(`/api/matching/topics/${encodeURIComponent(slug)}/publish`, {
      method: "POST",
      timeout: 8000,
    });
    const row = showCreated(slug, question);
    resetCreateForm();
    createDialog.close();
    const source =
      row?.querySelector<HTMLElement>(
        `[data-request-side="${question.side}"]`,
      ) ?? createOpener;
    if (question.side && source) requestQueue(slug, question.side, source);
  } catch (error) {
    sayCreateError(createdMessage(error, created));
  } finally {
    creating = false;
    createForm.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  }
}

if (createOpener && createDialog && createForm) {
  createOpener.addEventListener("click", (event) => {
    const header = document.querySelector<HTMLElement>("[data-site-header]");
    if (
      header?.dataset.session !== "member" ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    sayCreateError("");
    createDialog.showModal();
    createForm.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
  });
  createForm.noValidate = true;
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    void createQuestion(
      !(submitter instanceof HTMLButtonElement && submitter.value === "draft"),
    );
  });
  createForm.addEventListener("input", (event) => {
    // An edit answers the last error.
    if (!creating) sayCreateError("");
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name === "title") {
      window.clearTimeout(similarTimer);
      similarTimer = window.setTimeout(
        () => void findSimilar(),
        SIMILAR_DELAY_MS,
      );
    }
    // "You argue" names the sides as they are typed.
    if (target.name === "sideALabel" || target.name === "sideBLabel") {
      const key = target.name === "sideALabel" ? "A" : "B";
      const name = createForm.querySelector<HTMLElement>(
        `[data-side-name="${key}"]`,
      );
      if (name) name.textContent = target.value.trim() || `Side ${key}`;
    }
  });
  createForm
    .querySelector<HTMLButtonElement>("[data-create-cancel]")
    ?.addEventListener("click", () => createDialog.close());
  createDialog.addEventListener("close", () => {
    window.clearTimeout(similarTimer);
    // Safari doesn't focus a tapped link, so focus can land on the page.
    const active = document.activeElement;
    if (!active || active === document.body) createOpener.focus();
  });
  // Another account in this browser: the sheet belonged to the last one.
  window.addEventListener("yap:account-changed", () => createDialog.close());
}

void refresh();
schedule();
