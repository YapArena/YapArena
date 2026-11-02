// The queue overlay (docs/queue-overlay.md): one full-screen native <dialog>
// for the whole queue. While the player waits, the landing emblem runs its
// living bursts above "Finding other humans…" and a rotating quote; on a
// match it turns into the 30-second accept countdown in place, with both
// players' cards. frontend/matchmaking.ts loads this module on first use and
// decides when it shows; the rules live in frontend/queue-overlay-logic.ts.
import { api } from "./lib/api.js";
import type { Profile } from "./account-types.js";
import { pickHeadlineColors } from "./landing-colors.js";
import {
  secondsUntil,
  type ClosedReason,
  type QueueState,
} from "./matchmaking-logic.js";
import {
  createEmblem,
  createLivingEmblem,
  emblemTiles,
  type EmblemColors,
  type EmblemTile,
} from "./pixel-emblem.js";
import {
  HEADLINES,
  QUOTE_HOLD_MS,
  QUOTE_OUT_MS,
  canQueueAgain,
  cardsView,
  headlineIndex,
  holeView,
  initials,
  matchClock,
  matchStatus,
  motionPlan,
  pickQuote,
  quoteAuthor,
  topicSide,
  type OverlayPhase,
} from "./queue-overlay-logic.js";
import { QUOTES } from "./queue-quotes.js";
import {
  SPENT_OPACITY,
  clockFrame,
  frameKey,
  tileLook,
  type TileLook,
} from "./turn-clock-logic.js";

export interface OverlayActions {
  fold(): void;
  leave(): void;
  accept(): void;
  decline(): void;
  queueAgain(): void;
  close(): void;
}

export interface OverlayView {
  phase: OverlayPhase;
  /** The latest state, or the one the ticket closed with. */
  state: QueueState;
  /** The server's time (this device's clock plus the offset). */
  now: number;
  /** When this page saw the offer arrive (performance.now()); null on a late open. */
  offerSeenAt: number | null;
  closed: { reason: ClosedReason | null; message: string } | null;
}

type Offer = NonNullable<QueueState["offer"]>;

const interactive =
  "a[href], button, input, select, textarea, summary, [contenteditable]";
/** "Both accept" relights the spent tiles clockwise over this long. */
const ENTER_REFILL_MS = 400;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function hiddenText(text = "") {
  return element("span", "sr-only", text);
}
function shown(text = "") {
  const node = element("span", "", text);
  node.setAttribute("aria-hidden", "true");
  return node;
}
function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

