import type { HomeData } from "../src/features/discovery/homepage-model.ts";
import type {
  HomeMetric,
  HomeRange,
} from "../src/features/discovery/homepage-chart.ts";
// Selectors and dataset values below come from the server-rendered homepage
// markup (src/features/discovery/homepage-view.ts). Non-null assertions
// preserve its markup guarantees without adding runtime guards.
interface HomeDataset extends DOMStringMap {
  detailMetric?: HomeMetric;
  metric?: HomeMetric;
  detailRange?: HomeRange;
  range?: HomeRange;
}
type HomeControl = HTMLElement & { readonly dataset: HomeDataset };
type HomeChart = ReturnType<typeof bindHomepageChart>;
type HomeEventMap = HTMLElementEventMap &
  WindowEventMap &
  DocumentEventMap &
  MediaQueryListEventMap;
/* global window, document, ResizeObserver, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, matchMedia */
import {
  cardMarkup,
  trendMarkup,
  detailMarkup,
  debatesMarkup,
  playerMarkup,
  dotsMarkup,
  navMarkup,
  railMarkup,
  filtersMarkup,
} from "../src/features/discovery/homepage-view.ts";
import { chartGeometry } from "../src/features/discovery/homepage-chart.ts";
import { inscription } from "../src/features/discovery/kit-web.ts";
import { html } from "../src/platform/html.ts";
import { bindHomepageChart, revealSparks } from "./homepage-chart.js";

