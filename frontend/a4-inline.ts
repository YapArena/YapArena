// The debate page's public bot history (Decision 0013): the shared synthetic
// activity chart, price inspector, sentiment and argument endorsements. Bots
// mode itself (runs, commitments, receipts) lives on /coins; this module reads
// only the public, already revealed aggregates.
import type { RoundPoint, SharedActivity } from "./arena-types.js";
/* global document, window */
import { createRoundChart, sharePercent } from "./arena-chart.js";
import { createPriceInspector } from "./arena-price.js";
import { watchRoom } from "./community-stream.js";
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
  function renderShared() {
    const args = root.querySelector<HTMLElement>("[data-shared-arguments]")!;
    args.hidden = !shared?.arguments.length;
    if (!shared?.items.length) return;
    defaultPrice = shared.items.at(-1);
    prices.update(shared);
    chart.render(shared, sharedSelected);
    ui("volume").textContent = money(shared.totals.premium, 2);
    ui("participants").textContent =
      `${shared.totals.botCommitments.toLocaleString()} synthetic bot endorsements · ${shared.totals.humanCommitments} shared participant endorsements`;
    ui("scope").textContent =
      "Shared simulation · seeded bots + opted-in mixed and observer rounds";
    ui("sync").textContent = "● Synthetic activity · updates after settlement";
    const pct = sharePercent(defaultPrice!.share);
    ui("yes").textContent = pct === null ? "—" : pct.toFixed(1) + "%";
    ui("no").textContent = pct === null ? "—" : (100 - pct).toFixed(1) + "%";
    ui("sentiment-caption").textContent =
      `Synthetic / shared round ${defaultPrice!.number}`;
    ui("sentiment-bar").dataset.empty = String(pct === null);
    ui("sentiment-bar").setAttribute(
      "aria-label",
      pct === null
        ? "No synthetic endorsements"
        : `Synthetic YES ${pct.toFixed(1)}%, NO ${(100 - pct).toFixed(1)}%`,
    );
    ui("sentiment-bar").style.setProperty("--yes-share", (pct ?? 0) + "%");
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
  async function loadShared() {
    if (sharedBusy || document.hidden || sharedAbort.signal.aborted) return;
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
    const now = Date.now();
    if (
      (sharedDueAt !== null && now >= sharedDueAt) ||
      now - lastShared >= (roomLive ? 60000 : 15000)
    )
      void loadShared();
  }, 1000);
  const stopWatching = watchRoom({
    room: root.dataset.a4Inline!,
    topics: ["activity"],
    events: window,
    signal() {
      sharedDueAt ??= spread();
    },
    health(live) {
      roomLive = live;
    },
  });
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(sharedTimer);
      stopWatching();
      sharedAbort.abort();
    },
    { once: true },
  );
  renderShared();
}
