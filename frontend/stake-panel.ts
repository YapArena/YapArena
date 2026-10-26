// The debate betting panel (Decision 0013): "Do you agree?" with Yes and No,
// one position per turn window, placed live or from the replay. The server
// keeps every rule; this controller shows the current window, the viewer's
// terms and receipts, and never shows side totals before the reveal.
import { api, apiErrorStatus, apiFetch } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import { watchRoom } from "./community-stream.js";
import {
  ceilingCents,
  ceilingText,
  clock,
  liveWindow,
  parseCeiling,
  parseSize,
  percent,
  positionStatus,
  reasonText,
  replayRound,
  replayWindow,
  secondsLeft,
  signedCoins,
  speakerLine,
  ticketTerms,
  type PublicWindow,
  type PublicWindows,
  type StakeRound,
  type StakeSide,
} from "./stake-model.js";

interface CoinSummary {
  sessionId: string;
  initialized: boolean;
  financialReviewRequired: boolean;
  balances: { cashAvailable: string; promotionalPrincipal: string };
}
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
  }
  async function loadPrivate(current: number) {
    if (!signedIn) return;
    let value = await coinApi<CoinSummary>("/summary");
    if (current !== generation) return;
    summary = value;
    // Decision 0013: Yap Coins are always on; the first visit claims the
    // welcome grant.
    if (!value.initialized && !value.financialReviewRequired) {
      await coinApi("/initialize", "POST", {});
      value = await coinApi<CoinSummary>("/summary");
      if (current !== generation) return;
      summary = value;
      window.dispatchEvent(new Event("yap:coins-changed"));
    }
    const view = await coinApi<StakeRound[]>(
      `/debates/${encodeURIComponent(debateId)}/rounds`,
    );
    if (current !== generation) return;
    rounds = view;
    // Item d: the chart shows the revealed windows from this same read.
    window.dispatchEvent(
      new CustomEvent("yap:stake-windows", {
        detail: { debateId, windows: view },
      }),
    );
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
      return "How it works: answer for this turn, then set how much you'll risk. Each contract pays the final share of people who answered your way. Final once placed; no cash value.";
    if (unavailable) return "Yap Coins rounds aren't open on this debate.";
    if (eventStatus === "cancelled" || eventStatus === "void_review")
      return "This debate isn't taking answers. Any Yap Coins you placed are refunded.";
    if (eventStatus === "scheduled" || eventStatus === "ready")
      return "Windows open when the debate starts: one per speaking turn, 60 seconds each.";
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
  function renderTicket(current: Target | null) {
    const joinable =
      current !== null &&
      (signedIn === false ||
        (summary !== null &&
          (current.round
            ? current.round.eligibility.canTakePosition
            : current.via === "live")));
    // (A replay window needs the signed-in view's eligibility before it
    // takes an answer; the next refresh brings it.)
    for (const button of sideButtons) {
      button.disabled = busy || !joinable;
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stakeSide === side),
      );
    }
    const showTicket = Boolean(joinable && signedIn && side);
    ticket.hidden = !showTicket;
    if (!showTicket || !side || !current) return;
    const value = cents();
    const terms = ticketTerms(size, value);
    readOut.textContent = `${readInput.value}%`;
    ceilingNote.textContent = `You'll pay at most ${value}¢ per contract.`;
    term("reserved").textContent = terms.reserved;
    term("lose").textContent = terms.mostYouCanLose;
    term("back").textContent =
      `${size} × final ${sideName(side).toLowerCase()} share`;
    term("results").textContent =
      current.round?.revealMode === "per_round" ||
      windows?.revealMode === "per_round"
        ? "When this turn's window closes"
        : resultsText(current.round);
    confirm.disabled = busy;
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
      `You said ${sideName(own.side)} · ${own.quantity} contracts · max ${paidCents(own)}¢ each`,
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
  function renderPositions() {
    const mine = rounds
      .filter((round) => round.own && round.kind === "turn")
      .sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0));
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
  function render() {
    const current = target();
    renderTurn(current);
    const text = statusText(current);
    if (status.textContent !== text) status.textContent = text;
    renderTicket(current);
    renderReceipt(current);
    renderPositions();
    if (summary) {
      const available =
        BigInt(summary.balances.cashAvailable) +
        BigInt(summary.balances.promotionalPrincipal);
      balanceLine.textContent = `Balance ${signedCoins(available).replace("+", "")} · simulated, no cash value`;
    } else balanceLine.textContent = "";
  }

  async function place() {
    const current = target();
    if (!current || !side || busy) return;
    const chosen = side;
    const value = cents();
    const quantity = size;
    const position = playback?.positionSeconds;
    busy = true;
    errorLine.textContent = "";
    render();
    try {
      let roundId = current.id;
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
          ...(current.via === "replay" && position !== undefined
            ? { replayPositionSeconds: position }
            : {}),
        },
        key(`stake:${roundId}:${chosen}:${value}:${quantity}`),
      );
      closedTurn = null;
      side = null;
      explaining = false;
      window.dispatchEvent(new Event("yap:coins-changed"));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        message === "window changed" ||
        /closed|cutoff|no trading window/i.test(message)
      ) {
        closedTurn = current.turnNumber;
        errorLine.textContent = `Turn ${current.turnNumber}'s window closed before you confirmed. Nothing was reserved.`;
        await refresh();
      } else
        errorLine.textContent =
          message || "Couldn't confirm. Your request is kept; try again.";
    } finally {
      busy = false;
      render();
    }
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
      size = Number(chip.dataset.stakeSize);
      sizeInput.value = String(size);
      for (const other of root.querySelectorAll<HTMLButtonElement>(
        "[data-stake-size]",
      ))
        other.setAttribute("aria-pressed", String(other === chip));
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
        ? "Enter a maximum price from 1 to 99 cents."
        : "";
    render();
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
    const terms = ticketTerms(size, cents());
    reviewTerms.replaceChildren(
      ...[
        [
          "Answer",
          `${sideName(side)}${current ? ` · turn ${current.turnNumber}` : ""}`,
        ],
        ["Size", `${size} contracts`],
        ["Most you can lose", terms.mostYouCanLose],
        ["Results", resultsText(current?.round ?? null)],
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
    review.showModal();
  });
  one("[data-stake-review-place]").addEventListener("click", () => {
    review.close();
    void place();
  });
  one("[data-stake-review-back]").addEventListener("click", () =>
    review.close(),
  );

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
  window.addEventListener("yap:account-changed", () => {
    generation++;
    keys.clear();
    signedIn = null;
    summary = null;
    rounds = [];
    side = null;
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
