// Live topic queue in the browser (Decision 0011): the header pill, the 30-second match dialog,
// the topic page's queue buttons and the banner above a matched debate's video. The header loads
// this module on pages with data-matchmaking. State arrives over the player's live stream, with
// polling when the stream is unavailable; the server decides every outcome.
import { api } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import {
  bannerText,
  clockOffset,
  isJoining,
  isQueued,
  needsLiveUpdates,
  pillDescription,
  pillText,
  secondsUntil,
  shouldOpenDebate,
  transitionNotice,
  waitingText,
  type QueueState,
  type Side,
  type Waiting,
} from "./matchmaking-logic.js";

declare global {
  interface WindowEventMap {
    "yap:matchmaking": CustomEvent<QueueState | null>;
  }
}

const POLL_MS = 3000;
const WAITING_MS = 10_000;
const store = sessionStore();
const pageTitle = document.title;
let member = false;
let state: QueueState | null = null;
let offset = 0;
let source: EventSource | null = null;
let streamUnavailable = false;
let poll: number | undefined;
let ticker: number | undefined;
let audio: AudioContext | undefined;
let alertedOffer: string | null = null;
let generation = 0;
let deviceCheckRequired = true;

const now = () => Date.now() + offset;
const status = document.querySelector<HTMLElement>("[data-header-status]");
function announce(message: string) {
  if (status) status.textContent = message;
  if (panelNote) panelNote.textContent = message;
}

// ---- Header pill -------------------------------------------------------------------------
const memberActions = document.querySelector<HTMLElement>(
  "[data-header-member]",
);
const pill = document.createElement("div");
pill.className = "queue-pill";
pill.hidden = true;
const pillLabel = document.createElement("a");
pillLabel.className = "queue-pill-label";
const pillLeave = document.createElement("button");
pillLeave.type = "button";
pillLeave.className = "small-button";
pillLeave.textContent = "Leave";
pill.append(pillLabel, pillLeave);
memberActions?.prepend(pill);
pillLeave.addEventListener("click", () => void leave());

// ---- Match dialog ------------------------------------------------------------------------
const dialog = document.createElement("dialog");
dialog.className = "match-dialog";
dialog.setAttribute("aria-labelledby", "match-dialog-title");
const dialogTitle = document.createElement("h2");
dialogTitle.id = "match-dialog-title";
dialogTitle.textContent = "Match found";
const dialogTopic = document.createElement("p");
dialogTopic.className = "match-dialog-topic";
const dialogSide = document.createElement("p");
const countdown = document.createElement("p");
countdown.className = "match-countdown";
const dialogStatus = document.createElement("p");
dialogStatus.className = "form-note";
dialogStatus.setAttribute("role", "status");
const acceptButton = document.createElement("button");
acceptButton.type = "button";
acceptButton.className = "button";
acceptButton.textContent = "Accept";
const declineButton = document.createElement("button");
declineButton.type = "button";
declineButton.className = "small-button";
declineButton.textContent = "Decline";
const dialogActions = document.createElement("div");
dialogActions.className = "match-dialog-actions";
dialogActions.append(acceptButton, declineButton);
dialog.append(
  dialogTitle,
  dialogTopic,
  dialogSide,
  countdown,
  dialogStatus,
  dialogActions,
);
document.body.append(dialog);
// Escape would hide the dialog but not answer it; the countdown answers for the player.
dialog.addEventListener("cancel", (event) => event.preventDefault());
acceptButton.addEventListener("click", () => void answer("accept"));
declineButton.addEventListener("click", () => void answer("decline"));

// ---- Topic page ----------------------------------------------------------------------------
const panel = document.querySelector<HTMLElement>("[data-queue-topic]");
const panelTopic = panel?.dataset.queueTopic ?? null;
const panelNote =
  panel?.querySelector<HTMLElement>("[data-queue-note]") ?? null;
const panelWaiting =
  panel?.querySelector<HTMLElement>("[data-queue-waiting]") ?? null;
const sideButtons = new Map<Side, HTMLButtonElement>();
for (const button of panel?.querySelectorAll<HTMLButtonElement>(
  "[data-queue-side]",
) ?? []) {
  const side = button.dataset.queueSide;
  if (side !== "A" && side !== "B") continue;
  button.dataset.queueLabel = button.textContent ?? "";
  sideButtons.set(side, button);
  button.addEventListener("click", () => void choose(side, button));
}

// ---- Debate page banner ------------------------------------------------------------------
const banner = document.querySelector<HTMLElement>("[data-queue-banner]");
const pageSlug = /^\/debates\/([^/]+)$/.exec(location.pathname)?.[1] ?? "";

