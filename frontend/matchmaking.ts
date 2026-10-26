// Live queue and challenges in the browser (Decision 0011): the header pill, the 30-second match
// dialog, the "now" challenge dialog, the topic page's queue buttons and the banner above a
// matched or booked debate's video. The header loads this module on pages with data-matchmaking.
// A signed-in player keeps a live stream open, which also marks them online for "now"
// challenges; polling takes over when the stream is unavailable. The server decides every outcome.
import { api } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import { userStream } from "./lib/user-stream.js";
import {
  bannerText,
  bookedBannerText,
  challengeNotice,
  clock,
  clockOffset,
  dueDebate,
  isAnswering,
  isJoining,
  isQueued,
  needsLiveUpdates,
  pillDescription,
  pillHref,
  pillText,
  secondsUntil,
  shouldOpenDebate,
  transitionNotice,
  untilReminder,
  waitingText,
  type QueueState,
  type Side,
  type Waiting,
} from "./matchmaking-logic.js";
import { needsDebaterSettings, showSettingsPrompt } from "./settings-prompt.js";

declare global {
  interface WindowEventMap {
    "yap:matchmaking": CustomEvent<QueueState | null>;
    // The player's challenges or queue changed on the server (a live stream message).
    "yap:matching-changed": Event;
  }
}

