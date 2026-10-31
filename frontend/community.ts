// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  CommunityMessage,
  SubmissionRecord,
  CommunitySummary,
  CommunityFrame,
  ChatPage,
  ChatSyncPage,
  CommunityCase,
  CommunityAppeal,
  CaseDetail,
  DeliveryError,
} from "./community-types.js";
interface ChatForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & { body: HTMLTextAreaElement };
}
interface ReportForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    reasonCode: HTMLSelectElement;
    detail: HTMLTextAreaElement;
  };
}
type MessageView = Pick<CommunityMessage, "body" | "createdAt"> &
  Partial<CommunityMessage>;
/* global document, window */
import { api as requestAPI } from "./community-transport.js";
import { createCommunityStream } from "./community-stream.js";
import {
  createChatState,
  compareIds,
  recoverDraft,
  shouldSendOnEnter,
} from "./community-state.js";
import { authorTint } from "./debate-layout-model.js";
const reasons = ["harassment", "hate", "threat", "spam", "privacy", "other"];
let mutationAccountEpoch = 0;
window.addEventListener("yap:account-changed", () => mutationAccountEpoch++);
class StaleAccountResponse extends Error {}
async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const epoch = mutationAccountEpoch;
  const mutation = (options.method ?? "GET").toUpperCase() !== "GET";
  try {
    const result = await requestAPI<T>(path, options);
    if (mutation && epoch !== mutationAccountEpoch)
      throw new StaleAccountResponse();
    return result;
  } catch (error) {
    if (mutation && epoch !== mutationAccountEpoch)
      throw new StaleAccountResponse();
    throw error;
  }
}

function requestAuthentication(error: DeliveryError, source: HTMLElement) {
  if (error.status !== 401) return;
  const returnTo = location.pathname + location.search + location.hash;
  if (
    window.dispatchEvent(
      new CustomEvent("yap:request-auth", {
        cancelable: true,
        detail: { returnTo, source },
      }),
    )
  )
    location.assign(`/account?next=${encodeURIComponent(returnTo)}`);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string | null,
  className?: string,
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function setText(node: Node, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

function labelField(label: string, input: HTMLElement) {
  const wrapper = element("label", label);
  wrapper.append(input);
  return wrapper;
}

function selectField(values: string[], label: string) {
  const select = element("select");
  select.required = true;
  select.append(element("option", label));
  (select.firstChild as HTMLOptionElement).value = "";
  for (const value of values) {
    const option = element("option", value.replaceAll("_", " "));
    option.value = value;
    select.append(option);
  }
  return select;
}

function noteField() {
  const textarea = element("textarea");
  textarea.minLength = 10;
  textarea.maxLength = 500;
  textarea.rows = 3;
  textarea.required = true;
  return textarea;
}

function date(value: string | undefined) {
  return value ? new Date(value).toLocaleString() : "";
}

async function submit(
  form: HTMLFormElement,
  action: () => Promise<void>,
  status: HTMLElement,
) {
  const button = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    if (error instanceof StaleAccountResponse) return;
    status.textContent = (error as DeliveryError).message;
    requestAuthentication(error as DeliveryError, form);
  } finally {
    button.disabled = false;
  }
}

function reportForm(
  targetType: "event" | "chat",
  targetId: string,
  status: HTMLElement,
  onDone: () => void,
) {
  const form = element("form", undefined, "community-inline-form");
  const reason = selectField(reasons, "Choose a reason");
  const detail = noteField();
  form.append(
    labelField("Reason", reason),
    labelField("What happened?", detail),
    element("button", "Submit private report"),
  );
  (form.lastChild as HTMLButtonElement).type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(
      form,
      async () => {
        await api("/api/community/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType,
            targetId,
            reasonCode: reason.value,
            detail: detail.value,
          }),
        });
        status.textContent = "Report submitted privately for review.";
        onDone();
      },
      status,
    );
  });
  return form;
}

