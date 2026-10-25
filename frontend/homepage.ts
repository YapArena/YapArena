import type { HomeData } from "../src/features/discovery/homepage-model.ts";
import type {
  HomeMetric,
  HomeRange,
} from "../src/features/discovery/homepage-chart.ts";
// Selectors and dataset values below come from the existing homepage markup.
// Non-null assertions preserve its markup guarantees without adding runtime guards.
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
/* global window, document, ResizeObserver, IntersectionObserver, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, matchMedia */
import {
  argumentsMarkup,
  cardMarkup,
  featureMarkup,
  detailMarkup,
  debatesMarkup,
  sideMarkup,
  playerMarkup,
  tickerMarkup,
  dotsMarkup,
  filtersMarkup,
} from "../src/features/discovery/homepage-view.ts";
import { emptyIdea } from "../src/features/discovery/homepage-model.ts";
import { chartGeometry } from "../src/features/discovery/homepage-chart.ts";
import { createRotationClock } from "../src/features/discovery/homepage-clock.ts";
import { html } from "../src/platform/html.ts";
import { bindHomepageChart, revealSparks } from "./homepage-chart.js";

const root = document.getElementById("ya-market-v4")!;
if (root) {
  const data: HomeData = JSON.parse(
    (document.getElementById("ya-home-data") as HTMLTemplateElement).content
      .textContent!,
  );
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
      nav = "all",
      side = "live",
      position = "YES";
    let expandedIdea = root.dataset.expanded || null,
      detailMetric: HomeMetric = "endorsement",
      detailRange: HomeRange = "1D",
      debateFilter = "all",
      activeDebate: string | null = null;
    let columns = 3,
      paused = motion.matches,
      hovered = false,
      focused = false,
      visible = true,
      tickerVisible = true,
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
    const observers: (IntersectionObserver | ResizeObserver)[] = [];
    const current = () => markets.find((m) => m.id === selected) ?? emptyIdea;
    const expanded = () => markets.find((m) => m.id === expandedIdea);
    const announce = (message: string) => {
      $("#ya-status").textContent = message;
    };
    const progress = (fraction: number) => {
      const fill = $("#ya-carousel-dots [aria-current=true] .ya-dot-fill");
      if (fill) fill.style.transform = `scaleX(${fraction})`;
    };
    const clock = createRotationClock({
      now: () => performance.now(),
      frame: requestAnimationFrame,
      cancel: cancelAnimationFrame,
      progress,
      advance: () => step(1, false),
    });
    function controls() {
      const i = markets.findIndex((m) => m.id === selected);
      $("#ya-carousel-count").textContent = `${i + 1} / ${markets.length}`;
      $("#ya-trending-slide").setAttribute(
        "aria-label",
        `${i + 1} of ${markets.length}: ${current().title}`,
      );
      $$("[data-trending]").forEach((b) =>
        b.setAttribute("aria-current", String(b.dataset.trending === selected)),
      );
      const button = $("#ya-carousel-pause");
      button.textContent = paused ? "▶" : "Ⅱ";
      button.setAttribute("aria-pressed", String(paused));
      button.setAttribute(
        "aria-label",
        paused ? "Play trending rotation" : "Pause trending rotation",
      );
      $$<HTMLButtonElement>("[data-carousel]").forEach(
        (b) => (b.disabled = markets.length < 2),
      );
    }
    function schedule() {
      root.dataset.motionPaused = String(paused || !visible || document.hidden);
      root.dataset.tickerPaused = String(
        paused || !tickerVisible || document.hidden,
      );
      if (
        disposed ||
        paused ||
        hovered ||
        focused ||
        $(".ya-ticker").matches(":hover,:focus-within") ||
        touchPinned ||
        !visible ||
        document.hidden ||
        side !== "live" ||
        markets.length < 2
      )
        clock.pause();
      else clock.resume();
    }
    function tickerProgress() {
      const animation = $(".ya-ticker-track")?.getAnimations()[0];
      const duration = Number(animation?.effect!.getTiming().duration);
      return duration
        ? (Number(animation!.currentTime ?? 0) % duration) / duration
        : 0;
    }
    function sizeTicker(progress = tickerProgress()) {
      const track = $(".ya-ticker-track"),
        group = $(".ya-ticker-group");
      if (!track || !group) return;
      const duration = Math.max(
        60000,
        (group.getBoundingClientRect().width / 24) * 1000,
      );
      track.style.setProperty("--ya-ticker-duration", duration + "ms");
      const animation = track.getAnimations()[0];
      if (animation) animation!.currentTime = progress * duration;
    }
    function revealTickerItem(item: Element) {
      const ticker = $(".ya-ticker"),
        track = $(".ya-ticker-track"),
        group = $(".ya-ticker-group"),
        animation = track?.getAnimations()[0];
      if (!animation || !group?.contains(item)) return;
      ticker.scrollLeft = 0;
      const bounds = item.getBoundingClientRect(),
        viewport = ticker.getBoundingClientRect();
      if (bounds.left >= viewport.left && bounds.right <= viewport.right)
        return;
      const width = group.getBoundingClientRect().width;
      animation!.currentTime =
        (Math.max(0, bounds.left - group.getBoundingClientRect().left - 16) /
          width) *
        Number(animation.effect!.getTiming().duration);
    }
    function moveArguments(delta: number, edge?: "start" | "end") {
      const track = $("#ya-argument-track"),
        viewport = $(".ya-arguments-window"),
        animation = track
          .getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "ya-arguments-up"),
        distance = track.getBoundingClientRect().height / 2,
        duration = Number(animation?.effect!.getTiming().duration);
      if (!animation || !distance || !duration) return false;
      const next =
        edge === "start"
          ? 0
          : edge === "end"
            ? (Math.max(0, distance - viewport.clientHeight) / distance) *
              duration
            : Number(animation!.currentTime ?? 0) +
              (delta / distance) * duration;
      animation!.currentTime = ((next % duration) + duration) % duration;
      return true;
    }
    function finishSlide() {
      animations.forEach((a) => a.cancel());
      animations = [];
      ghost?.remove();
      ghost = undefined;
    }
    function step(direction: number, manual = true) {
      if (!markets.length) return;
      const index = markets.findIndex((m) => m.id === selected);
      changeTrending(
        markets[(index + direction + markets.length) % markets.length]!.id,
        direction,
        manual,
      );
    }
    function changeTrending(id: string, direction = 1, manual = true) {
      if (!markets.some((m) => m.id === id)) return;
      if (id === selected) {
        clock.reset();
        schedule();
        return;
      }
      finishSlide();
      chartReset?.();
      clock.reset();
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
        const track = ghost.querySelector<HTMLElement>(".ya-argument-track")!;
        track.style.animation = "none";
        track.style.transform = getComputedStyle(
          $("#ya-argument-track"),
        ).transform;
        $("#ya-carousel-window").append(ghost);
      }
      selected = id;
      root.dataset.selected = id;
      side = "live";
      mainChart?.destroy();
      $(".ya-feature").innerHTML = featureMarkup(
        current(),
        following.has(id),
      ).toString();
      renderMain();
      $("#ya-side").innerHTML = sideMarkup(current()).toString();
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
      if (manual) announce(current().title + " selected in trending.");
      schedule();
    }
    function syncFollowLabels() {
      for (const b of $$(".ya-follow")) {
        const id = b.dataset.idea,
          active = following.has(id!);
        b.setAttribute("aria-pressed", String(active));
        b.textContent = active ? "✓ Following" : "+ Follow";
      }
      window.yapFollows?.initialize(root);
    }
    function renderMain() {
      const m = current(),
        track = $("#ya-argument-track");
      if (
        track.dataset.idea !== m.id ||
        track.dataset.revision !== (m.activity?.revision ?? "")
      ) {
        track.innerHTML = argumentsMarkup(m).toString();
        track.dataset.idea = m.id;
        track.dataset.revision = m.activity?.revision ?? "";
        track.style.animation = "none";
        void track.offsetHeight;
        track.style.animation = "";
      }
      $(".ya-arguments-foot").textContent = m.activity
        ? "Independent endorsements · Synthetic bots"
        : m.reference
          ? "Independent endorsement · Sample data"
          : "Argument endorsements unavailable";
      $("#ya-volume").textContent =
        m.vol === null ? "—" : m.vol.toFixed(1) + "k YC";
      $("#ya-people").textContent =
        m.people === null
          ? "—"
          : m.people + (m.activity ? " endorsements" : " people");
      $("#ya-price").textContent =
        m.price === null ? "—" : m.price.toFixed(2) + " YC";
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
      const c = chartGeometry(
        m,
        metricName,
        rangeName,
        svg.getBoundingClientRect().width,
        detail,
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
          schedule();
        },
      });
      if (detail) detailChart = chart;
      else {
        mainChart = chart;
        $("#ya-chart-debate").hidden = range !== "1D";
      }
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
      $("#ya-grid-title").textContent =
        nav === "following" ? "Your watchlist" : "Ideas in motion";
      $("#ya-grid").innerHTML = (
        items.length
          ? html`${items.map(
              (m, i) =>
                html`${cardMarkup(m, m.id === expandedIdea)}${i === insert ? detailMarkup(expanded()!, following.has(expandedIdea!)) : ""}`,
            )}`
          : html`<p class="ya-empty">${data.available === false ? "Discovery temporarily unavailable. Try again shortly." : nav === "following" && followsState === "signed-out" ? html`<a href="/account">Sign in</a> to see your followed ideas.` : nav === "following" && followsState === "unavailable" ? "Follow status is unavailable. Try again when your connection returns." : "No ideas match this view. Try another category or follow an idea above."}</p>`
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
        if (!target) {
          target = $("#ya-grid-title");
          target.tabIndex = -1;
        }
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
    function flushActivity() {
      if (
        !pendingActivity ||
        disposed ||
        hovered ||
        focused ||
        $(".ya-ticker").matches(":hover,:focus-within") ||
        touchPinned ||
        chartReset ||
        side !== "live"
      )
        return;
      const next = pendingActivity;
      pendingActivity = undefined;
      finishSlide();
      markets.splice(0, markets.length, ...next.ideas);
      if (!markets.some((m) => m.id === selected)) {
        selected = markets[0]?.id;
        clock.reset();
      }
      const tickerPhase = tickerProgress();
      $(".ya-ticker").dataset.static = String(markets.length < 2);
      $(".ya-ticker").innerHTML = tickerMarkup(markets)
        .toString()
        .replace(/^<div[^>]*>|<\/div>$/g, "");
      sizeTicker(tickerPhase);
      $("#ya-carousel-dots").innerHTML = dotsMarkup(
        markets,
        selected!,
      ).toString();
      $(".ya-filters").innerHTML = filtersMarkup({
        ...next,
        ideas: markets,
      }).toString();
      mainChart?.destroy();
      $(".ya-feature").innerHTML = featureMarkup(
        current(),
        following.has(selected!),
      ).toString();
      renderMain();
      $("#ya-side").innerHTML = sideMarkup(current()).toString();
      renderGrid();
      controls();
      progress(clock.fraction());
      schedule();
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
        if (JSON.stringify(next.ideas) !== JSON.stringify(markets)) {
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
    function review(inline: boolean) {
      const prefix = inline ? "ya-inline-" : "ya-",
        ex = $<HTMLInputElement>("#" + prefix + "expectation"),
        q = $<HTMLInputElement>("#" + prefix + "quantity");
      if (
        !ex.reportValidity() ||
        !q.reportValidity() ||
        ex.value === "" ||
        q.value === ""
      )
        return;
      const target = $("#" + prefix + "review"),
        box = document.createElement("div");
      box.className = "ya-confirm";
      box.textContent = `${inline ? $<HTMLSelectElement>("#ya-inline-position").value : position} · ${Number(q.value)} contracts · Expected YES endorsement: ${Number(ex.value)}%. Demo preview · No coins spent`;
      target.replaceChildren(box);
    }
    listen(root, "click", (event) => {
      const b = (event.target as HTMLElement).closest<HomeControl>(
        "button,[data-expand],[data-select]",
      );
      if (!b || !root.contains(b) || b.closest(".ya-carousel-ghost")) return;
      if (b.id === "ya-chart-debate" && !current().reference) {
        if (expandedIdea !== current().id)
          $$("[data-expand]")
            .find((n) => n.dataset.expand === current().id)
            ?.click();
        $("#ya-detail")?.scrollIntoView({
          block: "start",
          behavior: motion.matches ? "instant" : "smooth",
        });
        return;
      }
      if (b.dataset.expand) {
        event.preventDefault();
        const id = b.dataset.expand;
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
        return;
      }
      if (b.dataset.carousel) {
        if (b.dataset.carousel === "pause") {
          paused = !paused;
          controls();
          schedule();
        } else step(b.dataset.carousel === "next" ? 1 : -1);
        return;
      }
      if (b.dataset.trending || b.dataset.select) {
        changeTrending((b.dataset.trending ?? b.dataset.select)!);
        return;
      }
      if (b.id === "ya-arguments-toggle") {
        const value = $("#ya-arguments").dataset.paused !== "true";
        $("#ya-arguments").dataset.paused = String(value);
        b.setAttribute("aria-pressed", String(value));
        b.setAttribute(
          "aria-label",
          value ? "Resume argument flow" : "Pause argument flow",
        );
        b.textContent = value ? "▶" : "Ⅱ";
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
      if (b.dataset.inlineReview) review(true);
      if (b.dataset.detailFollow || b.id === "ya-follow") {
        const id = b.dataset.idea,
          m = markets.find((m) => m.id === id);
        if (m && (m.reference || m.demo)) localFollow(id!);
      }
      if (b.dataset.nav) {
        nav = b.dataset.nav;
        $$("[data-nav]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
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
      if (b.dataset.position) {
        position = b.dataset.position;
        $$("[data-position]").forEach((n) =>
          n.setAttribute("aria-pressed", String(n === b)),
        );
        $("#ya-review").replaceChildren();
      }
      if (
        (b.dataset.action && b.dataset.action !== "review") ||
        b.id === "ya-chart-debate"
      ) {
        side = b.dataset.action ?? "debate";
        $("#ya-side").innerHTML = sideMarkup(
          current(),
          side,
          position,
        ).toString();
        schedule();
        $("#ya-side input,#ya-side button")?.focus({ preventScroll: true });
      }
      if (b.dataset.action === "review") review(false);
    });
    listen(root, "input", (event) => {
      if ((event.target as HTMLElement).id === "ya-search") renderGrid();
      if ((event.target as HTMLElement).id.startsWith("ya-inline-"))
        $("#ya-inline-review")?.replaceChildren();
      if (
        ["ya-expectation", "ya-quantity"].includes(
          (event.target as HTMLElement).id,
        )
      )
        $("#ya-review")?.replaceChildren();
    });
    listen($<HTMLSelectElement>("#ya-sort"), "change", renderGrid);
    listen($(".ya-ticker"), "pointerenter", schedule);
    listen($(".ya-ticker"), "pointerleave", () => {
      schedule();
      flushActivity();
    });
    listen($(".ya-ticker"), "focusin", (event) => {
      queueMicrotask(() => {
        revealTickerItem(
          (event.target as HTMLElement).closest("[data-select]")!,
        );
        schedule();
      });
    });
    listen($(".ya-ticker"), "focusout", () => {
      queueMicrotask(() => {
        schedule();
        flushActivity();
      });
    });
    listen(
      $("#ya-arguments"),
      "wheel",
      (event) => {
        if (event.ctrlKey || !event.deltaY) return;
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? $(".ya-arguments-window").clientHeight
              : 1;
        if (moveArguments(event.deltaY * unit)) event.preventDefault();
      },
      { passive: false },
    );
    listen($(".ya-arguments-window"), "keydown", (event) => {
      const delta = (
        {
          ArrowDown: 60,
          ArrowUp: -60,
          PageDown: 240,
          PageUp: -240,
        } as Record<string, number>
      )[event.key];
      const edge =
        event.key === "Home"
          ? "start"
          : event.key === "End"
            ? "end"
            : undefined;
      if ((delta !== undefined || edge) && moveArguments(delta ?? 0, edge))
        event.preventDefault();
    });
    listen($("#ya-carousel"), "pointerenter", (e) => {
      if (["mouse", "pen"].includes(e.pointerType)) {
        hovered = true;
        schedule();
      }
    });
    listen($("#ya-carousel"), "pointerleave", () => {
      hovered = false;
      schedule();
      flushActivity();
    });
    listen($("#ya-carousel"), "focusin", () => {
      focused = true;
      schedule();
    });
    listen($("#ya-carousel"), "focusout", () =>
      queueMicrotask(() => {
        focused = $("#ya-carousel").contains(document.activeElement);
        schedule();
        flushActivity();
      }),
    );
    listen(root, "pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".ya-chart,.ya-scrub-control"))
        chartReset?.();
    });
    listen(document, "visibilitychange", schedule);
    listen(motion, "change", () => {
      finishSlide();
      if (motion.matches) paused = true;
      controls();
      schedule();
    });
    listen(window, "yap:follow", (e) => {
      const m = markets.find((m) => m.topicSlug === e.detail.slug && !m.demo);
      if (!m) return;
      if (e.detail.following) following.add(m.id);
      else following.delete(m.id);
      syncFollowLabels();
      if (nav === "following") renderGrid();
    });
    listen(window, "online", loadFollows);
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        ([entry]) => {
          visible = entry!.isIntersecting && entry!.intersectionRatio >= 0.2;
          schedule();
        },
        { threshold: [0, 0.2] },
      );
      observer.observe($("#ya-carousel"));
      observers.push(observer);
      const tickerObserver = new IntersectionObserver(([entry]) => {
        tickerVisible = entry!.isIntersecting;
        schedule();
      });
      tickerObserver.observe($(".ya-ticker"));
      observers.push(tickerObserver);
    }
    if (typeof ResizeObserver !== "undefined") {
      let lastWidth = $("#ya-grid").getBoundingClientRect().width,
        lastChartWidth = $("#ya-chart").getBoundingClientRect().width;
      const observer = new ResizeObserver(() => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          if (disposed) return;
          sizeTicker();
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
      observer.observe($(".ya-ticker"));
      observers.push(observer);
    }
    sizeTicker();
    renderMain();
    renderGrid();
    controls();
    schedule();
    void loadFollows();
    if (!data.reference) activityTimer = window.setTimeout(pollActivity, 5000);
    dispose = () => {
      disposed = true;
      clock.destroy();
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