const POLL_MS = 3000;
// Without a live stream, an idle player still checks in for "now" challenges.
const IDLE_POLL_MS = 30_000;
const WAITING_MS = 10_000;
const store = sessionStore();
const pageTitle = document.title;
let member = false;
let state: QueueState | null = null;
let offset = 0;
// The page's shared personal stream (frontend/lib/user-stream.ts) carries "state" events.
const stream = userStream();
let unsubscribe: (() => void) | null = null;
let poll: number | undefined;
let pollEvery = 0;
let ticker: number | undefined;
let reminderTimer: number | undefined;
let alertedChallenge: string | null = null;
// An incoming challenge the player chose to answer later, from the Match page.
let deferredChallenge: string | null = null;
// A challenge this player answered or withdrew here, which needs no notice from the server.
let settledChallenge: string | null = null;
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
// A refusal for missing debater settings links to them; other errors show their message.
function announceError(error: unknown) {
  const message = error instanceof Error ? error.message : "Try again.";
  announce(message);
  if (panelNote && needsDebaterSettings(error))
    showSettingsPrompt(panelNote, message);
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
pillLeave.addEventListener(
  "click",
  () => void (isQueued(state) ? leave() : withdrawChallenge()),
);

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

// ---- "Now" challenge dialog --------------------------------------------------------------
const challengeDialog = document.createElement("dialog");
challengeDialog.className = "match-dialog";
challengeDialog.setAttribute("aria-labelledby", "challenge-dialog-title");
const challengeTitle = document.createElement("h2");
challengeTitle.id = "challenge-dialog-title";
challengeTitle.textContent = "Debate now?";
const challengeFrom = document.createElement("p");
const challengeTopic = document.createElement("p");
challengeTopic.className = "match-dialog-topic";
const challengeSide = document.createElement("p");
const challengeCountdown = document.createElement("p");
challengeCountdown.className = "match-countdown";
const challengeStatus = document.createElement("p");
challengeStatus.className = "form-note";
challengeStatus.setAttribute("role", "status");
const challengeAccept = document.createElement("button");
challengeAccept.type = "button";
challengeAccept.className = "button";
challengeAccept.textContent = "Accept";
const challengeDecline = document.createElement("button");
challengeDecline.type = "button";
challengeDecline.className = "small-button";
challengeDecline.textContent = "Decline";
const challengeLater = document.createElement("button");
challengeLater.type = "button";
challengeLater.className = "small-button";
challengeLater.textContent = "Later";
const challengeActions = document.createElement("div");
challengeActions.className = "match-dialog-actions";
challengeActions.append(challengeAccept, challengeDecline, challengeLater);
challengeDialog.append(
  challengeTitle,
  challengeFrom,
  challengeTopic,
  challengeSide,
  challengeCountdown,
  challengeStatus,
  challengeActions,
);
document.body.append(challengeDialog);
// Escape and Later hide the dialog; the challenge stays open on the Match page.
challengeDialog.addEventListener("cancel", () => {
  deferredChallenge = state?.challenge?.id ?? null;
});
challengeLater.addEventListener("click", () => {
  deferredChallenge = state?.challenge?.id ?? null;
  challengeDialog.close();
});
challengeAccept.addEventListener("click", () => void answerChallenge(true));
window.addEventListener("yap:challenge-settled", (event) => {
  settledChallenge = event.detail;
});
challengeDecline.addEventListener("click", () => void answerChallenge(false));

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
  const notice =
    transitionNotice(previous, next) ??
    (previous?.challenge?.id === settledChallenge
      ? null
      : challengeNotice(previous, next, now()));
  if (notice) announce(notice);
  if (next.offer && next.offer.id !== alertedOffer) {
    alertedOffer = next.offer.id;
    alertMatch(next);
  }
  const incoming =
    next.challenge?.direction === "incoming" ? next.challenge : null;
  if (incoming && incoming.id !== alertedChallenge) {
    alertedChallenge = incoming.id;
    alertChallenge(incoming.handle, incoming.topicTitle);
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
  pollEvery = 0;
}

// A signed-in player keeps a live stream open. Polling replaces it when it is unavailable, quickly
// while queued, joining or answering and every 30 seconds otherwise, and also runs during the
// join window, whose debate status the stream does not carry.
function connect() {
  if (!member) {
    unsubscribe?.();
    unsubscribe = null;
    stopPolling();
    return;
  }
  if (!unsubscribe && stream.available)
    unsubscribe = stream.on("state", (data) => {
      apply(data as QueueState);
      window.dispatchEvent(new Event("yap:matching-changed"));
    });
  const busy = needsLiveUpdates(state) || isAnswering(state, now());
  const every =
    !unsubscribe || !stream.available
      ? busy
        ? POLL_MS
        : IDLE_POLL_MS
      : isJoining(state)
        ? POLL_MS
        : 0;
  if (every !== pollEvery) stopPolling();
  if (every && poll === undefined) {
    poll = window.setInterval(() => void refresh(), every);
    pollEvery = every;
  }
}

stream.onUnavailable(() => {
  unsubscribe = null;
  connect();
});

// ---- Drawing ------------------------------------------------------------------------------
function render() {
  const text = member ? pillText(state, now(), pageSlug) : null;
  pill.hidden = text === null;
  if (text) {
    pillLabel.textContent = text;
    pillLabel.title = pillDescription(state);
    pillLabel.href = pillHref(state, now());
    const outgoing =
      !isQueued(state) &&
      state?.challenge?.direction === "outgoing" &&
      isAnswering(state, now());
    pillLeave.hidden = !isQueued(state) && !outgoing;
    pillLeave.textContent = outgoing ? "Cancel" : "Leave";
  }
  renderDialog();
  renderChallengeDialog();
  renderPanel();
  if (banner) {
    const message =
      bannerText(state, pageSlug, now()) ??
      bookedBannerText(state, pageSlug, now());
    banner.hidden = message === null;
    banner.textContent = message ?? "";
  }
  const ticking = Boolean(
    member &&
    (needsLiveUpdates(state) ||
      isAnswering(state, now()) ||
      dueDebate(state, now())),
  );
  if (ticking && ticker === undefined) ticker = window.setInterval(render, 500);
  if (!ticking && ticker !== undefined) {
    window.clearInterval(ticker);
    ticker = undefined;
  }
  // Wake up when a booked debate's reminder opens.
  window.clearTimeout(reminderTimer);
  const wait = member ? untilReminder(state, now()) : null;
  reminderTimer =
    wait === null
      ? undefined
      : window.setTimeout(render, Math.min(wait, 2 ** 31 - 1));
  flashTitle();
}

function renderChallengeDialog() {
  const challenge =
    member && state?.challenge?.direction === "incoming"
      ? state.challenge
      : null;
  const left = challenge ? secondsUntil(challenge.respondBy, now()) : 0;
  if (!challenge || !left || deferredChallenge === challenge.id) {
    if (challengeDialog.open) challengeDialog.close();
    return;
  }
  challengeFrom.textContent = `${challenge.displayName} (@${challenge.handle}) challenges you to debate now.`;
  challengeTopic.textContent = challenge.topicTitle;
  challengeSide.textContent = `You argue: ${challenge.sideLabel}`;
  challengeCountdown.textContent = clock(left);
  if (!challengeDialog.open) {
    challengeStatus.textContent =
      "Accept to start now. Later keeps the challenge on the Match page.";
    challengeAccept.disabled = false;
    challengeDecline.disabled = false;
    challengeDialog.showModal();
    challengeAccept.focus();
  }
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

function alertChallenge(handle: string, topicTitle: string) {
  beep();
  if (
    document.hidden &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const notice = new Notification(`@${handle} challenges you to debate now`, {
      body: `${topicTitle} · answer within 2 minutes`,
      tag: "yaparena-challenge",
    });
    notice.addEventListener("click", () => window.focus());
  }
}

function flashTitle() {
  const flash = state?.offer
    ? "Match found!"
    : state?.challenge?.direction === "incoming" && isAnswering(state, now())
      ? "Challenge!"
      : null;
  document.title =
    flash && document.hidden && Math.floor(Date.now() / 1000) % 2
      ? flash
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

async function answerChallenge(accept: boolean) {
  const challenge = state?.challenge;
  if (!challenge) return;
  challengeAccept.disabled = true;
  challengeDecline.disabled = true;
  settledChallenge = challenge.id;
  try {
    if (accept) {
      const { event } = await api<{ event: { slug: string } }>(
        `/api/matching/requests/${encodeURIComponent(challenge.id)}/accept`,
        { method: "POST", json: {}, timeout: 8000 },
      );
      challengeStatus.textContent = "Accepted. Opening your debate…";
      location.assign(`/debates/${encodeURIComponent(event.slug)}`);
      return;
    }
    await api(
      `/api/matching/requests/${encodeURIComponent(challenge.id)}/declined`,
      { method: "POST", timeout: 8000 },
    );
    deferredChallenge = challenge.id;
    announce("Challenge declined.");
    void refresh();
  } catch (error) {
    settledChallenge = null;
    const message = error instanceof Error ? error.message : "Try again.";
    if (needsDebaterSettings(error))
      showSettingsPrompt(challengeStatus, message);
    else challengeStatus.textContent = message;
    challengeAccept.disabled = false;
    challengeDecline.disabled = false;
  }
}

async function withdrawChallenge() {
  const challenge = state?.challenge;
  if (!challenge) return;
  settledChallenge = challenge.id;
  try {
    await api(
      `/api/matching/requests/${encodeURIComponent(challenge.id)}/withdrawn`,
      { method: "POST", timeout: 8000 },
    );
    announce("Challenge withdrawn.");
    void refresh();
  } catch (error) {
    settledChallenge = null;
    announce(error instanceof Error ? error.message : "Try again.");
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
    announceError(error);
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
  unsubscribe?.();
  unsubscribe = null;
  // A new account needs a new stream with its own session.
  stream.reset();
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
  if (!document.hidden && member) void refresh();
});
if (panel)
  window.setInterval(() => {
    if (!document.hidden) void loadWaiting();
  }, WAITING_MS);
void initialize();