function initEvent(root: HTMLElement) {
  const id = root.dataset.communityEvent!;
  const chatRoot =
    document.querySelector<HTMLElement>("[data-community-chat-panel]")! || root;
  const status = root.querySelector<HTMLElement>("[data-community-status]")!;
  const connection = chatRoot.querySelector<HTMLElement>(
    "[data-community-connection]",
  )!;
  const chatState = chatRoot.querySelector<HTMLElement>(
    "[data-community-chat-state]",
  )!;
  const messages = chatRoot.querySelector<HTMLElement>(
    "[data-community-messages]",
  )!;
  const older = chatRoot.querySelector<HTMLButtonElement>(
    "[data-community-older]",
  )!;
  const newMessages = chatRoot.querySelector<HTMLButtonElement>(
    "[data-community-new]",
  )!;
  const sendStatus = chatRoot.querySelector<HTMLElement>(
    "[data-community-send-status]",
  )!;
  const like = root.querySelector<HTMLButtonElement>("[data-community-like]")!;
  const count = root.querySelector<HTMLElement>("[data-community-likes]")!;
  const chatForm = chatRoot.querySelector<ChatForm>(
    "[data-community-chat-form]",
  )!;
  const report = root.querySelector<ReportForm>(
    "[data-community-report-form]",
  )!;
  let currentLiked = false;
  let oldest: string | null = null;
  let signedIn = false;
  let currentAccountId: string | null = null;
  const submissionOwners = new WeakMap<SubmissionRecord, string | null>();
  let likeWriting = false;
  let personalEpoch = 0;
  let personalRefreshNeeded = true;
  const state = createChatState();
  const localNodes = new Map<string, HTMLLIElement>();
  let cooldownUntil = 0;
  let cooldownTimer: number | undefined;
  let composing = false;
  let recoveredSubmission: SubmissionRecord | null = null;
  let syncing = false;
  let degradedMode = false;
  let streamHealthy = false;
  let publicUnavailable = false;
  let streamEpoch = 0;
  let resetFence = "0";
  let summaryRevision = "0";
  let pollController: AbortController | undefined;
  let reconciliationTimer: number | undefined;
  let reconciling = false;
  let loadingOlder = false;
  let retryDelay = 2000;
  let timer: number | undefined;
  let unseenCount = 0;
  const unseenIds = new Set<string>();
  let latestEvicted = false;
  const rendered = new Map<string, HTMLLIElement>();
  const tracked = new Set<string>();

  async function refreshPersonalLike() {
    if (!signedIn || publicUnavailable || likeWriting) return;
    const epoch = ++personalEpoch;
    try {
      const mine = await api<{ liked: boolean }>(
        `/api/community/events/${id}/my-like`,
      );
      if (epoch !== personalEpoch || publicUnavailable || likeWriting) return;
      currentLiked = mine.liked;
      like.setAttribute("aria-pressed", String(currentLiked));
      like.textContent = currentLiked ? "Remove like" : "Like this event";
      personalRefreshNeeded = false;
    } catch {
      /* Keep the existing personal selection until it can be checked. */
    }
  }

  function renderSummary(summary: CommunitySummary) {
    if (
      !summary ||
      !/^(0|[1-9]\d*)$/.test(String(summary.likes)) ||
      !["open", "paused"].includes(summary.chatState) ||
      typeof summary.chatWritable !== "boolean"
    )
      throw new Error("Invalid public summary");
    if (summary.revision && compareIds(summary.revision, summaryRevision) < 0)
      return;
    if (summary.revision) summaryRevision = summary.revision;
    if (status.textContent === "Loading community activity…")
      setText(status, "");
    count.textContent = `${summary.likes} ${String(summary.likes) === "1" ? "like" : "likes"}`;
    // Keep drafts and recovery available when chat becomes read-only.
    chatForm.dataset.writable = String(summary.chatWritable);
    updateComposer();
    const summaryLabel =
      summary.chatState === "paused"
        ? "Chat is paused by moderation. Existing messages remain visible."
        : summary.chatWritable
          ? "Chat is open during this live event."
          : "Chat is read-only outside the live event.";
    setText(chatState, summaryLabel);
  }

  async function reconcilePending() {
    if (!signedIn || reconciling || publicUnavailable) return;
    const keys = [...state.submissions.values()]
      .filter(
        (record) =>
          Boolean(currentAccountId) &&
          (submissionOwners.get(record) === null ||
            submissionOwners.get(record) === currentAccountId) &&
          !["confirmed", "removed", "rejected", "cooldown"].includes(
            record.state,
          ),
      )
      .map((record) => record.submission.clientMessageId)
      .slice(0, 100);
    if (!keys.length) return;
    reconciling = true;
    const finish = state.beginRequest();
    try {
      const epoch = streamEpoch;
      const account = accountEpoch;
      const items = await api<CommunityMessage[]>(
        `/api/community/events/${id}/chat/submissions?keys=${keys.join(",")}`,
      );
      if (
        epoch !== streamEpoch ||
        account !== accountEpoch ||
        publicUnavailable
      ) {
        scheduleReconciliation();
        return;
      }
      for (const item of items) {
        const record = item.clientMessageId
          ? state.submissions.get(item.clientMessageId)
          : undefined;
        if (record && submissionOwners.get(record) === null)
          submissionOwners.set(record, currentAccountId);
        insertMessage(item, "reconcile");
      }
    } catch {
      /* Uncertainty remains explicit; no automatic send. */
    } finally {
      reconciling = false;
      finish();
    }
  }
  function canRetrySubmission(record: SubmissionRecord) {
    const owner = submissionOwners.get(record);
    return Boolean(currentAccountId && owner === currentAccountId);
  }
  function scheduleReconciliation() {
    window.clearTimeout(reconciliationTimer);
    reconciliationTimer = window.setTimeout(() => void reconcilePending(), 300);
  }

  function readChatPath(path: string) {
    return signedIn ? `${path}${path.includes("?") ? "&" : "?"}own=1` : path;
  }

  function saveAnchor() {
    const top = messages.getBoundingClientRect().top;
    const node = Array.from(
      messages.children as HTMLCollectionOf<HTMLElement>,
    ).find((child) => child.getBoundingClientRect().bottom > top);
    return {
      node,
      id: node?.dataset.messageId,
      // An absent anchor preserves the original NaN offset; it is only read with a node.
      offset: (node?.getBoundingClientRect().top as number) - top,
      scrollTop: messages.scrollTop,
    };
  }

  function restoreAnchor(anchor: ReturnType<typeof saveAnchor>) {
    const node = anchor.node?.isConnected
      ? anchor.node
      : rendered.get(anchor.id!);
    if (node?.isConnected)
      messages.scrollTop +=
        node.getBoundingClientRect().top -
        messages.getBoundingClientRect().top -
        anchor.offset;
    else messages.scrollTop = anchor.scrollTop;
  }

  function messageNode(item: MessageView, record?: SubmissionRecord) {
    const line = element("li", undefined, "community-message");
    const author = element(
      "strong",
      item.authorName || "You",
      "community-message-author",
    );
    const timestamp = element("time");
    const body = element("span", item.body, "community-message-body");
    const content = element("p", undefined, "community-message-content");
    content.append(author, document.createTextNode(" "), body);
    const meta = element("div", undefined, "community-message-meta");
    const delivery = element("span", undefined, "community-message-delivery");
    const actions = element("div", undefined, "community-message-actions");
    meta.append(timestamp, delivery, actions);
    line.append(content, meta);
    if (record) line.dataset.submissionId = record.submission.clientMessageId;
    return line;
  }

  function updateMessageNode(
    line: HTMLLIElement,
    item: MessageView,
    record?: SubmissionRecord,
  ) {
    if (item.id) line.dataset.messageId = item.id;
    const removed = item.state === "removed" || record?.state === "removed";
    const author = line.querySelector<HTMLElement>(
      ".community-message-author",
    )!;
    author.textContent = item.authorName || "You";
    // The debate page colours names from the visit's palette.
    author.dataset.tint = String(authorTint(author.textContent));
    line.querySelector<HTMLElement>(".community-message-body")!.textContent =
      removed ? "Removed by moderation." : item.body;
    const timestamp = line.querySelector<HTMLTimeElement>("time")!;
    const time = (item.createdAt || record?.submission.createdAt)!;
    timestamp.dateTime = time;
    timestamp.textContent = new Date(time).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    timestamp.title = date(time);
    const delivery = line.querySelector<HTMLElement>(
      ".community-message-delivery",
    )!;
    const labels = {
      sending: "Sending…",
      confirmed: "Sent",
      unconfirmed: "Delivery unconfirmed",
      rejected: "Rejected",
      cooldown:
        cooldownUntil > Date.now()
          ? "Waiting for posting allowance"
          : "Ready to retry",
      removed: "Removed",
    };
    delivery.textContent = record
      ? `${labels[record.state]}${record.error ? ` · ${record.error}` : ""}`
      : "";
    line.dataset.delivery = record?.state || "confirmed";
    const actions = line.querySelector<HTMLElement>(
      ".community-message-actions",
    )!;
    const mode = removed
      ? "removed"
      : record && !["sending", "confirmed"].includes(record.state)
        ? "recovery"
        : item.id
          ? "report"
          : "pending";
    if (
      actions.dataset.mode !== mode &&
      !actions.contains(document.activeElement)
    ) {
      actions.replaceChildren();
      actions.dataset.mode = mode;
      if (mode === "recovery") {
        const retry = element("button", "Retry unchanged");
        retry.type = "button";
        retry.dataset.communityRetry = "";
        retry.addEventListener("click", () => {
          if (!canRetrySubmission(record!)) {
            sendStatus.textContent =
              "Sign in to the original account to retry this submission, or recover its text to a new draft and review it before posting.";
            return;
          }
          const attempt = state.retry(record!);
          if (attempt) {
            updateLocal(record!);
            void deliver(record!, attempt);
          }
        });
        const recover = element("button", "Recover to draft");
        recover.type = "button";
        recover.addEventListener("click", () => {
          chatForm.elements.body.value = recoverDraft(
            chatForm.elements.body.value,
            record!,
          );
          recoveredSubmission = canRetrySubmission(record!) ? record! : null;
          // Retire this action until another failure, to prevent accidental duplicate recovery.
          recover.disabled = true;
          sendStatus.textContent = canRetrySubmission(record!)
            ? "Text added to your draft. Sending unchanged recovered text retries its original submission. Editing creates a new submission."
            : "Text added as a new draft. Review it before posting with the current account. The original submission is not retried.";
          chatForm.elements.body.focus();
        });
        actions.append(retry, recover);
      }
      if (mode === "report") {
        const reportButton = element("button", "Report message");
        reportButton.type = "button";
        reportButton.setAttribute("aria-expanded", "false");
        reportButton.addEventListener("click", () => {
          const open = reportButton.getAttribute("aria-expanded") === "true";
          reportButton.setAttribute("aria-expanded", String(!open));
          if (open) line.querySelector<HTMLElement>("form")?.remove();
          else
            line.append(
              reportForm("chat", item.id!, status, () => {
                line.querySelector<HTMLElement>("form")?.remove();
                reportButton.setAttribute("aria-expanded", "false");
                reportButton.focus();
              }),
            );
        });
        actions.append(reportButton);
      }
    }
    actions
      .querySelector<HTMLElement>("[data-community-retry]")
      ?.toggleAttribute(
        "disabled",
        cooldownUntil > Date.now() ||
          (Boolean(record) && !canRetrySubmission(record!)) ||
          ["sending", "confirmed", "removed"].includes(record?.state as string),
      );
  }

  function updateLocal(record: SubmissionRecord) {
    const line = localNodes.get(record.submission.clientMessageId);
    const item = record.serverId
      ? state.server.get(record.serverId)?.item
      : null;
    const follow = nearBottom();
    const anchor = saveAnchor();
    if (line?.isConnected)
      updateMessageNode(line, item || record.submission, record);
    if (follow) messages.scrollTop = messages.scrollHeight;
    else restoreAnchor(anchor);
  }

  function updateComposer() {
    const remaining = Math.max(
      0,
      Math.ceil((cooldownUntil - Date.now()) / 1000),
    );
    chatForm.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!.disabled = remaining > 0 || chatForm.dataset.writable === "false";
    chatRoot.querySelector<HTMLElement>(
      "[data-community-cooldown]",
    )!.textContent = remaining
      ? `Posting allowance resets in ${remaining}s. Your draft stays editable.`
      : "";
    for (const record of state.submissions.values()) {
      if (record.state === "cooldown") updateLocal(record!);
    }
    window.clearTimeout(cooldownTimer);
    if (remaining) cooldownTimer = window.setTimeout(updateComposer, 1000);
  }

  async function deliver(record: SubmissionRecord, attempt: number) {
    const account = accountEpoch;
    const finishRequest = state.beginRequest();
    try {
      const item = await api<CommunityMessage>(
        `/api/community/events/${id}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: record.submission.body,
            clientMessageId: record.submission.clientMessageId,
          }),
        },
      );
      if (account !== accountEpoch) {
        state.fail(
          record,
          attempt,
          new Error(
            "Account changed while delivery was pending. Sign in to the original account to reconcile it, or recover the text to a draft for review.",
          ),
        );
        updateLocal(record);
        return;
      }
      if (item.clientMessageId !== record.submission.clientMessageId)
        throw new Error("Invalid acknowledgment; delivery is unconfirmed.");
      insertMessage(item, "post");
      if (degradedMode) schedule(0);
    } catch (error) {
      if (account !== accountEpoch) {
        state.fail(
          record,
          attempt,
          new Error(
            "Account changed; delivery remains unconfirmed for the original account.",
          ),
        );
        updateLocal(record);
        return;
      }
      if (state.fail(record, attempt, error as DeliveryError)) {
        if (
          (error as DeliveryError).status === 429 &&
          Number.isFinite((error as DeliveryError).retryAfterSeconds!)
        ) {
          cooldownUntil = Math.max(
            cooldownUntil,
            Date.now() + (error as DeliveryError).retryAfterSeconds! * 1000,
          );
          updateComposer();
        }
        updateLocal(record!);
        sendStatus.textContent = `${record.state === "unconfirmed" ? "Delivery unconfirmed. The message may have arrived." : record.state === "cooldown" ? "Posting allowance reached." : "Message rejected."} ${(error as DeliveryError).message} Use the message’s retry or draft recovery actions.`;
        if ((error as DeliveryError).status === 401) {
          const login = element("a", "Sign in to continue");
          login.href = `/account?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
          sendStatus.append(" ", login);
        }
      }
    } finally {
      if (streamHealthy) scheduleReconciliation();
      record.settled = true;
      finishRequest();
    }
  }

  function nearBottom() {
    return (
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 64
    );
  }

  let followResize = true;
  let resizeAnchor: ReturnType<typeof saveAnchor> | undefined;
  let resizeWidth = messages.clientWidth;
  let resizeHeight = messages.clientHeight;
  messages.addEventListener(
    "scroll",
    () => {
      // Native scroll events during a resize are not a change in reader intent.
      if (
        messages.clientWidth !== resizeWidth ||
        messages.clientHeight !== resizeHeight
      )
        return;
      followResize = nearBottom();
      resizeAnchor = saveAnchor();
    },
    { passive: true },
  );
  if (window.ResizeObserver) {
    new window.ResizeObserver(() => {
      if (followResize) messages.scrollTop = messages.scrollHeight;
      else if (resizeAnchor) restoreAnchor(resizeAnchor);
      resizeWidth = messages.clientWidth;
      resizeHeight = messages.clientHeight;
      resizeAnchor = saveAnchor();
    }).observe(messages);
  }

  function showNewCount() {
    newMessages.hidden = unseenCount === 0 && !latestEvicted;
    newMessages.textContent = unseenCount
      ? `${unseenCount} new ${unseenCount === 1 ? "message" : "messages"} · Jump to latest`
      : "Jump to latest";
  }

  function insertMessage(item: CommunityMessage, source = "feed") {
    if (publicUnavailable) return false;
    if (
      source === "post" &&
      item.streamRevision &&
      compareIds(item.streamRevision, resetFence) <= 0 &&
      !state.server.has(item.id)
    ) {
      scheduleReconciliation();
      return false;
    }
    const result = state.receive(item, source);
    const record = result.record;
    const current = result.item;
    tracked.add(current.id);
    if (!result.changed) return false;
    const anchor = saveAnchor();
    const pendingNode =
      record && localNodes.get(record.submission.clientMessageId);
    const serverNode = rendered.get(current.id);
    let node = pendingNode || serverNode;
    if (pendingNode && serverNode && pendingNode !== serverNode)
      serverNode.remove();
    if (
      (record || current.state === "removed") &&
      unseenIds.delete(current.id)
    ) {
      unseenCount = unseenIds.size;
      showNewCount();
    }
    if (current.state === "removed" && !record) {
      node?.remove();
      rendered.delete(current.id);
    } else {
      // A delayed POST cannot bring a row evicted by bounded retention back into view.
      if (!node && source === "post" && !result.confirmedNow) return false;
      messages.querySelector<HTMLElement>("[data-community-empty]")?.remove();
      if (!node) {
        node = messageNode(current, record);
        const next = Array.from(
          messages.children as HTMLCollectionOf<HTMLElement>,
        ).find(
          (child) =>
            !child.dataset.messageId ||
            compareIds(child.dataset.messageId, current.id) > 0,
        );
        messages.insertBefore(node, next || null);
      }
      if (!node.isConnected) messages.append(node);
      updateMessageNode(node, current, record);
      if (current.state === "visible") {
        const next = Array.from(
          messages.children as HTMLCollectionOf<HTMLElement>,
        ).find(
          (child) =>
            child !== node &&
            (!child.dataset.messageId ||
              compareIds(child.dataset.messageId, current.id) > 0),
        );
        if (node.nextElementSibling !== (next || null))
          messages.insertBefore(node, next || null);
      }
      if (current.state === "visible") rendered.set(current.id, node);
      else rendered.delete(current.id);
    }
    restoreAnchor(anchor);
    if (result.confirmedNow && !record!.announced) {
      record!.announced = true;
      sendStatus.textContent =
        current.state === "removed"
          ? "Message accepted earlier and removed by moderation."
          : "Message sent.";
    }
    return result.inserted && current.state === "visible";
  }

  function updateEmpty() {
    if (
      messages.querySelector<HTMLElement>(".community-message")! ||
      messages.querySelector<HTMLElement>("[data-community-empty]")!
    )
      return;
    const empty = element("li", "No chat messages yet.");
    empty.dataset.communityEmpty = "";
    messages.append(empty);
  }

  function trimFeed(shouldFollow: boolean) {
    const anchor = saveAnchor();
    while (rendered.size > 500) {
      const candidates = Array.from(
        messages.children as HTMLCollectionOf<HTMLElement>,
      ).filter((node) => rendered.has(node.dataset.messageId!));
      const head = candidates[0]!;
      const first =
        shouldFollow ||
        (head !== anchor.node &&
          head.getBoundingClientRect().bottom <=
            messages.getBoundingClientRect().top)
          ? head
          : candidates.at(-1);
      if (!first) break;
      if (first === head) older.hidden = false;
      else latestEvicted = true;
      rendered.delete(first.dataset.messageId!);
      tracked.delete(first.dataset.messageId!);
      state.forget(first.dataset.messageId!);
      if (first.dataset.submissionId)
        localNodes.delete(first.dataset.submissionId);
      first.remove();
    }
    if (!shouldFollow) restoreAnchor(anchor);
    const hidden = [...tracked].filter((id) => !rendered.has(id));
    for (const staleId of hidden.slice(
      0,
      Math.max(0, hidden.length - 1000 + rendered.size),
    )) {
      tracked.delete(staleId);
      const record = state.server.get(staleId)?.record;
      if (record?.state === "removed" && record.settled) {
        localNodes.get(record.submission.clientMessageId)?.remove();
        localNodes.delete(record.submission.clientMessageId);
      }
      state.forget(staleId);
    }
    oldest =
      Array.from(messages.children as HTMLCollectionOf<HTMLElement>).find(
        (node) => rendered.has(node.dataset.messageId!),
      )?.dataset.messageId ?? null;
  }

  async function loadOlderChat() {
    if (!oldest || loadingOlder) return;
    loadingOlder = true;
    older.disabled = true;
    const finishRequest = state.beginRequest();
    try {
      const epoch = streamEpoch;
      const page = await api<ChatPage>(
        readChatPath(
          `/api/community/events/${id}/chat?before=${encodeURIComponent(oldest)}`,
        ),
      );
      if (epoch !== streamEpoch || publicUnavailable) return;
      const anchor = saveAnchor();
      for (const item of page.items) insertMessage(item, "history");
      oldest = page.items[0]?.id ?? oldest;
      older.hidden = !page.hasMore;
      restoreAnchor(anchor);
      trimFeed(false);
      showNewCount();
    } catch (error) {
      status.textContent = (error as DeliveryError).message;
    } finally {
      finishRequest();
      older.disabled = false;
      loadingOlder = false;
    }
  }

  function schedule(delay: number) {
    if (!degradedMode || publicUnavailable) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), delay);
  }

  async function poll() {
    if (syncing || !degradedMode || publicUnavailable) return;
    pollController = new AbortController();
    if (document.visibilityState === "hidden") {
      schedule(2000);
      return;
    }
    syncing = true;
    try {
      let more: boolean | undefined = false;
      for (let batch = 0; batch < 20; batch++) {
        const frame = await api<CommunityFrame>(
          `/api/community/events/${id}/updates${stream.cursor ? `?cursor=${encodeURIComponent(stream.cursor)}` : ""}`,
          { signal: pollController.signal },
        );
        if (!degradedMode || publicUnavailable || pollController.signal.aborted)
          return;
        await stream.acceptHttp(frame);
        more = frame.more;
        if (!more) break;
      }
      await reconcilePending();
      if (!degradedMode || publicUnavailable) return;
      setText(connection, "Polling updates on · reconnecting live updates");
      if (status.textContent === "Loading community activity…")
        status.textContent = "Community activity ready.";
      retryDelay = 2000;
      schedule(more ? 0 : 2000);
    } catch (error) {
      if (!degradedMode || publicUnavailable) return;
      if ((error as DeliveryError).status === 404) {
        unavailable();
        return;
      }
      if ((error as DeliveryError).status === 401) signedIn = false;
      setText(connection, "Connection interrupted. Reconnecting…");
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    } finally {
      syncing = false;
    }
  }

  function unavailable() {
    publicUnavailable = true;
    streamEpoch++;
    pollController?.abort();
    recoveryController?.abort();
    window.clearTimeout(timer);
    window.clearTimeout(reconciliationTimer);
    messages.replaceChildren(
      element(
        "li",
        root.dataset.communityDemo === "true"
          ? "Chat is unavailable for this synthetic demo. Real live debates support chat; replays preserve their conversation."
          : "Community activity is unavailable.",
      ),
    );
    rendered.clear();
    tracked.clear();
    localNodes.clear();
    unseenIds.clear();
    unseenCount = 0;
    chatForm.dataset.writable = "false";
    updateComposer();
    older.hidden = true;
    newMessages.hidden = true;
    like.disabled = true;
    count.textContent = "Unavailable";
  }
  let recoveryController: AbortController | undefined;
  async function recoverWatched(
    ids: string[],
    anchor: ReturnType<typeof saveAnchor>,
    epoch: number,
  ) {
    recoveryController?.abort();
    const controller = new AbortController();
    recoveryController = controller;
    const finish = state.beginRequest();
    try {
      for (let index = 0; index < ids.length; index += 200) {
        const page = await api<ChatSyncPage>(
          readChatPath(
            `/api/community/events/${id}/chat/sync?after=9223372036854775807&watch=${ids.slice(index, index + 200).join(",")}`,
          ),
          { signal: controller.signal },
        );
        if (epoch !== streamEpoch || publicUnavailable) return;
        for (const item of [...page.watched, ...(page.removed || [])])
          insertMessage(item, "recovery");
        restoreAnchor(anchor);
        trimFeed(false);
      }
    } catch {
      /* Reset remains redacted; the reader can load current history. */
    } finally {
      finish();
    }
  }
  function applyFrame(frame: CommunityFrame, source: "stream" | "poll") {
    const snapshot = frame.kind === "snapshot" ? frame.snapshot : null;
    if (
      snapshot &&
      (!Array.isArray(snapshot.items) ||
        snapshot.items.length > 10 ||
        typeof snapshot.hasMore !== "boolean")
    )
      throw new Error("Invalid snapshot");
    if (
      !snapshot &&
      (!Array.isArray(frame.changes) || frame.changes.length > 10)
    )
      throw new Error("Invalid changes");
    streamEpoch++;
    const follow = nearBottom();
    const anchor = saveAnchor();
    let added = 0;
    if (snapshot) {
      renderSummary(snapshot.summary);
      resetFence = frame.cursor!.split(":")[2]!;
      const ids = new Set(snapshot.items.map((item) => item.id));
      const watched = [...rendered.keys()]
        .filter((serverId) => !ids.has(serverId))
        .slice(0, 500);
      for (const [serverId, node] of rendered) {
        if (!ids.has(serverId)) {
          state.missing(serverId);
          node.remove();
          rendered.delete(serverId);
        }
      }
      for (const item of snapshot.items) insertMessage(item, "stream");
      oldest = snapshot.items[0]?.id ?? null;
      older.hidden = !snapshot.hasMore;
      state.advance(snapshot.items);
      if (watched.length) void recoverWatched(watched, anchor, streamEpoch);
    } else {
      for (const change of frame.changes!) {
        if (!["message", "summary"].includes(change.type))
          throw new Error("Invalid change");
        renderSummary(change.summary);
        if (change.message && insertMessage(change.message, "stream")) {
          added++;
          if (!follow) unseenIds.add(change.message.id);
        }
      }
    }
    trimFeed(follow);
    updateEmpty();
    if (follow) messages.scrollTop = messages.scrollHeight;
    else restoreAnchor(anchor);
    unseenCount = unseenIds.size;
    showNewCount();
    if (added)
      chatRoot.querySelector<HTMLElement>(
        "[data-community-announcement]",
      )!.textContent = `${added} new chat messages.`;
    streamHealthy = source === "stream";
    scheduleReconciliation();
  }
  const stream = createCommunityStream({
    room: id,
    apply: applyFrame,
    unavailable,
    status: (label) => {
      if (label === "Live updates on") {
        streamHealthy = true;
        if (personalRefreshNeeded) void refreshPersonalLike();
      }
      setText(
        connection,
        root.dataset.communityDemo === "true" &&
          label === "This event is no longer public."
          ? "Demo · read-only"
          : label,
      );
    },
    beforeConnect() {
      personalRefreshNeeded = true;
      pollController?.abort();
      window.clearTimeout(timer);
    },
    degraded(active) {
      const changed = degradedMode !== active;
      degradedMode = active;
      if (active) {
        streamHealthy = false;
        if (changed) schedule(0);
      } else {
        pollController?.abort();
        window.clearTimeout(timer);
      }
    },
  });
  let accountEpoch = 0;
  async function refreshAccount() {
    const epoch = ++accountEpoch;
    personalEpoch++;
    signedIn = false;
    currentAccountId = null;
    recoveredSubmission = null;
    currentLiked = false;
    like.setAttribute("aria-pressed", "false");
    like.textContent = "Like this event";
    for (const record of state.submissions.values()) updateLocal(record);
    try {
      const account = await api<{ user: { id: string } }>("/api/auth/me");
      if (epoch !== accountEpoch) return;
      signedIn = true;
      currentAccountId = account.user.id;
      for (const record of state.submissions.values()) updateLocal(record);
      personalRefreshNeeded = true;
      like.title = "";
      scheduleReconciliation();
      await refreshPersonalLike();
    } catch {
      if (epoch !== accountEpoch) return;
      signedIn = false;
      currentLiked = false;
      like.setAttribute("aria-pressed", "false");
      like.textContent = "Like this event";
      like.title = "Sign in to like this event";
    }
  }
  window.addEventListener("yap:account-changed", () => void refreshAccount());
  void refreshAccount();
  stream.start();
  root
    .querySelector<HTMLElement>("[data-community-refresh]")!
    .addEventListener("click", () => {
      setText(connection, "Checking for messages…");
      if (degradedMode) schedule(0);
      else stream.reconnect();
    });
  older.addEventListener("click", () => void loadOlderChat());
  newMessages.addEventListener("click", () => {
    void (async () => {
      const finishRequest = state.beginRequest();
      try {
        if (latestEvicted) {
          const epoch = streamEpoch;
          const page = await api<ChatPage>(
            readChatPath(`/api/community/events/${id}/chat`),
          );
          if (epoch !== streamEpoch || publicUnavailable) return;
          for (const [serverId, node] of rendered) {
            node.remove();
            tracked.delete(serverId);
            state.forget(serverId);
            if (node.dataset.submissionId)
              localNodes.delete(node.dataset.submissionId);
          }
          rendered.clear();
          for (const item of page.items) insertMessage(item, "history");
          oldest = page.items[0]?.id ?? null;
          older.hidden = !page.hasMore;
          latestEvicted = false;
        }
        messages.scrollTop = messages.scrollHeight;
        unseenCount = 0;
        unseenIds.clear();
        showNewCount();
        messages.focus({ preventScroll: true });
      } catch (error) {
        status.textContent = (error as DeliveryError).message;
      } finally {
        finishRequest();
      }
    })();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") stream.reconnect();
    else {
      stream.suspend();
      pollController?.abort();
      window.clearTimeout(timer);
    }
  });
  window.addEventListener("online", () => stream.reconnect());
  window.addEventListener("offline", () => stream.reconnect());
  window.addEventListener("pagehide", () => stream.suspend());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) stream.reconnect();
  });
  like.addEventListener("click", () => {
    const epoch = accountEpoch;
    like.disabled = true;
    likeWriting = true;
    personalEpoch++;
    void api<{ liked: boolean }>(`/api/community/events/${id}/like`, {
      method: currentLiked ? "DELETE" : "PUT",
    })
      .then((result) => {
        if (epoch !== accountEpoch) return;
        currentLiked = result.liked;
        like.setAttribute("aria-pressed", String(currentLiked));
        like.textContent = currentLiked ? "Remove like" : "Like this event";

        status.textContent = currentLiked ? "Event liked." : "Like removed.";
      })
      .catch((error: unknown) => {
        if (epoch !== accountEpoch) return;
        status.textContent = (error as DeliveryError).message;
        requestAuthentication(error as DeliveryError, like);
      })
      .finally(() => {
        like.disabled = publicUnavailable;
        likeWriting = false;
        void refreshPersonalLike();
      });
  });
  root
    .querySelector<HTMLElement>("[data-community-share]")!
    .addEventListener("click", () => {
      const url = window.location.origin + window.location.pathname;
      if (!navigator.clipboard?.writeText) {
        status.textContent = `Copy this event link: ${url}`;
        return;
      }
      void navigator.clipboard
        .writeText(url)
        .then(() => {
          status.textContent = "Event link copied.";
        })
        .catch(() => {
          status.textContent = `Copy this event link: ${url}`;
        });
    });
  const composer = chatForm.elements.body;
  composer.addEventListener("compositionstart", () => {
    composing = true;
  });
  composer.addEventListener("compositionend", () => {
    composing = false;
  });
  composer.addEventListener("keydown", (event) => {
    if (shouldSendOnEnter(event, composing)) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });
  function clearSubmittedDraft() {
    composer.value = "";
    recoveredSubmission = null;
    sendStatus.textContent = "";
    if (
      document.activeElement === composer ||
      document.activeElement ===
        chatForm.querySelector<HTMLButtonElement>('button[type="submit"]')!
    )
      composer.focus({ preventScroll: true });
  }
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (cooldownUntil > Date.now() || chatForm.dataset.writable === "false")
      return;
    // This reference comes only from explicit recovery; it is never feed text matching.
    if (
      recoveredSubmission &&
      canRetrySubmission(recoveredSubmission) &&
      composer.value.trim() === recoveredSubmission.submission.body
    ) {
      const attempt = state.retry(recoveredSubmission);
      if (!attempt) {
        sendStatus.textContent =
          recoveredSubmission.state === "sending"
            ? "This submission is still sending."
            : recoveredSubmission.state === "removed"
              ? "This submission was accepted and removed. Edit your draft to create a new submission."
              : "This submission is already sent. Edit your draft to create a new submission.";
        return;
      }
      const record = recoveredSubmission;
      clearSubmittedDraft();
      updateLocal(record!);
      void deliver(record!, attempt);
      return;
    }
    const record = state.begin(
      composer.value,
      window.crypto.randomUUID(),
      new Date().toISOString(),
    );
    if (!record) {
      sendStatus.textContent = "Enter a message of 1–500 characters.";
      return;
    }
    submissionOwners.set(record, currentAccountId);
    const follow = nearBottom();
    const anchor = saveAnchor();
    const line = messageNode(record.submission, record);
    updateMessageNode(line, record.submission, record);
    messages.querySelector<HTMLElement>("[data-community-empty]")?.remove();
    messages.append(line);
    localNodes.set(record.submission.clientMessageId, line);
    // Clear only the immutable captured draft, synchronously before network work.
    clearSubmittedDraft();
    if (follow) messages.scrollTop = messages.scrollHeight;
    else restoreAnchor(anchor);
    void deliver(record, record.attempt);
  });
  report.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(
      report,
      async () => {
        await api("/api/community/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "event",
            targetId: id,
            reasonCode: report.elements.reasonCode.value,
            detail: report.elements.detail.value,
          }),
        });
        report.reset();
        status.textContent = "Report submitted privately for review.";
      },
      status,
    );
  });
}

