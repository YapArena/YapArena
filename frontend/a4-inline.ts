// The debate page's chart (Decision 0013). It shows revealed Yap Coins turn
// windows once a debate has any (item d), labelled from each turn's final AI
// outline; otherwise the public bot history: the shared synthetic activity
// chart, price inspector, sentiment and argument endorsements. Bots mode
// itself (runs, commitments, receipts) lives on /coins; this module reads
// only public, already revealed aggregates.
import type { OutlineTimeline } from "../src/features/outline/public-types.ts";
import type { RoundPoint, SharedActivity, Timeline } from "./arena-types.js";
/* global document, window */
import { createRoundChart, sharePercent } from "./arena-chart.js";
import { createPriceInspector } from "./arena-price.js";
import { watchRoom } from "./community-stream.js";
import {
  pointsRevision,
  tooFewState,
  tooFewText,
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
  const prices = createPriceInspector(root, (item) => {
    chart.preview(item.id);
    selectRound(item);
  });
  const chart = createRoundChart(root, selectRound, (point) => {
    prices.show(point ?? defaultPrice);
  });
  function renderSentiment(
    point: RoundPoint,
    caption: string,
    kind: string,
    emptyLabel = `No ${kind.toLowerCase()} endorsements`,
  ) {
    const pct = sharePercent(point.share);
    ui("yes").textContent = pct === null ? "—" : pct.toFixed(1) + "%";
    ui("no").textContent = pct === null ? "—" : (100 - pct).toFixed(1) + "%";
    ui("sentiment-caption").textContent = caption;
    ui("sentiment-bar").dataset.empty = String(pct === null);
    ui("sentiment-bar").setAttribute(
      "aria-label",
      pct === null
        ? emptyLabel
        : `${kind} YES ${pct.toFixed(1)}%, NO ${(100 - pct).toFixed(1)}%`,
    );
    ui("sentiment-bar").style.setProperty("--yes-share", (pct ?? 0) + "%");
  }
  // Item d: revealed turn windows replace the bot history on this chart.
  function renderWindows(points: RoundPoint[]) {
    const latest = points.at(-1)!;
    const data: Timeline = {
      revision: `windows:${pointsRevision(points)}`,
      scope: "shared",
      items: points,
      totals: { premium: "0", humanCommitments: 0, botCommitments: 0 },
    };
    defaultPrice = latest;
    root.querySelector<HTMLElement>("[data-shared-arguments]")!.hidden = true;
    if (volume) volume.hidden = true;
    prices.update(data);
    chart.render(data, sharedSelected);
    ui("scope").textContent = "Yap Coins · revealed turn windows";
    ui("sync").textContent =
      "● Revealed results · updates when a turn's results are revealed";
    if (latest.state === tooFewState)
      renderSentiment(
        latest,
        `Yap Coins · turn ${latest.number} · ${tooFewText.toLowerCase()}`,
        "Revealed",
        tooFewText,
      );
    else
      renderSentiment(latest, `Yap Coins · turn ${latest.number}`, "Revealed");
    ui("round-label").textContent = `Turn ${latest.number}`;
    ui("round-state").textContent = "revealed";
    ui("countdown").textContent = "Revealed Yap Coins results";
  }
  function renderShared() {
    const revealed = windowPoints(windows, timeline);
    if (revealed.length) return renderWindows(revealed);
    const args = root.querySelector<HTMLElement>("[data-shared-arguments]")!;
    args.hidden = !shared?.arguments.length;
    if (!shared?.items.length) return;
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
        if (had) {
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