export function createQueueOverlay(actions: OverlayActions) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  // A new set of five landing colours on every visit, as on the landing page.
  const colors = pickHeadlineColors();
  const palette = [
    colors.debates.css,
    colors.opinions.css,
    colors.ideas.css,
    colors.discussions.css,
    colors.yappers.css,
  ];
  const logoSrc = new URL("landing/yaparena-logo.png", import.meta.url).href;
  const emblemSrc = new URL("landing/yaparena-emblem.png", import.meta.url)
    .href;

  // ---- Markup --------------------------------------------------------------------------------
  const dialog = element("dialog", "queue-overlay");
  dialog.setAttribute("aria-labelledby", "queue-overlay-title");
  dialog.setAttribute("aria-describedby", "queue-overlay-status");
  dialog.style.setProperty("--visit-yappers", colors.yappers.css);

  const top = element("div", "qo-top");
  const logo = element("img", "qo-logo");
  logo.src = logoSrc;
  logo.width = 575;
  logo.height = 151;
  logo.alt = "YAP Arena";
  const topic = element("p", "qo-topic");
  const sideSpoken = hiddenText();
  const sideShown = shown();
  const sideWords = document.createTextNode("");
  const sideLabel = element("b");
  sideShown.append(sideWords, " ", sideLabel);
  const sideLine = element("span", "qo-topic-side");
  sideLine.append(sideSpoken, sideShown);
  const topicTitle = element("span", "qo-topic-title");
  topic.append(sideLine, " ", topicTitle);
  top.append(logo, topic);

  const stage = element("div", "qo-stage");
  const glow = element("div", "qo-glow");
  const aura = element("canvas", "qo-aura");
  const mark = element("img", "qo-mark");
  mark.src = emblemSrc;
  mark.width = 2048;
  mark.height = 1715;
  mark.alt = "";
  const bloom = element("canvas", "qo-bloom");
  const cores = element("canvas", "qo-cores");
  const ringAura = element("canvas", "qo-ring-aura");
  const ringBloom = element("canvas", "qo-ring-bloom");
  const ringCanvas = element("canvas", "qo-ring");
  for (const canvas of [aura, bloom, cores, ringAura, ringBloom, ringCanvas])
    canvas.setAttribute("aria-hidden", "true");
  glow.append(aura, mark, bloom, cores, ringAura, ringBloom, ringCanvas);
  const holeNumber = element("span", "qo-hole-number");
  holeNumber.setAttribute("role", "timer");
  const holeLabel = shown();
  holeLabel.className = "qo-hole-label";
  const hole = element("div", "qo-hole");
  hole.append(holeNumber, holeLabel);
  stage.append(glow, hole);
  const emblemCell = element("div", "qo-emblem");
  emblemCell.append(stage);

  const head = element("h2", "qo-head");
  head.id = "queue-overlay-title";
  const headSpoken = hiddenText();
  const track = shown();
  track.className = "qo-track";
  HEADLINES.forEach(({ lines }, index) => {
    const item = element("span", "qo-item");
    lines.forEach((line, at) => {
      if (at) item.append(" ");
      item.append(element("span", "qo-line", line));
    });
    // The waiting headline's three dots pulse in turn.
    if (index === 0) {
      const dots = element("span", "qo-dots");
      for (let dot = 0; dot < 3; dot++) dots.append(element("span", "", "."));
      item.lastElementChild?.append(dots);
    }
    track.append(item);
  });
  head.append(headSpoken, track);

  const body = element("div", "qo-body");
  const quote = element("figure", "qo-quote");
  const quoteText = element("blockquote");
  const quoteSpoken = hiddenText();
  const quoteWords = shown();
  quoteWords.className = "qo-words";
  quoteText.append(quoteSpoken, quoteWords);
  const caption = element("figcaption");
  const whoSpoken = hiddenText();
  const whoShown = shown();
  const who = element("span", "qo-who");
  who.append(whoSpoken, whoShown);
  const whoSlot = element("span", "qo-qw");
  whoSlot.append(who);
  const source = element("span", "qo-source");
  const sourceSlot = element("span", "qo-qw");
  sourceSlot.append(source);
  caption.append(whoSlot, sourceSlot);
  quote.append(quoteText, caption);

  function card(mine: boolean) {
    const root = element("div", "qo-card");
    const letters = shown();
    letters.className = "qo-initials";
    const name = element("strong");
    const handle = element("span", "qo-handle");
    const state = element("span", "qo-state");
    const block = element("span", "qo-who-block");
    block.append(name, handle, state);
    const side = element("span", `qo-side ${mine ? "qo-mine" : "qo-theirs"}`);
    root.append(letters, block, side);
    return { root, letters, name, handle, state, side };
  }
  const meCard = card(true);
  const themCard = card(false);
  meCard.name.textContent = "You";
  const versus = shown();
  versus.className = "qo-vs";
  versus.textContent = "vs";
  const players = element("div", "qo-players");
  players.append(meCard.root, versus, themCard.root);
  const match = element("div", "qo-match");
  match.hidden = true;
  match.append(players);
  const closedText = element("p", "qo-closed");
  closedText.hidden = true;
  const status = element("p", "qo-status");
  status.id = "queue-overlay-status";
  status.setAttribute("role", "status");
  body.append(quote, match, closedText, status);
  const alertRegion = element("p", "sr-only");
  alertRegion.setAttribute("role", "alert");
  const politeRegion = element("p", "sr-only");
  politeRegion.setAttribute("role", "status");

  function button(label: string, kind: string, action: () => void) {
    const node = element("button", `qo-button ${kind}`, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function row(...buttons: HTMLButtonElement[]) {
    const node = element("div", "qo-row");
    node.append(...buttons);
    return node;
  }
  const foldButton = button("Keep browsing", "qo-quiet", actions.fold);
  const leaveButton = button("Leave queue", "qo-outline", actions.leave);
  const acceptButton = button("Accept", "qo-primary", actions.accept);
  const declineButton = button("Decline", "qo-outline", actions.decline);
  const againButton = button("Queue again", "qo-primary", actions.queueAgain);
  const closeButton = button("Close", "qo-outline", actions.close);
  const waitRow = row(foldButton, leaveButton);
  const matchRow = row(acceptButton, declineButton);
  const closedRow = row(againButton, closeButton);
  const actionsBlock = element("div", "qo-actions");
  actionsBlock.append(waitRow, matchRow, closedRow);

  const center = element("div", "qo-center");
  center.append(
    emblemCell,
    head,
    body,
    alertRegion,
    politeRegion,
    actionsBlock,
  );
  dialog.append(top, center);
  document.body.append(dialog);

  // ---- State ---------------------------------------------------------------------------------
  let phase: OverlayPhase | null = null;
  let view: OverlayView | null = null;
  let lastOffer: Offer | null = null;
  let ticketId: string | null = null;
  let paused = false;
  let answering = false;
  let errorNote = "";
  let waitingNote = "";
  let alertedOffer: string | null = null;
  let warnedOffer: string | null = null;
  let quoteTimer: number | undefined;
  let cardsTimer: number | undefined;
  let quoteIndex = -1;
  let quoteRemaining: number[] = [];
  let quotesShown = 0;
  let enteredAt = 0;
  let spentAtEnter = 0;
  let lastSpent = 0;
  let frame = 0;
  let drawn = "";
  let me: Pick<Profile, "handle" | "displayName"> | null = null;
  // When the view's server time was taken, to keep counting between updates.
  let paintedAt = Date.now();
  let ringPalette: EmblemColors | null = null;
  let profileRequest: Promise<void> | null = null;

  const living = createLivingEmblem(stage, { logo: mark, cores, bloom, aura });
  living.setActive(false);
  let ring: ReturnType<typeof createEmblem> | null = null;
  let tiles: readonly EmblemTile[] | null = null;
  void emblemTiles(emblemSrc)
    .then((found) => {
      tiles = found;
      ensureRing();
    })
    .catch(() => {
      // The still emblem stays; the number and text still count down.
    });

  function ensureRing() {
    if (ring || !tiles || !dialog.open) return;
    ring = createEmblem(ringCanvas, {
      mode: "countdown",
      tiles,
      glow: [ringBloom, ringAura],
    });
    drawn = "";
    kick();
  }
  new ResizeObserver(() => {
    if (ring?.resize()) drawn = "";
    kick();
  }).observe(ringCanvas);

  // The colours the debate page's turn clock uses, read once.
  function ringColors(): EmblemColors {
    ringPalette ??= {
      lit: "#f8f8f8",
      warn:
        getComputedStyle(dialog).getPropertyValue("--warning").trim() ||
        "#ff8a5c",
      ember: colors.yappers.css,
      spent: "#ffffff",
      rest: "#ffffff",
    };
    return ringPalette;
  }

  // ---- Drawing -------------------------------------------------------------------------------
  // "reveal" is the landing's clip wipe; "soft" fades controls in, so they are clickable at once.
  function reveal(target: HTMLElement, delay: number, kind = "reveal") {
    target.classList.remove("reveal", "soft");
    target.style.setProperty("--reveal-delay", `${delay}s`);
    void target.offsetWidth;
    target.classList.add(kind);
  }
  function setHead(index: number) {
    track.style.transform = index
      ? `translateY(calc(var(--qo-pitch) * ${-index}))`
      : "";
    setText(headSpoken, HEADLINES[index]?.spoken ?? "");
  }
  function showRow(which: HTMLElement) {
    for (const entry of [waitRow, matchRow, closedRow])
      entry.hidden = entry !== which;
  }
  function announce(region: HTMLElement, text: string) {
    region.textContent = "";
    requestAnimationFrame(() => {
      region.textContent = text;
    });
  }

  function paintTopic(state: QueueState) {
    const ticket = state.ticket;
    if (!ticket) return;
    const side = topicSide(ticket.sideLabel);
    setText(sideSpoken, side.spoken);
    if (sideWords.data !== side.shown) sideWords.data = side.shown;
    setText(sideLabel, side.side);
    setText(topicTitle, ticket.topicTitle);
    topicTitle.title = ticket.topicTitle;
  }

  // Quotes: words rise out of a clipping slot, then the next quote's rise in.
  function paintQuote(direction: "in" | "out") {
    const entry = QUOTES[quoteIndex] ?? QUOTES[0]!;
    quote.classList.remove("in", "out");
    if (direction === "in") {
      const words = entry.text.split(" ");
      quoteWords.replaceChildren(
        ...words.map((word, index) => {
          const slot = element("span", "qo-qw");
          const inner = element("span", "", word);
          inner.style.setProperty(
            "--word-delay",
            `${(index * 0.035).toFixed(3)}s`,
          );
          slot.append(inner);
          return slot;
        }),
      );
      setText(quoteSpoken, entry.text);
      setText(whoSpoken, entry.author);
      setText(whoShown, quoteAuthor(entry.author));
      who.style.color = palette[quotesShown % palette.length] ?? "";
      const after = `${(words.length * 0.035 + 0.15).toFixed(3)}s`;
      who.style.setProperty("--word-delay", after);
      setText(source, entry.source);
      source.style.setProperty("--word-delay", after);
    } else {
      quoteWords
        .querySelectorAll<HTMLElement>(".qo-qw > span")
        .forEach((word, index) =>
          word.style.setProperty(
            "--word-delay",
            `${(index * 0.012).toFixed(3)}s`,
          ),
        );
      who.style.setProperty("--word-delay", "0s");
      source.style.setProperty("--word-delay", "0s");
    }
    void quote.offsetWidth;
    quote.classList.add(direction);
  }
  function nextQuote() {
    const next = pickQuote(
      quoteRemaining,
      quoteIndex,
      QUOTES.length,
      Math.random,
    );
    quoteIndex = next.index;
    quoteRemaining = next.remaining;
  }
  function stopQuotes() {
    window.clearTimeout(quoteTimer);
    quoteTimer = undefined;
  }
  function runQuotes() {
    stopQuotes();
    if (!motionPlan(reduce.matches).rotateQuotes || paused) return;
    if (phase !== "waiting" || !dialog.open) return;
    quoteTimer = window.setTimeout(() => {
      paintQuote("out");
      quoteTimer = window.setTimeout(() => {
        nextQuote();
        quotesShown++;
        paintQuote("in");
        runQuotes();
      }, QUOTE_OUT_MS);
    }, QUOTE_HOLD_MS);
  }

  function paintCard(
    target: ReturnType<typeof card>,
    lit: boolean,
    state: string,
  ) {
    target.root.classList.toggle("lit", lit);
    setText(target.state, state);
    target.state.classList.toggle("qo-accepted", state === "Accepted");
  }
  function paintPeople(offer: Offer, sideLabelText: string) {
    const them = offer.opponent;
    setText(themCard.name, them.displayName ?? "Your opponent");
    setText(themCard.handle, them.handle ? `@${them.handle}` : "");
    themCard.handle.hidden = !them.handle;
    setText(themCard.letters, initials(them.displayName));
    setText(themCard.side, them.sideLabel);
    setText(meCard.side, sideLabelText);
    setText(meCard.handle, me ? `@${me.handle}` : "");
    meCard.handle.hidden = !me;
    setText(meCard.letters, me ? initials(me.displayName) : "Y");
  }
  function loadProfile() {
    profileRequest ??= api<{ profile: Profile }>("/api/me/profile", {
      timeout: 8000,
    })
      .then(({ profile }) => {
        me = { handle: profile.handle, displayName: profile.displayName };
        if (lastOffer && view?.state.ticket)
          paintPeople(lastOffer, view.state.ticket.sideLabel);
      })
      .catch(() => {
        profileRequest = null;
      });
  }

  // The time in the hole, the cards, the buttons and the status line.
  function paint() {
    if (!view || !phase) return;
    const now = view.now + (Date.now() - paintedAt);
    const hole = holeView(phase, view.state, now);
    setText(holeNumber, hole.number);
    if (holeNumber.getAttribute("aria-label") !== hole.name)
      holeNumber.setAttribute("aria-label", hole.name);
    setText(holeLabel, hole.label);
    holeNumber.classList.toggle("qo-warm", hole.warm);
    const offer = view.state.offer ?? (phase === "entering" ? lastOffer : null);
    if ((phase === "match" || phase === "entering") && offer) {
      const cards = cardsView(offer, phase === "entering", now);
      paintCard(meCard, cards.me.lit, cards.me.state);
      paintCard(themCard, cards.them.lit, cards.them.state);
      match.classList.toggle("qo-warm", cards.warm);
      const left = secondsUntil(offer.deadlineAt, now) > 0;
      acceptButton.disabled =
        answering || offer.acceptedByMe || !left || phase === "entering";
      declineButton.disabled = answering || !left || phase === "entering";
      setText(acceptButton, offer.acceptedByMe ? "Accepted" : "Accept");
      setText(status, errorNote || matchStatus(offer, phase === "entering"));
      if (cards.warm && warnedOffer !== offer.id) {
        warnedOffer = offer.id;
        announce(politeRegion, "10 seconds left to accept.");
      }
    } else if (phase === "waiting") setText(status, waitingNote);
    // Closed: the reason is in the body; the line shows how Queue again is going.
    else setText(status, errorNote || waitingNote);
  }

  // ---- The ring ------------------------------------------------------------------------------
  function ringLook(now: number): {
    key: string;
    pulse: number;
    look: (tile: EmblemTile) => TileLook;
  } | null {
    if (!view) return null;
    const reduced = reduce.matches;
    if (phase === "entering") {
      const progress = reduced
        ? 1
        : Math.min(1, (performance.now() - enteredAt) / ENTER_REFILL_MS);
      return {
        key: `enter:${Math.floor(progress * 60)}`,
        pulse: 1,
        look: (tile) =>
          tile.angle <= progress || tile.angle >= spentAtEnter
            ? { kind: "lit", opacity: 1 }
            : { kind: "spent", opacity: SPENT_OPACITY },
      };
    }
    const offer = view.state.offer;
    if (phase !== "match" || !offer) return null;
    const sinceStart =
      view.offerSeenAt === null
        ? null
        : (performance.now() - view.offerSeenAt) / 1000;
    const frameState = clockFrame(
      matchClock(offer.deadlineAt, now, reduced, sinceStart),
    );
    lastSpent = frameState.spent;
    return {
      key: `${frameKey(frameState)}:${reduced ? 1 : 0}`,
      pulse: frameState.pulse,
      look: (tile) => tileLook(tile.angle, frameState, reduced),
    };
  }
  function animate() {
    frame = 0;
    if (!dialog.open || document.hidden) return;
    if (phase !== "match" && phase !== "entering") return;
    paint();
    const now = (view?.now ?? Date.now()) + (Date.now() - paintedAt);
    const current = ringLook(now);
    if (current && ring) {
      glow.style.opacity = current.pulse < 1 ? String(current.pulse) : "";
      if (current.key !== drawn) {
        drawn = current.key;
        ring.draw(current.look, ringColors());
      }
    }
    frame = requestAnimationFrame(animate);
  }
  function kick() {
    if (!frame) frame = requestAnimationFrame(animate);
  }
  function stopRing() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    glow.style.opacity = "";
  }

  // ---- Phases --------------------------------------------------------------------------------
  function setPhaseClass(next: OverlayPhase) {
    dialog.classList.remove(
      "is-waiting",
      "is-match",
      "is-entering",
      "is-closed",
    );
    dialog.classList.add(`is-${next}`);
    stage.classList.toggle(
      "is-counting",
      next === "match" || next === "entering",
    );
    stage.classList.toggle("is-full", next === "entering");
  }

  function toWaiting(previous: OverlayPhase | null) {
    window.clearTimeout(cardsTimer);
    stopRing();
    match.hidden = true;
    closedText.hidden = true;
    quote.hidden = false;
    showRow(waitRow);
    if (previous === "match" || previous === "entering") {
      nextQuote();
      quotesShown++;
      reveal(waitRow, 0.1, "soft");
    }
    paintQuote("in");
    foldButton.focus();
    living.setPaused(paused);
    living.setActive(true);
    runQuotes();
  }

  function toMatch(offer: Offer, opening: boolean) {
    living.setActive(false);
    stopQuotes();
    errorNote = "";
    waitingNote = "";
    const plan = motionPlan(reduce.matches);
    if (!opening && !quote.hidden) paintQuote("out");
    showRow(matchRow);
    reveal(matchRow, 0.3, "soft");
    acceptButton.focus();
    window.clearTimeout(cardsTimer);
    const showCards = () => {
      if (phase !== "match" && phase !== "entering") return;
      quote.hidden = true;
      closedText.hidden = true;
      match.hidden = false;
      reveal(match, 0);
    };
    if (opening) showCards();
    else cardsTimer = window.setTimeout(showCards, plan.revealCardsAfter);
    if (alertedOffer !== offer.id) {
      alertedOffer = offer.id;
      announce(alertRegion, "Match found. Accept within 30 seconds.");
    }
    ensureRing();
    // The ring measured 0×0 while the overlay was folded away; measure it again now it shows.
    ring?.resize();
    drawn = "";
    kick();
  }

  function toEntering() {
    enteredAt = performance.now();
    spentAtEnter = lastSpent;
    drawn = "";
    announce(politeRegion, "Both accepted. Opening your debate.");
    kick();
  }

  function toClosed(closed: NonNullable<OverlayView["closed"]>) {
    window.clearTimeout(cardsTimer);
    errorNote = "";
    waitingNote = "";
    stopRing();
    stopQuotes();
    living.setActive(false);
    quote.hidden = true;
    match.hidden = true;
    closedText.hidden = false;
    setText(closedText, closed.message);
    reveal(closedText, 0.1);
    againButton.hidden = !canQueueAgain(closed.reason);
    showRow(closedRow);
    reveal(closedRow, 0.2, "soft");
    (againButton.hidden ? closeButton : againButton).focus();
    announce(politeRegion, closed.message);
  }

  function open() {
    dialog.showModal();
    for (const [target, delay] of [
      [top, 0],
      [stage, 0.04],
      [head, 0.08],
      [quote, 0.16],
    ] as const)
      reveal(target, delay);
    reveal(actionsBlock, 0.25, "soft");
    loadProfile();
    ensureRing();
  }

  // ---- Input ---------------------------------------------------------------------------------
  dialog.addEventListener("cancel", (event) => {
    // Escape folds the waiting screen and closes the closed one; a match can't be dismissed.
    event.preventDefault();
    if (phase === "waiting") actions.fold();
    else if (phase === "closed") actions.close();
  });
  // Space pauses the bursts, the quotes and the dots, as on the landing page (WCAG 2.2.2),
  // unless a control has focus. Reduced motion and Keep browsing also stop the motion.
  document.addEventListener("keydown", (event) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !dialog.open ||
      phase !== "waiting"
    )
      return;
    if (event.target instanceof Element && event.target.closest(interactive))
      return;
    event.preventDefault();
    paused = !paused;
    dialog.classList.toggle("is-paused", paused);
    living.setPaused(paused);
    if (paused) stopQuotes();
    else runQuotes();
    announce(politeRegion, paused ? "Animation paused." : "Animation resumed.");
  });
  reduce.addEventListener("change", () => {
    drawn = "";
    if (phase === "waiting") runQuotes();
    kick();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopRing();
    else {
      drawn = "";
      kick();
    }
  });

  return {
    get phase() {
      return dialog.open ? phase : null;
    },
    /** Shows the view, opening the dialog and moving between phases as needed. */
    update(next: OverlayView) {
      const opening = !dialog.open;
      const previous = opening ? null : phase;
      view = next;
      paintedAt = Date.now();
      if (next.state.offer) lastOffer = next.state.offer;
      // A new ticket starts a new round of quotes.
      const id = next.state.ticket?.id ?? null;
      if (id && id !== ticketId) {
        ticketId = id;
        quoteIndex = -1;
        quoteRemaining = [];
        quotesShown = 0;
        nextQuote();
      }
      if (opening) open();
      paintTopic(next.state);
      if (opening || next.phase !== phase) {
        phase = next.phase;
        setPhaseClass(next.phase);
        setHead(headlineIndex(next.phase, next.closed?.reason ?? null));
        if (next.phase === "waiting") toWaiting(previous);
        else if (next.phase === "match" && next.state.offer)
          toMatch(next.state.offer, opening);
        else if (next.phase === "entering") toEntering();
        else if (next.phase === "closed" && next.closed) toClosed(next.closed);
      }
      if (lastOffer && next.state.ticket)
        paintPeople(lastOffer, next.state.ticket.sideLabel);
      paint();
    },
    /** Hides the dialog and stops all motion; the player's place in the queue is unchanged. */
    hide() {
      window.clearTimeout(cardsTimer);
      stopQuotes();
      stopRing();
      living.setActive(false);
      if (dialog.open) dialog.close();
      phase = null;
    },
    /** A notice for the waiting screen's status line (read out, not shown). */
    note(text: string) {
      waitingNote = text;
      paint();
    },
    /** Accept and Decline stay disabled while an answer is being sent. */
    setAnswering(value: boolean) {
      answering = value;
      if (value) errorNote = "";
      paint();
    },
    /** An answer failed: say why under the cards until the next try. */
    showError(text: string) {
      errorNote = text;
      paint();
    },
  };
}

export type QueueOverlay = ReturnType<typeof createQueueOverlay>;