const root = document.getElementById("ya-market-v4")!;
const template = document.getElementById(
  "ya-home-data",
) as HTMLTemplateElement | null;
// With no ideas the page is one empty or error state and needs no controller.
if (root && template) {
  const data: HomeData = JSON.parse(template.content.textContent!);
  let dispose: (() => void) | undefined;
  function mount() {
    const $ = <T extends Element = HomeControl>(selector: string) =>
        root.querySelector<T>(selector)!,
      $$ = <T extends Element = HomeControl>(selector: string) => [
        ...root.querySelectorAll<T>(selector),
      ];
    const lifecycle = new AbortController(),
      signal = lifecycle.signal;
    const listen = <K extends keyof HomeEventMap>(
      node: EventTarget,
      event: K,
      callback: (event: HomeEventMap[K]) => void,
      options: AddEventListenerOptions = {},
    ) =>
      node.addEventListener(event, callback as EventListener, {
        ...options,
        signal,
      });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const markets = data.ideas;
    let selected = markets.some((m) => m.id === root.dataset.selected)
      ? root.dataset.selected
      : markets[0]?.id;
    let metric: HomeMetric = "endorsement",
      range: HomeRange = "1D",
      category = "All",
      nav = "all";
    let expandedIdea = root.dataset.expanded || null,
      detailMetric: HomeMetric = "endorsement",
      detailRange: HomeRange = "1D",
      debateFilter = "all",
      activeDebate: string | null = null;
    let columns = 3,
      hovered = false,
      focused = false,
      touchPinned = false;
    let ghost: HTMLElement | undefined,
      animations: Animation[] = [],
      chartReset: (() => void) | undefined,
      mainChart: HomeChart | undefined,
      detailChart: HomeChart | undefined,
      resizeFrame = 0,
      disposed = false;
    let activityTimer = 0,
      activityRevision = "",
      pendingActivity: (HomeData & { revision: string }) | undefined,
      activityBusy = false;
    let followsState = "loading";
    const following = new Set(data.following);
    const observers: ResizeObserver[] = [];
    const current = () => markets.find((m) => m.id === selected)!;
    const expanded = () => markets.find((m) => m.id === expandedIdea);
    const announce = (message: string) => {
      $("#ya-status").textContent = message;
    };
    function controls() {
      const i = markets.findIndex((m) => m.id === selected);
      $("#ya-trending-slide").setAttribute(
        "aria-label",
        `${i + 1} of ${markets.length}: ${current().title}`,
      );
      $$("[data-trending]").forEach((b) =>
        b.setAttribute("aria-current", String(b.dataset.trending === selected)),
      );
      $("#ya-carousel-nav").innerHTML = navMarkup(
        markets,
        selected!,
      ).toString();
    }
    function finishSlide() {
      animations.forEach((a) => a.cancel());
      animations = [];
      ghost?.remove();
      ghost = undefined;
    }
    function step(direction: number) {
      const index = markets.findIndex((m) => m.id === selected);
      changeTrending(
        markets[(index + direction + markets.length) % markets.length]!.id,
        direction,
      );
    }
    // The slides move together with the original 620 ms easing and direction;
    // the outgoing copy is inert, hidden and stripped of IDs.
    function changeTrending(id: string, direction = 1) {
      if (!markets.some((m) => m.id === id) || id === selected) return;
      finishSlide();
      chartReset?.();
      const slide = $("#ya-trending-slide");
      if (
        !motion.matches &&
        (slide.animate as HTMLElement["animate"] | undefined)
      ) {
        ghost = slide.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("id");
        ghost
          .querySelectorAll(
            "[id],[for],[aria-controls],[aria-labelledby],[aria-describedby]",
          )
          .forEach((node) =>
            [
              "id",
              "for",
              "aria-controls",
              "aria-labelledby",
              "aria-describedby",
            ].forEach((a) => node.removeAttribute(a)),
          );
        ghost
          .querySelectorAll<
            HTMLButtonElement | HTMLInputElement | HTMLSelectElement
          >("button,input,select")
          .forEach((node) => (node.disabled = true));
        ghost.classList.add("ya-carousel-ghost");
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        $("#ya-carousel-window").append(ghost);
      }
      selected = id;
      root.dataset.selected = id;
      mainChart?.destroy();
      slide.innerHTML = trendMarkup(current(), following.has(id)).toString();
      renderMain();
      controls();
      if (ghost) {
        const old = ghost,
          options: KeyframeAnimationOptions = {
            duration: 620,
            easing: "cubic-bezier(.22,.68,.16,1)",
            fill: "both",
          };
        const enter = slide.animate(
          [
            { transform: `translateX(${direction * 104}%)` },
            { transform: "translateX(0)" },
          ],
          options,
        );
        animations = [
          enter,
          old.animate(
            [
              { transform: "translateX(0)" },
              { transform: `translateX(${-direction * 104}%)` },
            ],
            options,
          ),
        ];
        enter.finished
          .then(() => {
            if (ghost === old) finishSlide();
          })
          .catch(() => {});
      }
      announce(current().title + " selected in trending.");
    }
    function syncFollowLabels() {
      for (const b of $$(".ya-follow")) {
        const id = b.dataset.idea,
          active = following.has(id!);
        b.setAttribute("aria-pressed", String(active));
        if (b.classList.contains("ya-bookmark"))
          b.setAttribute(
            "aria-label",
            active ? "Following this idea" : "Follow this idea",
          );
        else b.textContent = active ? "✓ Following" : "+ Follow";
      }
      window.yapFollows?.initialize(root);
    }
    function renderMain() {
      $$("[data-metric]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.metric === metric)),
      );
      $$("[data-range]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.range === range)),
      );
      renderChart(false);
      syncFollowLabels();
    }
    function renderChart(detail: boolean) {
      const m = detail ? expanded() : current(),
        svg = $<SVGSVGElement>(detail ? "#ya-detail-chart" : "#ya-chart");
      if (!svg || !m) return;
      if (detail) detailChart?.destroy();
      else mainChart?.destroy();
      const metricName = detail ? detailMetric : metric,
        rangeName = detail ? detailRange : range;
      const box = svg.getBoundingClientRect();
      const c = chartGeometry(
        m,
        metricName,
        rangeName,
        box.width,
        detail,
        box.height,
      );
      svg.setAttribute("viewBox", `0 0 ${c.w} ${c.h}`);
      svg.dataset.latestRound = m.activity?.items.at(-1)?.id ?? "";
      svg.innerHTML = c.markup.toString();
      const chart = bindHomepageChart({
        root,
        svg,
        m,
        metric: metricName,
        range: rangeName,
        c,
        activate(reset) {
          if (chartReset && chartReset !== reset) chartReset();
          chartReset = reset;
        },
        deactivate(reset) {
          if (chartReset === reset) chartReset = undefined;
          queueMicrotask(flushActivity);
        },
        pin(value) {
          touchPinned = value;
        },
      });
      if (detail) detailChart = chart;
      else mainChart = chart;
    }
    function renderDebates() {
      if (!expanded()) return;
      $("#ya-debate-grid").innerHTML = debatesMarkup(
        expanded()!,
        debateFilter,
        activeDebate,
      ).toString();
      renderPlayer();
    }
    function renderPlayer() {
      const target = $("#ya-player-preview");
      if (!target) return;
      const d = expanded()?.debates.find((d) => d.id === activeDebate);
      target.hidden = !d;
      if (d) target.innerHTML = playerMarkup(expanded()!, d).toString();
      else target.replaceChildren();
    }
    // An expanded idea takes the full grid row right after its card's row.
    function renderGrid() {
      const focus = document.activeElement as HTMLElement | null;
      const focusKey = focus?.dataset.expand;
      const focusData =
        focus && root.contains(focus) ? { ...focus.dataset } : null;
      const focusSlider =
        focus?.closest(".ya-detail") && focus.matches('input[type="range"]')
          ? (focus as HTMLInputElement).value
          : null;
      let items = markets.filter(
        (m) =>
          (category === "All" || m.cat === category) &&
          (nav !== "following" || following.has(m.id)) &&
          m.title
            .toLocaleLowerCase()
            .includes(
              $<HTMLInputElement>("#ya-search")
                .value.trim()
                .toLocaleLowerCase(),
            ),
      );
      items = items.sort((a, b) =>
        $<HTMLSelectElement>("#ya-sort").value === "moves"
          ? Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)
          : (b.vol ?? b.debates.length) - (a.vol ?? a.debates.length),
      );
      columns = Math.max(
        1,
        getComputedStyle($("#ya-grid")).gridTemplateColumns.trim().split(/\s+/)
          .length,
      );
      const index = items.findIndex((m) => m.id === expandedIdea);
      const insert =
        index < 0
          ? -1
          : Math.min(
              items.length - 1,
              Math.floor(index / columns) * columns + columns - 1,
            );
      if (index < 0) {
        expandedIdea = null;
        root.dataset.expanded = "";
      }
      detailChart?.destroy();
      detailChart = undefined;
      $("#ya-grid-title").innerHTML = inscription(
        nav === "following" ? "Your watchlist" : "Ideas in motion",
      ).toString();
      $("#ya-grid").innerHTML = (
        items.length
          ? html`${items.map(
              (m, i) =>
                html`${cardMarkup(m, m.id === expandedIdea)}${i === insert ? detailMarkup(expanded()!, following.has(expandedIdea!)) : ""}`,
            )}`
          : nav === "following"
            ? html`<div class="state state-quiet ya-empty"><h3>${inscription(followsState === "signed-out" ? "Sign in to follow ideas." : "No followed ideas yet.")}</h3><p>${followsState === "signed-out" ? "Ideas you follow appear here." : followsState === "unavailable" ? "Follow status is unavailable. Try again when your connection returns." : "Follow an idea to keep it here."}</p>${followsState === "signed-out" ? html`<a class="btn btn-secondary" href="/account">Sign in</a>` : html`<button class="btn btn-secondary" type="button" data-nav="all">Show all ideas</button>`}</div>`
            : html`<p class="ya-empty">No ideas match this view. Try another category or follow an idea above.</p>`
      ).toString();
      revealSparks($("#ya-grid"));
      if (insert >= 0) {
        $$("[data-detail-metric]").forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.detailMetric === detailMetric),
          ),
        );
        $$("[data-detail-range]").forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.detailRange === detailRange),
          ),
        );
        $$("[data-debate-filter]").forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.debateFilter === debateFilter),
          ),
        );
        renderChart(true);
        renderDebates();
      }
      syncFollowLabels();
      if (focusKey) {
        $$("[data-expand]")
          .find((b) => b.dataset.expand === focusKey)
          ?.focus({ preventScroll: true });
      } else if (focusData && !focus!.isConnected) {
        const keys = [
          "detailClose",
          "detailMetric",
          "detailRange",
          "debateFilter",
          "detailFollow",
          "openDebate",
        ];
        let target =
          focusSlider !== null
            ? $(".ya-detail .ya-scrub-control input")
            : $$("#ya-detail button").find((b) =>
                keys.some(
                  (key) =>
                    focusData[key] !== undefined &&
                    b.dataset[key] === focusData[key],
                ),
              );
        if (!target) target = $("#ya-grid-title");
        if (focusSlider !== null && target.matches('input[type="range"]'))
          (target as HTMLInputElement).value = focusSlider;
        target.focus({ preventScroll: true });
      }
    }
    function localFollow(id: string) {
      if (following.has(id)) following.delete(id);
      else following.add(id);
      syncFollowLabels();
      if (nav === "following") renderGrid();
      announce(
        following.has(id)
          ? "Demo follow added locally."
          : "Demo follow removed locally.",
      );
    }
    async function loadFollows() {
      const real = markets.filter(
        (m) => m.topicSlug && !m.reference && !m.demo,
      );
      if (!real.length) {
        followsState = "ready";
        return;
      }
      const results = await Promise.allSettled(
        real.map((m) => window.yapFollows.read("topics", m.topicSlug!)),
      );
      if (disposed) return;
      followsState = "ready";
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          if (result.value) following.add(real[i]!.id);
          else following.delete(real[i]!.id);
        } else
          followsState =
            (result.reason as { status?: number }).status === 401
              ? "signed-out"
              : "unavailable";
      });
      syncFollowLabels();
      if (nav === "following") renderGrid();
    }
    // New activity waits while someone is reading or inspecting the card.
    function flushActivity() {
      if (
        !pendingActivity ||
        disposed ||
        hovered ||
        focused ||
        touchPinned ||
        chartReset
      )
        return;
      const next = pendingActivity;
      pendingActivity = undefined;
      finishSlide();
      markets.splice(0, markets.length, ...next.ideas);
      if (!markets.some((m) => m.id === selected)) selected = markets[0]?.id;
      if (!selected) return;
      $("#ya-carousel-dots").innerHTML = dotsMarkup(
        markets,
        selected,
      ).toString();
      $(".ya-filters").innerHTML = filtersMarkup({
        ...next,
        ideas: markets,
      }).toString();
      $("#ya-rail").innerHTML = railMarkup({
        ...next,
        ideas: markets,
      }).toString();
      mainChart?.destroy();
      $("#ya-trending-slide").innerHTML = trendMarkup(
        current(),
        following.has(selected),
      ).toString();
      renderMain();
      renderGrid();
      controls();
      void loadFollows();
    }
    async function pollActivity() {
      if (disposed || data.reference) return;
      try {
        if (document.hidden || activityBusy) return;
        activityBusy = true;
        const response = await fetch(
          `/api/public/homepage${activityRevision ? "?revision=" + encodeURIComponent(activityRevision) : ""}`,
          { cache: "no-store", signal },
        );
        if (response.status === 204) return;
        if (!response.ok) throw new Error("Activity refresh unavailable");
        const next: HomeData & { revision: string } = await response.json();
        activityRevision = next.revision;
        if (
          next.ideas.length &&
          JSON.stringify(next.ideas) !== JSON.stringify(markets)
        ) {
          pendingActivity = next;
          flushActivity();
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError")
          announce(
            "Activity updates are temporarily unavailable. Showing the last loaded results.",
          );
      } finally {
        activityBusy = false;
        if (!disposed) activityTimer = window.setTimeout(pollActivity, 5000);
      }
    }
    function review() {
      const ex = $<HTMLInputElement>("#ya-inline-expectation"),
        q = $<HTMLInputElement>("#ya-inline-quantity");
      if (
        !ex.reportValidity() ||
        !q.reportValidity() ||
        ex.value === "" ||
        q.value === ""
      )
        return;
      const box = document.createElement("div");
      box.className = "ya-confirm";
      box.textContent = `${$<HTMLSelectElement>("#ya-inline-position").value} · ${Number(q.value)} contracts · Expected YES endorsement: ${Number(ex.value)}%. Demo preview · No coins spent`;
      $("#ya-inline-review").replaceChildren(box);
    }
    function expand(id: string) {
      expandedIdea = expandedIdea === id ? null : id;
      root.dataset.expanded = expandedIdea ?? "";
      detailMetric = "endorsement";
      detailRange = "1D";
      debateFilter = "all";
      activeDebate = null;
      renderGrid();
      const panel = $("#ya-detail");
      if (panel && !motion.matches)
        panel.animate(
          [
            { maxHeight: "0px", opacity: 0.75 },
            { maxHeight: panel.scrollHeight + "px", opacity: 1 },
          ],
          { duration: 260, easing: "ease-out" },
        );
      announce(
        expandedIdea
          ? "Expanded " +
              expanded()!.title +
              ". Large chart, live debates, and replays are below."
          : "Idea closed.",
      );
    }
    listen(root, "click", (event) => {
      const b = (event.target as HTMLElement).closest<HomeControl>(
        "button,[data-expand],[data-open-idea]",
      );
      if (!b || !root.contains(b) || b.closest(".ya-carousel-ghost")) return;
      // Sample ideas have no page: their links open the idea's panel below.
      if (b.dataset.openIdea) {
        event.preventDefault();
        const id = b.dataset.openIdea;
        if (category !== "All" || nav !== "all") {
          category = "All";
          nav = "all";
          $$("[data-filter]").forEach((n) =>
            n.setAttribute("aria-pressed", String(n.dataset.filter === "All")),
          );
          $$("[data-nav]").forEach((n) =>
            n.setAttribute("aria-pressed", String(n.dataset.nav === "all")),
          );
        }
        if (expandedIdea !== id) expand(id);
        $("#ya-detail")?.scrollIntoView({
          block: "start",
          behavior: motion.matches ? "instant" : "smooth",
        });
        return;
      }
      if (b.dataset.expand) {
        event.preventDefault();
        expand(b.dataset.expand);
        return;
      }
      if (b.dataset.carousel) {
        step(b.dataset.carousel === "next" ? 1 : -1);
        return;
      }
      if (b.dataset.trending) {
        changeTrending(b.dataset.trending);
        return;
      }
      if (b.dataset.detailClose) {
        const id = expandedIdea;
        expandedIdea = null;
        root.dataset.expanded = "";
        activeDebate = null;
        renderGrid();
        $$("[data-expand]")
          .find((n) => n.dataset.expand === id)
          ?.focus({ preventScroll: true });
        announce("Idea closed.");
        return;
      }
      if (b.dataset.detailMetric) {
        detailMetric = b.dataset.detailMetric;
        $$("[data-detail-metric]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        renderChart(true);
      }
      if (b.dataset.detailRange) {
        detailRange = b.dataset.detailRange;
        $$("[data-detail-range]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        renderChart(true);
      }
      if (b.dataset.debateFilter) {
        debateFilter = b.dataset.debateFilter;
        activeDebate = null;
        $$("[data-debate-filter]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        renderDebates();
      }
      if (b.dataset.openDebate) {
        activeDebate =
          activeDebate === b.dataset.openDebate ? null : b.dataset.openDebate;
        $$("[data-open-debate]").forEach((n) =>
          n.setAttribute(
            "aria-pressed",
            String(n.dataset.openDebate === activeDebate),
          ),
        );
        renderPlayer();
        announce(
          activeDebate
            ? "Debate preview opened below."
            : "Debate preview closed.",
        );
      }
      if (b.dataset.playerClose) {
        activeDebate = null;
        renderDebates();
        $("[data-open-debate]")?.focus({ preventScroll: true });
      }
      if (b.dataset.inlineEnter) {
        $("#ya-inline-round").hidden = false;
        $<HTMLSelectElement>("#ya-inline-position").focus({
          preventScroll: true,
        });
      }
      if (b.dataset.inlineReview) review();
      if (b.dataset.detailFollow || b.id === "ya-follow") {
        const id = b.dataset.idea,
          m = markets.find((m) => m.id === id);
        if (m && (m.reference || m.demo)) localFollow(id!);
      }
      if (b.dataset.nav) {
        nav = b.dataset.nav;
        $$("[data-nav]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n.dataset.nav === nav)),
        );
        renderGrid();
      }
      if (b.dataset.filter) {
        category = b.dataset.filter;
        $$("[data-filter]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        renderGrid();
      }
      if (b.dataset.metric) {
        metric = b.dataset.metric;
        renderMain();
      }
      if (b.dataset.range) {
        range = b.dataset.range;
        $$("[data-range]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        renderChart(false);
      }
    });
    listen(root, "input", (event) => {
      if ((event.target as HTMLElement).id === "ya-search") renderGrid();
      if ((event.target as HTMLElement).id.startsWith("ya-inline-"))
        $("#ya-inline-review")?.replaceChildren();
    });
    listen($<HTMLSelectElement>("#ya-sort"), "change", renderGrid);
    listen($("#ya-carousel"), "pointerenter", (e) => {
      if (["mouse", "pen"].includes(e.pointerType)) hovered = true;
    });
    listen($("#ya-carousel"), "pointerleave", () => {
      hovered = false;
      flushActivity();
    });
    listen($("#ya-carousel"), "focusin", () => {
      focused = true;
    });
    listen($("#ya-carousel"), "focusout", () =>
      queueMicrotask(() => {
        focused = $("#ya-carousel").contains(document.activeElement);
        flushActivity();
      }),
    );
    listen(root, "pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".ya-chart,.ya-scrub-control"))
        chartReset?.();
    });
    listen(motion, "change", finishSlide);
    listen(window, "yap:follow", (e) => {
      const m = markets.find((m) => m.topicSlug === e.detail.slug && !m.demo);
      if (!m) return;
      if (e.detail.following) following.add(m.id);
      else following.delete(m.id);
      syncFollowLabels();
      if (nav === "following") renderGrid();
    });
    listen(window, "online", loadFollows);
    if (typeof ResizeObserver !== "undefined") {
      let lastWidth = $("#ya-grid").getBoundingClientRect().width,
        lastChartWidth = $("#ya-chart").getBoundingClientRect().width;
      const observer = new ResizeObserver(() => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          if (disposed) return;
          const width = $("#ya-grid").getBoundingClientRect().width;
          const chartWidth = $("#ya-chart").getBoundingClientRect().width;
          const gridChanged = Math.abs(width - lastWidth) > 1,
            chartChanged = Math.abs(chartWidth - lastChartWidth) > 1;
          if (!gridChanged && !chartChanged) return;
          lastWidth = width;
          lastChartWidth = chartWidth;
          renderChart(false);
          if (gridChanged) renderGrid();
          else if (expandedIdea) renderChart(true);
        });
      });
      observer.observe($("#ya-grid"));
      observer.observe($("#ya-carousel-window"));
      observers.push(observer);
    }
    renderMain();
    renderGrid();
    controls();
    void loadFollows();
    if (!data.reference) activityTimer = window.setTimeout(pollActivity, 5000);
    dispose = () => {
      disposed = true;
      window.clearTimeout(activityTimer);
      finishSlide();
      mainChart?.destroy();
      detailChart?.destroy();
      cancelAnimationFrame(resizeFrame);
      observers.forEach((o) => o.disconnect());
      lifecycle.abort();
    };
    listen(window, "pagehide", dispose, { once: true });
  }
  mount();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      dispose?.();
      mount();
    }
  });
}
