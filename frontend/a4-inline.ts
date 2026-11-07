// The debate page's chart (Decision 0013). A debate with Yap Coins turn
// windows shows "Results by turn": one bar per turn, filled in as each
// window is revealed (item d), labelled from each turn's final AI outline
// (direction BC1's replay board). Otherwise, with Bots mode on, it shows the
// public bot history: the shared synthetic activity chart, price inspector,
// sentiment and argument endorsements. Bots mode itself (runs, commitments,
// receipts) lives on /coins; this module reads only public, already
// revealed aggregates.
import type { OutlineTimeline } from "../src/features/outline/public-types.ts";
import type { RoundPoint, SharedActivity, Timeline } from "./arena-types.js";
/* global document, window */
import { createRoundChart, sharePercent } from "./arena-chart.js";
import { createPriceInspector } from "./arena-price.js";
import { watchRoom } from "./community-stream.js";
import { seekReplay } from "./replay-seek.js";
import { createTurnBars } from "./turn-results.js";
import {
  isTurnWindow,
  latestRevealed,
  playingAt,
  revealNote,
  turnColumns,
  type Names,
  type TurnColumn,
} from "./turn-results-model.js";
import {
  pointsRevision,
  windowPoints,
  type RevealedWindow,
} from "./window-chart-model.js";
// These selectors refer to the fixed arena server-rendered markup.
const root = document.querySelector<HTMLElement>("[data-a4-inline]")!;
if (root) {
  const ui = (name: string) =>
    root.querySelector<HTMLElement>(`[data-arena-${name}]`)!;
  const money = (value: string | number | bigint = "0", precision = 6) => {
    const n = BigInt(value),
      a = n < 0n ? -n : n;
    const fractional = String(a % 1000000n)
      .padStart(6, "0")
      .slice(0, precision);
    return `${n < 0n ? "−" : ""}${a / 1000000n}${precision ? "." + fractional : ""} Yap Coins`;
  };
  const debateId = root.dataset.a4Inline!;
  // Bot history only when Bots mode is on; the Yap Coins mode always works.
  const botHistory = root.dataset.botHistory === "true";
  const volume = root.querySelector<HTMLElement>(".arena-volume");
  let windows: RevealedWindow[] = [];
  let timeline: OutlineTimeline | null = null;
  let timelineState: "idle" | "loading" | "done" = "idle";
  let timelineTimer: number | undefined;
  const sharedTemplate = root.querySelector<HTMLTemplateElement>(
    "[data-shared-bootstrap]",
  );
  let shared: SharedActivity | null = sharedTemplate
    ? JSON.parse(sharedTemplate.content.textContent!)
    : null;
  let sharedSelected: string | undefined,
    defaultPrice: RoundPoint | null | undefined,
    sharedBusy = false;
  // Shared activity re-reads on room signals, spread over a few seconds so a
  // room's viewers do not read at once; the interval is a safety net, slower
  // while the room stream is live.
  let lastShared = Date.now(),
    sharedDueAt: number | null = null,
    roomLive = false;
  const spread = () => Date.now() + Math.random() * 3000;
  const sharedAbort = new AbortController();
  const selectRound = (item: RoundPoint) => {
    sharedSelected = item.id;
    renderShared();
  };
  const status = root.dataset.debateStatus;
  const replay = status === "replay" || status === "finalized";
  const total = Number(root.dataset.turnCount) || null;
  const panel = root.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Names = {
    A: panel?.dataset.speakerA ?? "Speaker A",
    B: panel?.dataset.speakerB ?? "Speaker B",
  };
  // The bot history's line chart renders only with Bots mode on.
  const lineChart = root.querySelector<HTMLElement>("[data-line-chart]");
  const plot = root.querySelector<HTMLElement>(".arena-chart-plot");
  const turnEmpty = root.querySelector<HTMLElement>("[data-turn-empty]");
  const priceDetails = root.querySelector<HTMLDetailsElement>(
    "[data-price-details]",
  );
  const inspector = root.querySelector<HTMLElement>(".arena-price-inspector");
  let mode: "bars" | "line" | "empty" = lineChart ? "line" : "empty";
  let columns: TurnColumn[] = [];
  // This viewer's own limits by window id, from the answer panel.
  let ownLimits: Record<string, string> = {};
  const phone = matchMedia("(max-width: 599px)");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let selectedTurn: number | null = null;
  let position: number | null = null;
  let playingTurn: number | null = null;
  const bars = createTurnBars(
    root,
    (column) => {
      selectedTurn = column.turnNumber;
      renderShared();
      // Phones: a revealed turn opens its price draw under the rows.
      if (phone.matches && column.state === "revealed" && priceDetails) {
        priceDetails.open = true;
        inspector?.scrollIntoView({
          block: "nearest",
          behavior: calm.matches ? "auto" : "smooth",
        });
      }
      // On a replay, choosing a turn plays it.
      if (replay && column.recording) seekReplay(column.recording.startSeconds);
    },
    phone,
  );
  const prices = createPriceInspector(root, (item) => {
    if (mode === "bars") {
      selectedTurn = item.number;
      renderShared();
      return;
    }
    chart?.preview(item.id);
    selectRound(item);
  });
  const chart = plot
    ? createRoundChart(root, selectRound, (point) => {
        prices.show(point ?? defaultPrice);
      })
    : null;
  // The price inspector sits under the line chart's plot, or in a
  // disclosure under the bars.
  function setMode(next: typeof mode) {
    mode = next;
    if (lineChart) lineChart.hidden = next === "bars";
    if (turnEmpty) turnEmpty.hidden = next !== "empty" || Boolean(lineChart);
    if (next !== "bars") {
      bars.hide();
      columns = [];
      playingTurn = null;
    }
    if (inspector && priceDetails) {
      if (next === "bars") {
        if (inspector.parentElement !== priceDetails)
          priceDetails.append(inspector);
      } else {
        if (plot && inspector.previousElementSibling !== plot)
          plot.after(inspector);
        priceDetails.hidden = true;
      }
    }
  }
  function renderSentiment(point: RoundPoint, caption: string, kind: string) {
    const pct = sharePercent(point.share);
    ui("yes").textContent = pct === null ? "—" : pct.toFixed(1) + "%";
    ui("no").textContent = pct === null ? "—" : (100 - pct).toFixed(1) + "%";
    ui("sentiment-caption").textContent = caption;
    ui("sentiment-bar").dataset.empty = String(pct === null);
    ui("sentiment-bar").setAttribute(
      "aria-label",
      pct === null
        ? `No ${kind.toLowerCase()} endorsements`
        : `${kind} YES ${pct.toFixed(1)}%, NO ${(100 - pct).toFixed(1)}%`,
    );
    ui("sentiment-bar").style.setProperty("--yes-share", (pct ?? 0) + "%");
  }
  // Item d: the turn windows replace the bot history on this chart once one
  // is revealed, or straight away without bot history. Each turn is a bar;
  // only revealed turns show a result.
  function renderTurns(points: RoundPoint[]) {
    const turnWindows = windows.filter(isTurnWindow);
    setMode("bars");
    columns = turnColumns(turnWindows, timeline, total, !replay);
    if (!columns.some((column) => column.turnNumber === selectedTurn))
      selectedTurn = null;
    const selected = selectedTurn ?? latestRevealed(columns);
    playingTurn = replay ? playingAt(columns, position) : null;
    bars.render({
      columns,
      names,
      selected,
      playing: playingTurn,
      note: revealNote(turnWindows, Date.now()),
    });
    root.querySelector<HTMLElement>("[data-shared-arguments]")!.hidden = true;
    if (volume) volume.hidden = true;
    if (priceDetails) priceDetails.hidden = !points.length;
    if (!points.length) return;
    const latest = points.at(-1)!;
    const data: Timeline = {
      revision: `windows:${pointsRevision(points)}`,
      scope: "shared",
      items: points,
      totals: { premium: "0", humanCommitments: 0, botCommitments: 0 },
    };
    defaultPrice = latest;
    prices.update(data);
    prices.show(
      points.find((point) => point.number === selected) ?? null,
      "Turn",
    );
    ui("scope").textContent = "Yap Coins · revealed turn windows";
    renderSentiment(latest, `Yap Coins · turn ${latest.number}`, "Revealed");
  }
  function renderShared() {
    const revealed = windowPoints(windows, timeline).map((point) => ({
      ...point,
      ownLimit: ownLimits[point.id] ?? null,
    }));
    if (
      revealed.length ||
      (!shared?.items.length && windows.some(isTurnWindow))
    )
      return renderTurns(revealed);
    setMode(lineChart ? "line" : "empty");
    const args = root.querySelector<HTMLElement>("[data-shared-arguments]")!;
    args.hidden = !shared?.arguments.length;
    if (!shared?.items.length || !chart) return;
    if (volume) volume.hidden = false;
    defaultPrice = shared.items.at(-1);
    prices.update(shared);
    chart.render(shared, sharedSelected);
    ui("volume").textContent = money(shared.totals.premium, 2);
    ui("participants").textContent =
      `${shared.totals.botCommitments.toLocaleString()} synthetic bot endorsements · ${shared.totals.humanCommitments} shared participant endorsements`;
    ui("scope").textContent =
      "Shared simulation · seeded bots + opted-in mixed and observer rounds";
    ui("sync").textContent = "● Synthetic activity · updates after settlement";
    renderSentiment(
      defaultPrice!,
      `Synthetic / shared round ${defaultPrice!.number}`,
      "Synthetic",
    );
    ui("round-label").textContent = `Round ${shared.items.at(-1)!.number}`;
    ui("round-state").textContent = "synthetic";
    ui("countdown").textContent = "Shared settled history";
    const signature = shared.revision;
    if (args.dataset.revision !== signature) {
      args.dataset.revision = signature;
      const list = root.querySelector<HTMLElement>(
        "[data-shared-argument-list]",
      )!;
      list.replaceChildren();
      for (const a of shared.arguments) {
        const article = document.createElement("article"),
          title = document.createElement("strong"),
          text = document.createElement("p"),
          meter = document.createElement("progress");
        title.textContent = `${a.stance === "against" ? "COUNTERARGUMENT" : "FOR THE IDEA"} · ${a.rate.toFixed(1)}%`;
        text.textContent = a.text;
        meter.max = 100;
        meter.value = a.rate;
        meter.setAttribute(
          "aria-label",
          `Synthetic endorsement: ${a.rate.toFixed(1)}%, ${a.endorsed} of ${a.population} bots`,
        );
        article.append(title, text, meter);
        list.append(article);
      }
    }
  }
  // S's contract: the outline timeline is read once per page, and again only
  // on the `outline` room signal while a revealed turn still lacks its label.
  async function loadTimeline() {
    if (timelineState === "loading" || sharedAbort.signal.aborted) return;
    timelineState = "loading";
    try {
      const response = await fetch(
        `/api/public/debates/${debateId}/outline/timeline`,
        { cache: "no-store", signal: sharedAbort.signal },
      );
      // 404: the outline is off, so windows stay unlabelled.
      if (response.ok) timeline = await response.json();
      else if (response.status === 404) timeline = null;
    } catch {
      // Keep the labels already shown; the next outline signal retries.
    } finally {
      timelineState = "done";
    }
    renderShared();
  }
  window.addEventListener("yap:stake-windows", (event) => {
    if (event.detail.debateId !== debateId) return;
    windows = event.detail.windows;
    if (timelineState === "idle" && windowPoints(windows, null).length)
      void loadTimeline();
    renderShared();
  });
  window.addEventListener("yap:stake-rounds", (event) => {
    if (event.detail.debateId !== debateId) return;
    ownLimits = event.detail.limits;
    if (mode === "bars") renderShared();
  });
  // The replay's playing turn is outlined in Results by turn.
  window.addEventListener("yap:playback", (event) => {
    if (event.detail.debateId !== debateId || !replay) return;
    position = event.detail.positionSeconds;
    if (mode === "bars" && playingAt(columns, position) !== playingTurn)
      renderShared();
  });
  async function loadShared() {
    if (
      !botHistory ||
      sharedBusy ||
      document.hidden ||
      sharedAbort.signal.aborted
    )
      return;
    sharedBusy = true;
    sharedDueAt = null;
    lastShared = Date.now();
    try {
      const response = await fetch(
        `/api/public/debates/${root.dataset.a4Inline}/activity`,
        { cache: "no-store", signal: sharedAbort.signal },
      );
      if (response.status === 404) {
        const had = Boolean(shared?.items.length);
        shared = null;
        root.querySelector<HTMLElement>("[data-shared-arguments]")!.hidden =
          true;
        if (had && chart) {
          chart.clear("Shared history is unavailable.");
          prices.clear();
          ui("volume").textContent = "— Yap Coins";
          ui("yes").textContent = "—";
          ui("no").textContent = "—";
        }
        return;
      }
      if (!response.ok) throw new Error("Shared activity refresh unavailable");
      const next: SharedActivity = await response.json();
      if (next.revision !== shared?.revision) {
        shared = next;
        renderShared();
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && shared?.items.length)
        ui("sync").textContent =
          "Shared activity connection interrupted · showing last loaded results";
    } finally {
      sharedBusy = false;
    }
  }
  const sharedTimer = setInterval(() => {
    if (!botHistory) return;
    const now = Date.now();
    if (
      (sharedDueAt !== null && now >= sharedDueAt) ||
      now - lastShared >= (roomLive ? 60000 : 15000)
    )
      void loadShared();
  }, 1000);
  const stopWatching = watchRoom({
    room: debateId,
    topics: botHistory ? ["activity", "outline"] : ["outline"],
    events: window,
    signal(topic) {
      if (topic === "activity") {
        sharedDueAt ??= spread();
        return;
      }
      // A final outline may label a revealed turn; viewers re-read spread.
      if (
        timelineState === "done" &&
        windowPoints(windows, timeline).some((point) => !point.argumentLabel)
      ) {
        window.clearTimeout(timelineTimer);
        timelineTimer = window.setTimeout(
          () => void loadTimeline(),
          Math.random() * 3000,
        );
      }
    },
    health(live) {
      roomLive = live;
    },
  });
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(sharedTimer);
      window.clearTimeout(timelineTimer);
      stopWatching();
      sharedAbort.abort();
    },
    { once: true },
  );
  renderShared();
}