function initMine(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>("[data-community-status]")!;
  const list = root.querySelector<HTMLElement>("[data-community-list]")!;
  async function refresh() {
    try {
      const cases = await api<CommunityCase[]>("/api/community/me/cases");
      list.replaceChildren();
      if (!cases.length)
        list.append(element("p", "No reports or moderation actions yet."));
      for (const item of cases) {
        const card = element("article", undefined, "community-case");
        card.append(
          element("h2", `${item.targetType} report · ${item.status}`),
        );
        card.append(
          element(
            "p",
            `Reason: ${item.reasonCode}. Action: ${item.action || "none"}. ${date(item.createdAt)}`,
          ),
        );
        if (item.detail) card.append(element("p", item.detail));
        if (item.appealStatus)
          card.append(element("p", `Appeal: ${item.appealStatus}`));
        if (item.canAppeal) {
          const form = element("form", undefined, "community-inline-form");
          const reason = noteField();
          form.append(
            labelField("Why should this action be reconsidered?", reason),
            element("button", "Submit appeal"),
          );
          (form.lastChild as HTMLButtonElement).type = "submit";
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            void submit(
              form,
              async () => {
                await api(`/api/community/cases/${item.id}/appeal`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason: reason.value }),
                });
                status.textContent = "Appeal submitted for review.";
                await refresh();
              },
              status,
            );
          });
          card.append(form);
        }
        list.append(card);
      }
      status.textContent = `${cases.length} case${cases.length === 1 ? "" : "s"} shown.`;
    } catch (error) {
      status.textContent = (error as DeliveryError).message;
    }
  }
  root
    .querySelector<HTMLElement>("[data-community-refresh]")!
    .addEventListener("click", () => {
      void refresh();
    });
  void refresh();
}