// ---- State --------------------------------------------------------------------------------
function apply(next: QueueState) {
  const previous = state;
  offset = clockOffset(next, Date.now());
  state = next;
  const notice = transitionNotice(previous, next);
  if (notice) announce(notice);
  if (next.offer && next.offer.id !== alertedOffer) {
    alertedOffer = next.offer.id;
    alertMatch(next);
  }
  if (shouldOpenDebate(previous, next, location.pathname) && next.debate)
    location.assign(`/debates/${encodeURIComponent(next.debate.slug)}`);
  render();
  connect();
  window.dispatchEvent(new CustomEvent("yap:matchmaking", { detail: next }));
}

async function refresh() {
  const current = generation;
  try {
    const result = await api<{ state: QueueState }>(
      "/api/matchmaking/presence",
      { method: "POST", timeout: 8000 },
    );
    if (current === generation) apply(result.state);
  } catch {
    // The next poll or stream message retries.
  }
}

function stopPolling() {
  if (poll !== undefined) window.clearInterval(poll);
  poll = undefined;
}

// A live stream while queued or joining; polling if the stream is unavailable, and during the
// join window, whose debate status the stream does not carry.
function connect() {
  if (!member || !needsLiveUpdates(state)) {
    source?.close();
    source = null;
    stopPolling();
    return;
  }
  if (!source && !streamUnavailable && "EventSource" in window) {
    const opened = new EventSource("/api/matchmaking/stream");
    source = opened;
    opened.addEventListener("state", (event) => {
      if (source === opened)
        apply(JSON.parse((event as MessageEvent<string>).data) as QueueState);
    });
    opened.addEventListener("error", () => {
      if (opened.readyState !== EventSource.CLOSED || source !== opened) return;
      source = null;
      streamUnavailable = true;
      connect();
    });
  }
  if (streamUnavailable || !source || isJoining(state)) {
    poll ??= window.setInterval(() => void refresh(), POLL_MS);
  } else stopPolling();
}

// ---- Drawing ------------------------------------------------------------------------------
function render() {
  const text = member ? pillText(state, now(), pageSlug) : null;
  pill.hidden = text === null;
  if (text) {
    pillLabel.textContent = text;
    pillLabel.title = pillDescription(state);
    const joining = isJoining(state) && state?.debate;
    pillLabel.href = joining
      ? `/debates/${encodeURIComponent(joining.slug)}`
      : `/topics/${encodeURIComponent(state?.ticket?.topicSlug ?? "")}`;
    pillLeave.hidden = !isQueued(state);
  }
  renderDialog();
  renderPanel();
  if (banner) {
    const message = bannerText(state, pageSlug, now());
    banner.hidden = message === null;
    banner.textContent = message ?? "";
  }
  const ticking = Boolean(member && needsLiveUpdates(state));
  if (ticking && ticker === undefined) ticker = window.setInterval(render, 500);
  if (!ticking && ticker !== undefined) {
    window.clearInterval(ticker);
    ticker = undefined;
  }
  flashTitle();
}

function renderDialog() {
  const offer = state?.offer;
  if (!offer || !state?.ticket) {
    if (dialog.open) dialog.close();
    return;
  }
  dialogTopic.textContent = state.ticket.topicTitle;
  dialogSide.textContent = `You argue: ${state.ticket.sideLabel}`;
  const left = secondsUntil(offer.deadlineAt, now());
  countdown.textContent = left ? `${left}` : "Time's up";
  acceptButton.disabled = offer.acceptedByMe || !left;
  declineButton.disabled = !left;
  dialogStatus.textContent = offer.acceptedByMe
    ? offer.acceptedByOpponent
      ? "Both accepted. Opening your debate…"
      : "You accepted. Waiting for the other player…"
    : offer.acceptedByOpponent
      ? "The other player accepted."
      : "Accept within 30 seconds.";
  if (!dialog.open) {
    dialog.showModal();
    acceptButton.focus();
  }
}

function renderPanel() {
  if (!panel || !panelTopic) return;
  const ticket = isQueued(state) ? state?.ticket : null;
  for (const [side, button] of sideButtons) {
    const mine = ticket?.topicSlug === panelTopic && ticket.side === side;
    button.textContent = mine
      ? "Leave queue"
      : (button.dataset.queueLabel ?? "");
    button.setAttribute("aria-pressed", String(mine));
    button.disabled = Boolean(ticket && !mine);
  }
}

// ---- Alerts -------------------------------------------------------------------------------
// Created on the click that enters the queue, so browsers allow the sound later.
function prepareAlerts() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = undefined;
  }
  if ("Notification" in window && Notification.permission === "default")
    void Notification.requestPermission();
}

function beep() {
  if (!audio || audio.state !== "running") return;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.4);
  tone.connect(gain).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 0.45);
}

