// The debate answer panel (Decision 0013): Yes and No about the question,
// one position per turn window, placed live or from the replay. The server
// keeps every rule; this controller shows the current window, the viewer's
// terms and receipts, and never shows side totals before the reveal.
import { api, apiError, apiErrorStatus, apiFetch } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import { formatCoins } from "./lib/coin-format.js";
import {
  claimWelcome,
  readSummary as sharedSummary,
  spendable,
  type CoinSummary,
} from "./lib/coins.js";
import { watchRoom } from "./community-stream.js";
import {
  canAnswer,
  ceilingCents,
  ceilingText,
  checkingTurnText,
  clock,
  confirmText,
  debatesHere,
  liveWindow,
  percent,
  placementError,
  positionStatus,
  price,
  reasonText,
  replayRound,
  replayUntimed,
  replayWindow,
  reservedAtoms,
  resultLine,
  resultsHeading,
  resultsSummary,
  secondsLeft,
  signedCoins,
  speakerLine,
  watchSheetName,
  type PublicWindow,
  type PublicWindows,
  type StakeRound,
  type StakeSide,
} from "./stake-model.js";
import {
  reportStakeWindowsFailure,
  shareStakeRounds,
  shareStakeWindows,
} from "./stake-windows.js";
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
  const readInput = one<HTMLInputElement>(
    '[data-stake-ticket] input[name="read"]',
  );
  const readOut = one("[data-stake-read-out]");
  const errorLine = one("[data-stake-error]");
  const confirm = one<HTMLButtonElement>("[data-stake-confirm]");
  const receipt = one("[data-stake-receipt]");
  const signIn = one("[data-stake-signin]");
  const positionsWrap = one<HTMLDetailsElement>("[data-stake-positions-wrap]");
  const positionsList = one("[data-stake-positions]");
  const positionsCount = one("[data-stake-positions-count]");
  const results = one("[data-stake-results]");
  const resultsTitle = one("[data-stake-results-title]");
  const resultsList = one("[data-stake-results-list]");
  // Decision 0016 (amended 2026-11-16): one ticket wherever a viewer
  // answers, with the side word and clock on top, the five size chips, the
  // read and one key naming the terms. On a phone it is a sheet, also over
  // the full screen.
  const arena = root.closest<HTMLElement>("[data-arena]");
  const watching = () => arena?.dataset.watch === "open";
  const ticketSide = one("[data-stake-ticket-side]");
  const ticketClock = one("[data-stake-ticket-clock]");
  const sizeChips = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-stake-size]"),
  ];

  const store = sessionStore();
  let windows: PublicWindows | null = null;
  let unavailable = false;
  let rounds: StakeRound[] = [];
  // Set once a round says this account debates here; it then can't answer
  // any turn, even one whose rounds read failed (debatesHere).
  let debater = false;
  let signedIn: boolean | null = null;
  let summary: CoinSummary | null = null;
  let serverOffset = 0;
  let side: StakeSide | null = null;
  let size = 10;
  let busy = false;
  let closedTurn: number | null = null;
  let playback: { positionSeconds: number; playing: boolean } | null = null;
  let generation = 0;
  // True while room signals reach the page, by stream or by the chat's poll.
  let signalsFlowing = false;
  let refreshTimer: number | undefined;
  let loadFailed = false;
  // After a refused read, the server's Retry-After, as a time.
  let waitUntil = 0;
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
  // Decision 0016, amended 2026-11-16: the ticket holds only the approved
  // answer sheet's parts. "Get ready" with its saved defaults, the review
  // pop-up and the one-time explanation are gone, so the device keeps none
  // of their choices: the ticket opens at 10 contracts and a 50% read, then
  // keeps the last size and read used on this page.
  for (const name of [
    "yaparena-stake-defaults",
    "yaparena-stake-review",
    "yaparena-stake-explained",
  ])
    try {
      localStorage.removeItem(name);
    } catch {
      // Storage may be unavailable; nothing was saved then.
    }
  // The ticket's size and its chips move together.
  function applySize(value: number) {
    size = value;
    for (const chip of sizeChips)
      chip.setAttribute(
        "aria-pressed",
        String(Number(chip.dataset.stakeSize) === size),
      );
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
    if (!response.ok) throw await apiError(response);
    const value: PublicWindows = await response.json();
    unavailable = false;
    windows = value;
    serverOffset = Date.parse(value.serverNow) - Date.now();
    // Item d: the chart shows revealed windows from this same public read,
    // for signed-in and signed-out viewers alike.
    // Decision 0015: the bar on the video reads the debate figure from it too.
    shareStakeWindows({
      debateId,
      windows: value.windows,
      endorsement: value.endorsement ?? null,
      endorsementTurns: value.endorsementTurns ?? [],
      revealMode: value.revealMode,
      revealAt: value.revealAt,
    });
  }
  // With readSummary false, the balance already shown stays: at a window
  // boundary only the windows and this viewer's rounds change, unless a
  // position of theirs just closed.
  async function loadPrivate(current: number, readSummary = true) {
    if (!signedIn) return;
    let value =
      readSummary || !summary || !summary.initialized
        ? await sharedSummary(15000)
        : summary;
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
    if (debatesHere(view)) debater = true;
    // The price inspector marks this viewer's own limit on revealed turns;
    // the phone's full screen shows each position on its keys and pops each
    // result as it is revealed.
    shareStakeRounds({
      debateId,
      limits: Object.fromEntries(
        view.flatMap((round) =>
          round.own ? [[round.id, round.own.limit]] : [],
        ),
      ),
      positions: Object.fromEntries(
        view.flatMap((round) =>
          round.own
            ? [
                [
                  round.id,
                  { side: round.own.side, quantity: round.own.quantity },
                ],
              ]
            : [],
        ),
      ),
      rounds: view,
    });
    // A reveal changes the balance everywhere on the page.
    const revealed = resultsSummary(view).revealed.length;
    if (revealedSeen !== null && revealed > revealedSeen)
      window.dispatchEvent(new Event("yap:coins-changed"));
    revealedSeen = revealed;
  }
  async function refresh(full = false, readSummary = true) {
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
      await loadWindows().catch((error: unknown) => {
        // The Results tab reads its turns from this read; say it's stale.
        if (current === generation) reportStakeWindowsFailure(debateId);
        throw error;
      });
      if (current !== generation) return;
      await loadPrivate(current, readSummary).catch((error: unknown) => {
        // A disabled coin sandbox (404) leaves only the public view.
        if (apiErrorStatus(error) === 404) summary = null;
        else throw error;
      });
      if (current === generation) {
        loadFailed = false;
        waitUntil = 0;
      }
    } catch (error) {
      if (current === generation) {
        loadFailed = true;
        waitUntil = Date.now() + retryAfterMs(error);
      }
    }
    if (current === generation) render();
  }
  // How long a refused read asked to wait (Retry-After), or nothing.
  function retryAfterMs(error: unknown) {
    const seconds =
      typeof error === "object" &&
      error !== null &&
      "retryAfterSeconds" in error &&
      typeof error.retryAfterSeconds === "number"
        ? error.retryAfterSeconds
        : 0;
    return Math.min(seconds, 900) * 1000;
  }

  // The window the viewer would answer now: the live turn's window, or on a
  // five-day replay the window of the turn that's playing.
  function target(): Target | null {
    if (!windows) return null;
    const live = liveWindow(windows.windows, now(), windows.eventStatus);
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
  // The read alone sets the price: the yes ceiling is the read, the no
  // ceiling 100 minus it.
  function cents() {
    return ceilingCents(side ?? "YES", Number(readInput.value));
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
      ticketClock.textContent = turnClock.textContent;
      ticketClock.classList.toggle(
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
    ticketClock.textContent = "";
    if (eventStatus === "live") {
      turnTitle.textContent = "Between turns";
      meta.textContent = "The next window opens when the next speaker starts.";
    }
  }
  function statusText(current: Target | null) {
    const eventStatus = windows?.eventStatus ?? root!.dataset.debateStatus;
    // A debater can't answer any turn, whatever else failed to load.
    if (current && signedIn && debater) return reasonText("debater");
    if (loadFailed)
      return "Couldn't load this debate's Yap Coins rounds. They refresh automatically.";
    if (!current && closedTurn !== null && side)
      return `Turn ${closedTurn}'s window closed before you confirmed. Nothing was reserved.`;
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
      // The live turn is always in the signed-in view once it loads.
      if (signedIn && !current.round && current.via === "live")
        return checkingTurnText;
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
      // F10 needs the recording's start, reported once it completes.
      return replayUntimed(windows.windows)
        ? "Answers from the replay open once its recording is ready."
        : playback
          ? "You can join the window for the turn that's playing."
          : "Play the replay to answer the turn that's playing.";
    return "Answers for this debate are closed.";
  }
  function joinable(current: Target | null): current is Target {
    // A turn takes an answer once the signed-in view brings its eligibility;
    // the refresh that finds a new window reads both.
    return (
      current !== null &&
      canAnswer({
        signedIn,
        coins: summary !== null,
        debater,
        round: current.round,
      })
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
    ticketSide.textContent = side ? sideName(side) : "";
    if (side) {
      ticket.dataset.side = side;
      ticketSide.dataset.side = side;
    }
    if (!showTicket || !side || !current) return;
    const value = cents();
    readOut.textContent = `${readInput.value}%`;
    // What a position reserves (one coin per contract) must fit the balance
    // before the confirm tap.
    const short = shortfall();
    if (short) errorLine.textContent = short;
    else if (errorLine.dataset.shortfall === "true") errorLine.textContent = "";
    errorLine.dataset.shortfall = String(Boolean(short));
    confirm.disabled = busy || Boolean(short);
    confirm.textContent = confirmText({
      side,
      size,
      cents: value,
      turnNumber: current.turnNumber,
      closedTurn,
    });
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
  function render() {
    const current = target();
    renderTurn(current);
    const text = statusText(current);
    if (status.textContent !== text) status.textContent = text;
    renderTicket(current);
    renderReceipt(current);
    renderResults();
    renderPositions();
    nameSheet();
  }
  // Decision 0016: the panel is "Answer this turn" (it shows no question
  // since 2026-11-16); as a phone's sheet, on the page or over the full
  // screen, it is a dialog named for its side, "Your answer: Yes".
  function nameSheet() {
    const sheet = "sheet" in root!.dataset;
    const name = sheet ? watchSheetName(side) : "Answer this turn";
    if (sheet) root!.setAttribute("role", "dialog");
    else root!.removeAttribute("role");
    if (root!.getAttribute("aria-label") !== name)
      root!.setAttribute("aria-label", name);
  }

  // Places the ticket on the window the viewer sees.
  async function place() {
    const current = target();
    if (!side || busy || !current) return;
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
    let done = false;
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
      done = true;
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
      ) {
        placed();
        done = true;
      } else {
        if (failure.closed) closedTurn = current.turnNumber;
        errorLine.textContent = failure.text;
      }
    } finally {
      busy = false;
      render();
      // Decision 0016: in the full screen, a placed answer closes the sheet.
      // The rounds were read again first, so the key it returns focus to
      // already names the position ("Yes · 25"); the receipt stays in the
      // panel and the position in "Your positions".
      if (done && watching() && "sheet" in root!.dataset)
        delete root!.dataset.sheet;
    }
  }

  function placed() {
    closedTurn = null;
    side = null;
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
      render();
      // The chosen size chip takes focus once the ticket shows: on a phone
      // debate-layout.ts opens the sheet after this click.
      requestAnimationFrame(() => {
        const chip = sizeChips.find(
          (item) => item.getAttribute("aria-pressed") === "true",
        );
        if (!ticket.hidden) (chip ?? confirm).focus({ preventScroll: true });
      });
    });
  for (const chip of sizeChips)
    chip.addEventListener("click", () => {
      applySize(Number(chip.dataset.stakeSize));
      render();
    });
  // Opening or closing the full screen (frontend/watch-screen.ts) changes
  // where the sheet sits and how it is named.
  window.addEventListener("yap:watch", (event) => {
    if (event.detail.debateId === debateId) render();
  });
  // As a sheet it is a dialog named for its side.
  new MutationObserver(nameSheet).observe(root, {
    attributes: true,
    attributeFilter: ["data-sheet"],
  });
  readInput.addEventListener("input", render);
  // Placing is immediate: the key names the exact terms (Decision 0013).
  ticket.addEventListener("submit", (event) => {
    event.preventDefault();
    void place();
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
  // Everyone in a room crosses a window boundary in the same second; spread
  // their reads over 0–3 seconds.
  const spread = (readSummary = true) =>
    window.setTimeout(
      () => void refresh(false, readSummary),
      Math.random() * 3000,
    );
  // Only a viewer with an open position here can see their balance change
  // when a window opens, closes or settles.
  const ownOpen = () =>
    rounds.some((round) => round.own && round.state === "open");
  // The public window list is the same for every viewer, and the server
  // shares overlapping reads of it, so a signal reads it at once: a reveal
  // reaches the turn bars and the bar on the video (Decision 0015) without
  // waiting. The spread refresh still follows, for this viewer's own rounds
  // and in case this read joined one that began before the change.
  const readWindowsNow = () => {
    const current = generation;
    void loadWindows().then(
      () => {
        if (current === generation) render();
      },
      () => {
        // The spread refresh reads it again.
      },
    );
  };
  watchRoom({
    room: debateId,
    topics: ["window"],
    events: window,
    signal() {
      readWindowsNow();
      window.clearTimeout(refreshTimer);
      refreshTimer = spread(ownOpen());
    },
    health() {
      // The panel needs signals, however they arrive; see `flowing`.
    },
    flowing(value) {
      signalsFlowing = value;
    },
  });
  // Another part of the page changed the balance: read it again. The header
  // asks at the same moment, and they share one request.
  window.addEventListener("yap:coins-changed", () => {
    if (!signedIn || !summary) return;
    const current = generation;
    void sharedSummary(15000)
      .then((value) => {
        if (current !== generation) return;
        summary = value;
        render();
      })
      .catch(() => {
        // The next refresh tries again.
      });
  });
  // Any module's balance read for this session updates the panel too.
  window.addEventListener("yap:coins-summary", (event) => {
    if (!signedIn || summary?.sessionId !== event.detail.sessionId) return;
    summary = event.detail;
    render();
  });
  window.addEventListener("yap:account-changed", () => {
    generation++;
    keys.clear();
    signedIn = null;
    summary = null;
    rounds = [];
    debater = false;
    side = null;
    revealedSeen = null;
    void refresh(true);
  });
  window.addEventListener("yap:provider-logout", () => {
    generation++;
    signedIn = false;
    summary = null;
    rounds = [];
    debater = false;
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
      // Read the balance again only if a position of this viewer's was in
      // the window that just closed.
      const owned = Boolean(lastTarget?.round?.own);
      lastTarget = current;
      window.clearTimeout(refreshTimer);
      refreshTimer = spread(owned);
      render();
      return;
    }
    lastTarget = current;
    // A safety net: signals bring changes, so while they arrive this reads
    // once a minute, and the balance only for an open position (other
    // balance reads on the page reach the panel as yap:coins-summary).
    const pollEvery = signalsFlowing && !loadFailed ? 60000 : 15000;
    if (
      !document.hidden &&
      Date.now() - lastPoll > pollEvery &&
      Date.now() >= waitUntil
    ) {
      lastPoll = Date.now();
      void refresh(false, ownOpen());
    }
    render();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  void refresh(true);
}