function initModeration(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>("[data-community-status]")!;
  const casesList = root.querySelector<HTMLElement>("[data-community-cases]")!;
  const appealsList = root.querySelector<HTMLElement>(
    "[data-community-appeals]",
  )!;
  const filter = root.querySelector<HTMLSelectElement>(
    "[data-community-case-filter]",
  )!;
  async function refresh() {
    try {
      const [cases, appeals] = await Promise.all([
        api<CommunityCase[]>(
          `/api/community/moderation/cases?status=${filter.value}`,
        ),
        api<CommunityAppeal[]>("/api/community/moderation/appeals"),
      ]);
      casesList.replaceChildren();
      appealsList.replaceChildren();
      if (!cases.length)
        casesList.append(element("p", "No cases in this state."));
      if (!appeals.length) appealsList.append(element("p", "No open appeals."));
      for (const item of cases) casesList.append(caseCard(item));
      for (const item of appeals) appealsList.append(appealCard(item));
      status.textContent = `${cases.length} cases and ${appeals.length} open appeals shown.`;
    } catch (error) {
      status.textContent = (error as DeliveryError).message;
    }
  }

  function caseCard(item: CommunityCase) {
    const card = element("article", undefined, "community-case");
    card.append(element("h3", `${item.targetType} · ${item.status}`));
    card.append(
      element("p", `Reported ${date(item.createdAt)} · ${item.reasonCode}`),
    );
    card.append(element("p", item.detail));
    if (item.chatBody) card.append(element("blockquote", item.chatBody));
    if (item.action)
      card.append(
        element("p", `Action: ${item.action}. ${item.decisionNote || ""}`),
      );
    const history = element("button", "Show audit history");
    history.type = "button";
    const historyList = element("ol");
    historyList.hidden = true;
    history.addEventListener("click", () => {
      void api<CaseDetail>(`/api/community/moderation/cases/${item.id}`)
        .then((detail) => {
          historyList.replaceChildren(
            ...detail.history.map((entry) =>
              element(
                "li",
                `${date(entry.occurredAt)} · ${entry.action}${entry.note ? ` · ${entry.note}` : ""}`,
              ),
            ),
          );
          historyList.hidden = false;
        })
        .catch((error: unknown) => {
          status.textContent = (error as DeliveryError).message;
        });
    });
    card.append(history, historyList);
    if (item.status === "open") {
      const form = element("form", undefined, "community-inline-form");
      const choices =
        item.targetType === "chat"
          ? ["dismiss", "remove_chat", "restrict_account"]
          : ["dismiss", "pause_chat"];
      const action = selectField(choices, "Choose an action");
      const reason = selectField(reasons, "Choose a reason");
      const note = noteField();
      form.append(
        labelField("Action", action),
        labelField("Reason", reason),
        labelField("Review note", note),
        element("button", "Save decision"),
      );
      (form.lastChild as HTMLButtonElement).type = "submit";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit(
          form,
          async () => {
            await api(`/api/community/moderation/cases/${item.id}/decision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: action.value,
                reasonCode: reason.value,
                note: note.value,
              }),
            });
            status.textContent = "Case decision saved.";
            await refresh();
          },
          status,
        );
      });
      card.append(form);
    }
    if (item.action === "pause_chat" && item.chatState === "paused") {
      const resume = element("form", undefined, "community-inline-form");
      const note = noteField();
      resume.append(
        labelField("Reason to resume chat", note),
        element("button", "Resume event chat"),
      );
      (resume.lastChild as HTMLButtonElement).type = "submit";
      resume.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit(
          resume,
          async () => {
            await api(
              `/api/community/moderation/cases/${item.id}/resume-chat`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note: note.value }),
              },
            );
            status.textContent = "Event chat resumed.";
            await refresh();
          },
          status,
        );
      });
      card.append(resume);
    }
    return card;
  }

  function appealCard(item: CommunityAppeal) {
    const card = element("article", undefined, "community-case");
    card.append(
      element("h3", "Appeal"),
      element("p", `Case ${item.caseId} · ${date(item.createdAt)}`),
      element("blockquote", item.reason),
    );
    const form = element("form", undefined, "community-inline-form");
    const decision = selectField(["upheld", "overturned"], "Choose a decision");
    const note = noteField();
    form.append(
      labelField("Decision", decision),
      labelField("Review note", note),
      element("button", "Save appeal decision"),
    );
    (form.lastChild as HTMLButtonElement).type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit(
        form,
        async () => {
          await api(`/api/community/moderation/appeals/${item.id}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decision: decision.value,
              note: note.value,
            }),
          });
          status.textContent = "Appeal decision saved.";
          await refresh();
        },
        status,
      );
    });
    card.append(form);
    return card;
  }
  root
    .querySelector<HTMLElement>("[data-community-refresh]")!
    .addEventListener("click", () => {
      void refresh();
    });
  filter.addEventListener("change", () => {
    void refresh();
  });
  void refresh();
}

const eventRoot = document.querySelector<HTMLElement>(
  "[data-community-event]",
)!;
if (eventRoot) initEvent(eventRoot);
const mineRoot = document.querySelector<HTMLElement>("[data-community-mine]")!;
if (mineRoot) initMine(mineRoot);
const moderatorRoot = document.querySelector<HTMLElement>(
  "[data-community-moderation]",
)!;
if (moderatorRoot) initModeration(moderatorRoot);
