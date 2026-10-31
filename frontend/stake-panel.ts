// The debate betting panel (Decision 0013): "Do you agree?" with Yes and No,
// one position per turn window, placed live or from the replay. The server
// keeps every rule; this controller shows the current window, the viewer's
// terms and receipts, and never shows side totals before the reveal.
import { api, apiErrorStatus, apiFetch } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import { formatCoins } from "./lib/coin-format.js";
import { claimWelcome, spendable, type CoinSummary } from "./lib/coins.js";
import { watchRoom } from "./community-stream.js";
import {
  ceilingCents,
  ceilingText,
  clock,
  lastPosition,
  liveWindow,
  parseCeiling,
  parseDefaults,
  parseSize,
  percent,
  placementError,
  positionStatus,
  price,
  readFromLimit,
  reasonText,
  repeatLabel,
  replayRound,
  replayWindow,
  reservedAtoms,
  resultLine,
  resultsHeading,
  resultsSummary,
  secondsLeft,
  signedCoins,
  speakerLine,
  ticketTerms,
  type PublicWindow,
  type PublicWindows,
  type StakeRound,
  type StakeSide,
} from "./stake-model.js";
interface Target {
  window: PublicWindow | null;
  round: StakeRound | null;
  id: string;
  turnNumber: number;
  side: "A" | "B";
  closesAt: string;
  opensAt: string;
  via: "live" | "replay";
}