function alertMatch(next: QueueState) {
  beep();
  if (
    document.hidden &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const notice = new Notification("Match found on YAP Arena", {
      body: `${next.ticket?.topicTitle ?? "Your debate"} · accept within 30 seconds`,
      tag: "yaparena-match",
    });
    notice.addEventListener("click", () => window.focus());
  }
}

function flashTitle() {
  document.title =
    state?.offer && document.hidden && Math.floor(Date.now() / 1000) % 2
      ? "Match found!"
      : pageTitle;
}

// ---- Actions ------------------------------------------------------------------------------
async function answer(choice: "accept" | "decline") {
  const offer = state?.offer;
  if (!offer) return;
  acceptButton.disabled = true;
  declineButton.disabled = true;
  try {
    apply(
      (
        await api<{ state: QueueState }>(
          `/api/matchmaking/offers/${encodeURIComponent(offer.id)}/${choice}`,
          { method: "POST", timeout: 8000 },
        )
      ).state,
    );
  } catch (error) {
    dialogStatus.textContent =
      error instanceof Error ? error.message : "Try again.";
    void refresh();
  }
}

async function leave() {
  try {
    apply(
      (
        await api<{ state: QueueState }>("/api/matchmaking/tickets/current", {
          method: "DELETE",
          timeout: 8000,
        })
      ).state,
    );
  } catch (error) {
    announce(error instanceof Error ? error.message : "Try again.");
  }
}

// The debate needs a working camera and microphone, so check before queueing.
async function checkDevices() {
  if (!deviceCheckRequired) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    announce("Allow your camera and microphone to debate, then try again.");
    return false;
  }
  await api("/api/media/device-check", {
    method: "POST",
    json: { cameraOk: true, microphoneOk: true },
    timeout: 8000,
  });
  return true;
}

async function choose(side: Side, button: HTMLButtonElement) {
  if (!member) {
    const returnTo = location.pathname + location.search;
    if (
      window.dispatchEvent(
        new CustomEvent("yap:request-auth", {
          cancelable: true,
          detail: { returnTo, source: button },
        }),
      )
    )
      location.assign(`/account?next=${encodeURIComponent(returnTo)}`);
    return;
  }
  if (!panelTopic) return;
  if (state?.ticket && isQueued(state) && state.ticket.side === side)
    return leave();
  prepareAlerts();
  for (const entry of sideButtons.values()) entry.disabled = true;
  announce("Checking your camera and microphone…");
  try {
    if (!(await checkDevices())) return;
    apply(
      (
        await api<{ state: QueueState }>("/api/matchmaking/tickets", {
          method: "POST",
          json: { topicSlug: panelTopic, side },
          timeout: 8000,
        })
      ).state,
    );
    announce("You're in the queue. Stay on YAP Arena to be matched.");
    void loadWaiting();
  } catch (error) {
    announce(error instanceof Error ? error.message : "Try again.");
  } finally {
    renderPanel();
  }
}

async function loadWaiting() {
  if (!panel || !panelTopic || !panelWaiting || !member) return;
  try {
    const { waiting } = await api<{ waiting: Waiting }>(
      `/api/matchmaking/topics/${encodeURIComponent(panelTopic)}/waiting`,
      { timeout: 8000 },
    );
    const labels = [...sideButtons.values()].map(
      (button) => button.dataset.queueLabel?.replace(/^Queue for /, "") ?? "",
    );
    panelWaiting.textContent = waitingText(
      waiting,
      labels[0] ?? "Side A",
      labels[1] ?? "Side B",
    );
  } catch {
    panelWaiting.textContent = "";
  }
}

// ---- Account ------------------------------------------------------------------------------
async function initialize() {
  const current = ++generation;
  source?.close();
  source = null;
  streamUnavailable = false;
  stopPolling();
  state = null;
  member = false;
  render();
  try {
    member = Boolean(await store.me());
  } catch {
    member = false;
  }
  if (current !== generation) return;
  if (!member) {
    if (panelWaiting) panelWaiting.textContent = "Sign in to queue on a side.";
    return render();
  }
  try {
    const result = await api<{
      state: QueueState;
      deviceCheckRequired: boolean;
    }>("/api/matchmaking/me", { timeout: 8000 });
    if (current !== generation) return;
    deviceCheckRequired = result.deviceCheckRequired;
    apply(result.state);
  } catch {
    render();
  }
  void loadWaiting();
}

window.addEventListener("yap:account-changed", () => void initialize());
document.addEventListener("visibilitychange", () => {
  flashTitle();
  if (!document.hidden && member && needsLiveUpdates(state)) void refresh();
});
if (panel)
  window.setInterval(() => {
    if (!document.hidden) void loadWaiting();
  }, WAITING_MS);
void initialize();