// These selectors refer to the panel's fixed server-rendered markup.
const root = document.querySelector<HTMLElement>("[data-stake-panel]");
if (root) {
  const one = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const debateId = root.dataset.debateId!;
  const speakers = { A: root.dataset.speakerA!, B: root.dataset.speakerB! };
  const labels = { A: root.dataset.sideA!, B: root.dataset.sideB! };
  const turnBar = one("[data-stake-turn]");
  const turnTitle = one("[data-stake-turn-title]");
  const turnClock = one("[data-stake-clock]");
  const progress = one("[data-stake-progress]");
  const meta = one("[data-stake-meta]");
  const status = one("[data-stake-status]");
  const sideButtons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-stake-side]"),
  ];
  const ticket = one<HTMLFormElement>("[data-stake-ticket]");
  const sizeInput = one<HTMLInputElement>(
    '[data-stake-ticket] input[name="size"]',
  );
  const readInput = one<HTMLInputElement>(
    '[data-stake-ticket] input[name="read"]',
  );
  const readOut = one("[data-stake-read-out]");
  const ceilingNote = one("[data-stake-ceiling]");
  const advanced = one<HTMLDetailsElement>("[data-stake-advanced]");
  const ceilingInput = one<HTMLInputElement>(
    '[data-stake-ticket] input[name="ceiling"]',
  );
  const reviewChoice = one<HTMLInputElement>("[data-stake-review-choice]");
  const errorLine = one("[data-stake-error]");
  const confirm = one<HTMLButtonElement>("[data-stake-confirm]");
  const receipt = one("[data-stake-receipt]");
  const balanceLine = one("[data-stake-balance]");
  const signIn = one("[data-stake-signin]");
  const positionsWrap = one<HTMLDetailsElement>("[data-stake-positions-wrap]");
  const positionsList = one("[data-stake-positions]");
  const positionsCount = one("[data-stake-positions-count]");
  const repeat = one<HTMLButtonElement>("[data-stake-repeat]");
  const ready = one<HTMLFormElement>("[data-stake-ready]");
  const readySize = one<HTMLInputElement>(
    '[data-stake-ready] input[name="size"]',
  );
  const readyRead = one<HTMLInputElement>(
    '[data-stake-ready] input[name="read"]',
  );
  const readyReadOut = one("[data-stake-ready-read-out]");
  const readyNote = one("[data-stake-ready-note]");
  const results = one("[data-stake-results]");
  const resultsTitle = one("[data-stake-results-title]");
  const resultsList = one("[data-stake-results-list]");
  const review = one<HTMLDialogElement>("[data-stake-review]");
  const reviewTerms = one("[data-stake-review-terms]");
  const term = (name: string) => one(`[data-stake-term="${name}"]`);

  const store = sessionStore();
  let windows: PublicWindows | null = null;
  let unavailable = false;
  let rounds: StakeRound[] = [];
  let signedIn: boolean | null = null;
  let summary: CoinSummary | null = null;
  let serverOffset = 0;
  let side: StakeSide | null = null;
  let size = 10;
  let busy = false;
  let closedTurn: number | null = null;
  let playback: { positionSeconds: number; playing: boolean } | null = null;
  let generation = 0;
  let roomLive = false;
  let refreshTimer: number | undefined;
  let loadFailed = false;
  let explaining = false;
  // The window the review pop-up shows; "Place it" places only on it.
  let reviewed: { id: string; turnNumber: number } | null = null;
  // Revealed positions last seen, so a new reveal updates every balance.
  let revealedSeen: number | null = null;
  const keys = new Map<string, string>();
  const key = (scope: string) => {
    let value = keys.get(scope);
    if (!value) keys.set(scope, (value = crypto.randomUUID()));
    return value;
  };
  const now = () => Date.now() + serverOffset;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  // Per-device conveniences only; the panel works without storage.
  const stored = (name: string) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  };
  const remember = (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Private windows may refuse storage; the choice lasts for this page.
    }
  };
  reviewChoice.checked = stored("yaparena-stake-review") === "1";
  // The ticket's size and its chips move together.
  function applySize(value: number) {
    size = value;
    sizeInput.value = String(value);
    for (const chip of root!.querySelectorAll<HTMLButtonElement>(
      "[data-stake-size]",
    ))
      chip.setAttribute(
        "aria-pressed",
        String(Number(chip.dataset.stakeSize) === value),
      );
  }
  function applyReadySize(value: number) {
    readySize.value = String(value);
    for (const chip of root!.querySelectorAll<HTMLButtonElement>(
      "[data-stake-ready-size]",
    ))
      chip.setAttribute(
        "aria-pressed",
        String(Number(chip.dataset.stakeReadySize) === value),
      );
  }
  // "Get ready" defaults saved on this device open every ticket.
  const defaultsKey = "yaparena-stake-defaults";
  const defaults = parseDefaults(stored(defaultsKey));
  if (defaults) {
    applySize(defaults.size);
    readInput.value = String(defaults.read);
    applyReadySize(defaults.size);
    readyRead.value = String(defaults.read);
    readyReadOut.textContent = `${defaults.read}%`;
  }

  async function coinApi<T>(
    path: string,
    method = "GET",
    json?: unknown,
    idempotencyKey?: string,
  ) {
    return api<T>(`/api/coin-sandbox${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(method !== "GET" && summary
          ? { "X-YapArena-Session": summary.sessionId }
          : {}),
      },
      ...(json === undefined ? {} : { json }),
      timeout: 15000,
    });
  }

  async function loadWindows() {
    const response = await apiFetch(
      `/api/public/debates/${encodeURIComponent(debateId)}/windows`,
      { cache: "no-store", timeout: 10000 },
    );
    if (response.status === 404) {
      unavailable = true;
      windows = null;
      return;
    }
    if (!response.ok) throw new Error("Turn windows unavailable");
    const value: PublicWindows = await response.json();
    unavailable = false;
    windows = value;
    serverOffset = Date.parse(value.serverNow) - Date.now();
    // Item d: the chart shows revealed windows from this same public read,
    // for signed-in and signed-out viewers alike.
    window.dispatchEvent(
      new CustomEvent("yap:stake-windows", {
        detail: { debateId, windows: value.windows },
      }),
    );
  }
  async function loadPrivate(current: number) {
    if (!signedIn) return;
    let value = await coinApi<CoinSummary>("/summary");
    if (current !== generation) return;
    summary = value;
    // Decision 0013: Yap Coins are always on; the first visit claims the
    // welcome grant.
    if (!value.initialized && !value.financialReviewRequired) {
      value = await claimWelcome(value, 15000);
      if (current !== generation) return;
      summary = value;
    }
    const view = await coinApi<StakeRound[]>(
      `/debates/${encodeURIComponent(debateId)}/rounds`,
    );
    if (current !== generation) return;
    rounds = view;
    // A reveal changes the balance everywhere on the page.
    const revealed = resultsSummary(view).revealed.length;
    if (revealedSeen !== null && revealed > revealedSeen)
      window.dispatchEvent(new Event("yap:coins-changed"));
    revealedSeen = revealed;
  }
  async function refresh(full = false) {
    const current = generation;
    try {
      if (full || signedIn === null) {
        const user = await store.me().catch((error: unknown) => {
          if (apiErrorStatus(error) === 403) return null;
          throw error;
        });
        if (current !== generation) return;
        signedIn = Boolean(user);
      }
      await loadWindows();
      if (current !== generation) return;
      await loadPrivate(current).catch((error: unknown) => {
        // A disabled coin sandbox (404) leaves only the public view.
        if (apiErrorStatus(error) === 404) summary = null;
        else throw error;
      });
      if (current === generation) loadFailed = false;
    } catch {
      if (current === generation) loadFailed = true;
    }
    if (current === generation) render();
  }

  // The window the viewer would answer now: the live turn's window, or on a
  // five-day replay the window of the turn that's playing.
  function target(): Target | null {
    if (!windows) return null;
    const live = liveWindow(windows.windows, now());
    if (live) {
      const round = rounds.find((item) => item.id === live.id) ?? null;
      return {
        window: live,
        round,
        id: live.id,
        turnNumber: live.turnNumber,
        side: live.side,
        closesAt: live.closesAt,
        opensAt: live.opensAt,
        via: "live",
      };
    }
    if (!playback || windows.eventStatus === "live") return null;
    // The public list names the playing turn for everyone; the signed-in
    // view adds this viewer's eligibility and order for it.
    const playing = replayWindow(
      windows.windows,
      playback.positionSeconds,
      now(),
    );
    if (!playing) return null;
    const round =
      rounds.find((item) => item.id === playing.id) ??
      replayRound(rounds, playback.positionSeconds);
    return {
      window: playing,
      round,
      id: playing.id,
      turnNumber: playing.turnNumber,
      side: playing.side,
      closesAt: playing.closesAt,
      opensAt: playing.opensAt,
      via: "replay",
    };
  }
  function cents() {
    const manual = advanced.open ? parseCeiling(ceilingInput.value) : null;
    return manual ?? ceilingCents(side ?? "YES", Number(readInput.value));
  }
  // The most a position pays per contract: its limit is on the yes scale.
  function paidCents(own: NonNullable<StakeRound["own"]>) {
    const limit = Math.round(Number(own.limit) * 100);
    return own.side === "YES" ? limit : 100 - limit;
  }
  function sideName(value: StakeSide) {
    return value === "YES" ? "Yes" : "No";
  }
  function resultsText(round: StakeRound | null) {
    const at = round?.revealAt ?? windows?.revealAt ?? null;
    return at ? when(at) : "5 days after the debate ends";
  }

  function renderTurn(current: Target | null) {
    const eventStatus = windows?.eventStatus ?? root!.dataset.debateStatus;
    if (current) {
      turnBar.hidden = false;
      const left = secondsLeft(current.closesAt, now());
      const span = Math.max(
        1,
        Date.parse(current.closesAt) - Date.parse(current.opensAt),
      );
      const remaining = Math.max(
        0,
        Math.min(100, ((Date.parse(current.closesAt) - now()) / span) * 100),
      );
      turnTitle.textContent =
        current.via === "replay"
          ? `Replay · turn ${current.turnNumber} · ${speakerLine(current.side, speakers, labels)}`
          : `Turn ${current.turnNumber} · ${speakerLine(current.side, speakers, labels)}`;
      turnClock.textContent = current.via === "live" ? clock(left) : "";
      turnClock.classList.toggle(
        "is-ending",
        current.via === "live" && left <= 10,
      );
      progress.hidden = current.via !== "live";
      progress.setAttribute("aria-valuenow", String(Math.round(remaining)));
      progress.setAttribute("aria-valuetext", `${left} seconds left`);
      progress.style.setProperty("--stake-left", `${remaining}%`);
      const count = current.round?.participants;
      meta.textContent =
        current.via === "replay"
          ? `Your answer goes to the window of the turn that's playing. Open until ${resultsText(current.round)}.`
          : count === undefined
            ? ""
            : `${count.toLocaleString()} ${count === 1 ? "person" : "people"} in this window`;
      return;
    }
    turnBar.hidden = eventStatus !== "live";
    progress.hidden = true;
    turnClock.textContent = "";
    if (eventStatus === "live") {
      turnTitle.textContent = "Between turns";
      meta.textContent = "The next window opens when the next speaker starts.";
    }
  }
  function statusText(current: Target | null) {
    const eventStatus = windows?.eventStatus ?? root!.dataset.debateStatus;
    if (loadFailed)
      return "Couldn't load this debate's Yap Coins rounds. They refresh automatically.";
    if (!current && closedTurn !== null && side)
      return `Turn ${closedTurn}'s window closed before you confirmed. Nothing was reserved.`;
    if (explaining && side && current)
      return "How it works: answer for this turn, then set how much you'll risk. Each contract pays the final share of people who answered your way, up to 1 YC. Final once placed.";
    if (unavailable) return "Yap Coins rounds aren't open on this debate.";
    if (eventStatus === "cancelled" || eventStatus === "void_review")
      return "This debate isn't taking answers. Any Yap Coins you placed are refunded.";
    if (eventStatus === "scheduled" || eventStatus === "ready") {
      const start = root!.dataset.scheduledAt;
      return `Windows open when the debate starts${start ? `, ${when(start)}` : ""}: one per speaking turn, 60 seconds each.`;
    }
    if (current) {
      if (signedIn && !summary)
        return "Yap Coins aren't available on this site right now.";
      if (
        signedIn &&
        current.round &&
        !current.round.eligibility.canTakePosition
      )
        return current.round.own
          ? ""
          : reasonText(current.round.eligibility.reason);
      return "";
    }
    if (eventStatus === "live") return "";
    const closeAt = windows?.revealAt;
    if (
      windows?.revealMode === "five_day" &&
      (!closeAt || Date.parse(closeAt) > now())
    )
      return playback
        ? "You can join the window for the turn that's playing."
        : "Play the replay to answer the turn that's playing.";
    return "Answers for this debate are closed.";
  }
  function joinable(current: Target | null): current is Target {
    // (A replay window needs the signed-in view's eligibility before it
    // takes an answer; the next refresh brings it.)
    return (
      current !== null &&
      (signedIn === false ||
        (summary !== null &&
          (current.round
            ? current.round.eligibility.canTakePosition
            : current.via === "live")))
    );
  }
  function renderTicket(current: Target | null) {
    const open = joinable(current);
    for (const button of sideButtons) {
      button.disabled = busy || !open;
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stakeSide === side),
      );
    }
    const showTicket = Boolean(open && signedIn && side);
    ticket.hidden = !showTicket;
    if (!showTicket || !side || !current) return;
    const value = cents();
    const terms = ticketTerms(size, value);
    readOut.textContent = `${readInput.value}%`;
    ceilingNote.textContent = `You'll pay at most ${price(value)} per contract.`;
    term("reserved").textContent = terms.reserved;
    term("lose").textContent = terms.mostYouCanLose;
    term("back").textContent =
      `${size} × final ${sideName(side).toLowerCase()} share`;
    term("results").textContent =
      current.round?.revealMode === "per_round" ||
      windows?.revealMode === "per_round"
        ? "When this turn's window closes"
        : resultsText(current.round);
    // "Reserved now" must fit the balance before the confirm tap.
    const short = shortfall();
    if (short) errorLine.textContent = short;
    else if (errorLine.dataset.shortfall === "true") errorLine.textContent = "";
    errorLine.dataset.shortfall = String(Boolean(short));
    confirm.disabled = busy || Boolean(short);
    confirm.textContent = `${
      closedTurn !== null && closedTurn !== current.turnNumber
        ? `Use for turn ${current.turnNumber} · `
        : "Place "
    }${sideName(side)} · ${size} · max ${terms.mostYouCanLose}`;
  }
  function renderReceipt(current: Target | null) {
    const own = current?.round?.own;
    receipt.hidden = !own;
    if (!own || !current?.round) return;
    const round = current.round;
    const lines = [
      `You said ${sideName(own.side)} · ${own.quantity} contracts · max ${price(paidCents(own))} each`,
      `${round.participants.toLocaleString()} ${round.participants === 1 ? "person" : "people"} in this window`,
      round.state === "settled" && round.outcome
        ? round.outcome.executed
          ? `Result: ${percent(round.pricing?.share)}% said yes · ${signedCoins(round.outcome.net)}`
          : "Result: not filled · refunded"
        : `Final. Yes and no totals stay hidden until results ${round.revealAt ? `on ${when(round.revealAt)}` : "5 days after the debate ends"}.`,
    ];
    receipt.replaceChildren(
      ...lines.map((text, index) => {
        const line = document.createElement(index ? "p" : "strong");
        line.textContent = text;
        return line;
      }),
    );
  }
  // The next turn offers the last position again; it pre-fills the ticket
  // and still needs the confirm tap.
  function renderRepeat(current: Target | null) {
    const last =
      joinable(current) && signedIn && !side && !current.round?.own
        ? lastPosition(rounds, current.turnNumber)
        : null;
    repeat.hidden = !last?.own;
    repeat.disabled = busy;
    if (last?.own) repeat.textContent = repeatLabel(last.own);
  }
  function renderReady() {
    ready.hidden = !(
      windows &&
      (windows.eventStatus === "scheduled" || windows.eventStatus === "ready")
    );
  }
  // Revealed positions move from "Your positions" to the results card.
  function renderResults() {
    const outcome = resultsSummary(rounds);
    results.hidden = !outcome.revealed.length;
    const lines = outcome.revealed.map(resultLine);
    const signature = [resultsHeading(outcome), ...lines].join("\n");
    if (results.dataset.signature === signature) return;
    results.dataset.signature = signature;
    resultsTitle.textContent = outcome.revealed.length
      ? resultsHeading(outcome)
      : "";
    resultsList.replaceChildren(
      ...lines.map((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        return item;
      }),
    );
  }
  function renderPositions() {
    const mine = resultsSummary(rounds).locked;
    positionsWrap.hidden = !mine.length;
    positionsCount.textContent = mine.length ? `(${mine.length})` : "";
    positionsList.replaceChildren(
      ...mine.map((round) => {
        const item = document.createElement("li");
        item.textContent = `Turn ${round.turnNumber} · ${sideName(round.own!.side)} · ${round.own!.quantity} — ${positionStatus(round, when)}`;
        return item;
      }),
    );
  }
  // Not enough coins for "Reserved now", in the panel's words, or "".
  function shortfall() {
    if (!summary) return "";
    const available = spendable(summary.balances);
    return available < reservedAtoms(size)
      ? `You have ${formatCoins(available)}, less than this size reserves. Lower the size.`
      : "";
  }
  // The review pop-up names one window. If another takes its place, the
  // pop-up closes and nothing is reserved.
  function checkReview(current: Target | null) {
    if (!review.open || !reviewed || current?.id === reviewed.id) return;
    const turn = reviewed.turnNumber;
    reviewed = null;
    review.close();
    closedTurn = turn;
    errorLine.textContent = `Turn ${turn}'s window closed before you confirmed. Nothing was reserved.`;
  }
  function render() {
    const current = target();
    checkReview(current);
    renderTurn(current);
    const text = statusText(current);
    if (status.textContent !== text) status.textContent = text;
    renderTicket(current);
    renderRepeat(current);
    renderReady();
    renderReceipt(current);
    renderResults();
    renderPositions();
    balanceLine.textContent = summary
      ? `Available: ${formatCoins(spendable(summary.balances))}`
      : "";
  }

  // Places the ticket on the window the viewer sees, or, from the review
  // pop-up, only on the window it showed.
  async function place(expected?: { id: string; turnNumber: number }) {
    const current = target();
    if (!side || busy) return;
    if (!current || (expected && current.id !== expected.id)) {
      if (expected) {
        closedTurn = expected.turnNumber;
        errorLine.textContent = `Turn ${expected.turnNumber}'s window closed before you confirmed. Nothing was reserved.`;
        render();
      }
      return;
    }
    if (shortfall()) return render();
    const chosen = side;
    const value = cents();
    const quantity = size;
    // F10: the server binds the replay position, floored to milliseconds, to
    // the request, so the retry key includes the same position.
    const position =
      current.via === "replay" && playback ? playback.positionSeconds : null;
    busy = true;
    errorLine.textContent = "";
    render();
    let roundId = current.id;
    try {
      if (current.via === "live") {
        const joined = await coinApi<{ id: string }>(
          `/debates/${encodeURIComponent(debateId)}/rounds`,
          "POST",
          {},
          key(`join:${current.id}`),
        );
        if (joined.id !== current.id) throw new Error("window changed");
        roundId = joined.id;
      }
      await coinApi(
        `/rounds/${roundId}/submit`,
        "POST",
        {
          side: chosen,
          ceiling: ceilingText(value),
          quantity,
          ...(position === null ? {} : { replayPositionSeconds: position }),
        },
        key(
          `stake:${roundId}:${chosen}:${value}:${quantity}:${position === null ? "live" : Math.floor(position * 1000)}`,
        ),
      );
      placed();
      await refresh();
    } catch (error) {
      // Read again first: the balance for the message, and after a lost
      // connection, whether the answer went through after all.
      await refresh();
      const failure = placementError(error, {
        turnNumber: current.turnNumber,
        available: summary ? String(spendable(summary.balances)) : null,
      });
      if (
        apiErrorStatus(error) === undefined &&
        rounds.find((round) => round.id === roundId)?.own
      )
        placed();
      else {
        if (failure.closed) closedTurn = current.turnNumber;
        errorLine.textContent = failure.text;
      }
    } finally {
      busy = false;
      render();
    }
  }

  function placed() {
    closedTurn = null;
    side = null;
    explaining = false;
    errorLine.textContent = "";
    window.dispatchEvent(new Event("yap:coins-changed"));
  }

  for (const button of sideButtons)
    button.addEventListener("click", () => {
      if (signedIn === false) {
        signIn.hidden = false;
        signIn.querySelector("a")!.focus();
        return;
      }
      side = button.dataset.stakeSide === "NO" ? "NO" : "YES";
      // A one-time explanation on this device, shown while the ticket is open.
      if (stored("yaparena-stake-explained") !== "1") {
        remember("yaparena-stake-explained", "1");
        explaining = true;
      }
      render();
      sizeInput.focus();
    });
  for (const chip of root.querySelectorAll<HTMLButtonElement>(
    "[data-stake-size]",
  ))
    chip.addEventListener("click", () => {
      applySize(Number(chip.dataset.stakeSize));
      render();
    });
  repeat.addEventListener("click", () => {
    const current = target();
    const last = current ? lastPosition(rounds, current.turnNumber) : null;
    if (!last?.own) return;
    side = last.own.side;
    applySize(last.own.quantity);
    readInput.value = String(readFromLimit(last.own.limit));
    advanced.open = false;
    ceilingInput.value = "";
    errorLine.textContent = "";
    render();
    confirm.focus();
  });
  for (const chip of root.querySelectorAll<HTMLButtonElement>(
    "[data-stake-ready-size]",
  ))
    chip.addEventListener("click", () =>
      applyReadySize(Number(chip.dataset.stakeReadySize)),
    );
  readyRead.addEventListener("input", () => {
    readyReadOut.textContent = `${readyRead.value}%`;
  });
  ready.addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = parseSize(readySize.value);
    if (chosen === null) {
      readyNote.textContent =
        "Enter a whole number of contracts from 1 to 100.";
      return;
    }
    const read = Number(readyRead.value);
    const saved = JSON.stringify({ size: chosen, read });
    remember(defaultsKey, saved);
    applyReadySize(chosen);
    applySize(chosen);
    readInput.value = String(read);
    readyNote.textContent =
      stored(defaultsKey) === saved
        ? `Saved on this device. Your ticket will open with ${chosen} contracts and a ${read}% read.`
        : `This browser didn't save it, so the ticket uses ${chosen} contracts and a ${read}% read on this page only.`;
    render();
  });
  sizeInput.addEventListener("input", () => {
    const value = parseSize(sizeInput.value);
    errorLine.textContent = value
      ? ""
      : "Enter a whole number of contracts from 1 to 100.";
    if (value) size = value;
    render();
  });
  readInput.addEventListener("input", render);
  ceilingInput.addEventListener("input", () => {
    errorLine.textContent =
      ceilingInput.value && parseCeiling(ceilingInput.value) === null
        ? "Enter a maximum price from 0.01 to 0.99 YC."
        : "";
    render();
  });
  // Only the confirm button places an answer; Enter in a field does not.
  for (const field of [sizeInput, ceilingInput])
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
  advanced.addEventListener("toggle", render);
  reviewChoice.addEventListener("change", () =>
    remember("yaparena-stake-review", reviewChoice.checked ? "1" : "0"),
  );
  ticket.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!side || parseSize(sizeInput.value) === null) {
      errorLine.textContent =
        "Enter a whole number of contracts from 1 to 100.";
      return;
    }
    if (!reviewChoice.checked) return void place();
    const current = target();
    if (!current) return;
    if (shortfall()) return render();
    const terms = ticketTerms(size, cents());
    reviewTerms.replaceChildren(
      ...[
        ["Answer", `${sideName(side)} · turn ${current.turnNumber}`],
        ["Size", `${size} contracts`],
        ["Most you can lose", terms.mostYouCanLose],
        ["Results", resultsText(current.round)],
      ].map(([name, value]) => {
        const row = document.createElement("div");
        const label = document.createElement("dt");
        const text = document.createElement("dd");
        label.textContent = name!;
        text.textContent = value!;
        row.append(label, text);
        return row;
      }),
    );
    reviewed = { id: current.id, turnNumber: current.turnNumber };
    review.showModal();
  });
  one("[data-stake-review-place]").addEventListener("click", () => {
    const shown = reviewed;
    reviewed = null;
    review.close();
    if (shown) void place(shown);
  });
  one("[data-stake-review-back]").addEventListener("click", () =>
    review.close(),
  );
  review.addEventListener("close", () => {
    reviewed = null;
  });

  // Decision 0012 (F10): the replay player announces what's playing.
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId) return;
    const before = target()?.id;
    playback = {
      positionSeconds: event.detail.positionSeconds,
      playing: event.detail.playing,
    };
    if (target()?.id !== before) {
      closedTurn = null;
      errorLine.textContent = "";
    }
    render();
  });
  const spread = () =>
    window.setTimeout(() => void refresh(), Math.random() * 3000);
  watchRoom({
    room: debateId,
    topics: ["window"],
    events: window,
    signal() {
      window.clearTimeout(refreshTimer);
      refreshTimer = spread();
    },
    health(live) {
      roomLive = live;
    },
  });
  // Another part of the page changed the balance: read it again.
  window.addEventListener("yap:coins-changed", () => {
    if (!signedIn || !summary) return;
    const current = generation;
    void coinApi<CoinSummary>("/summary")
      .then((value) => {
        if (current !== generation) return;
        summary = value;
        render();
      })
      .catch(() => {
        // The next refresh tries again.
      });
  });
  window.addEventListener("yap:account-changed", () => {
    generation++;
    keys.clear();
    signedIn = null;
    summary = null;
    rounds = [];
    side = null;
    revealedSeen = null;
    void refresh(true);
  });
  window.addEventListener("yap:provider-logout", () => {
    generation++;
    signedIn = false;
    summary = null;
    rounds = [];
    side = null;
    render();
  });
  // Every second: the countdown, and a refresh just after a window's cutoff.
  let lastTarget: Target | null = null;
  let lastPoll = Date.now();
  window.setInterval(() => {
    const current = target();
    if (current?.id !== lastTarget?.id) {
      // A window that closed under an open ticket reserved nothing; the
      // ticket keeps its values for the next turn and says so.
      if (lastTarget && side && !lastTarget.round?.own) {
        closedTurn = lastTarget.turnNumber;
        errorLine.textContent = `Turn ${lastTarget.turnNumber}'s window closed before you confirmed. Nothing was reserved.`;
      }
      lastTarget = current;
      void refresh();
      return;
    }
    lastTarget = current;
    const pollEvery = roomLive ? 60000 : 15000;
    if (!document.hidden && Date.now() - lastPoll > pollEvery) {
      lastPoll = Date.now();
      void refresh();
    }
    render();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  void refresh(true);
}
