import type {
  Auth,
  Commitment,
  Publication,
  Round,
  Run,
  Runs,
  SelectedRun,
  SharedActivity,
  Timeline,
  Workspace,
  RoundPoint,
} from "./arena-types.js";
// The run view carries the database clock its round deadlines use.
type TimedWorkspace = Omit<Workspace, "run"> & {
  run: (Run & { serverNow?: string }) | null;
};
interface InlineElements {
  runs: HTMLSelectElement;
  argument: HTMLInputElement;
  review: HTMLDialogElement;
  form: HTMLFormElement & {
    elements: HTMLFormControlsCollection & { quantity: HTMLInputElement };
  };
  setup: HTMLDetailsElement;
  publish: HTMLInputElement;
  commit: HTMLButtonElement;
}
/* global document, Option, window */
import {
  createRoundChart,
  sharePercent,
  roundProgress,
} from "./arena-chart.js";
import { createPriceInspector } from "./arena-price.js";
import {
  createDeadlineFollower,
  roundDeadlines,
  roundStates,
  watchRoom,
} from "./community-stream.js";
import { html } from "../src/platform/html.ts";
// These selectors refer to the fixed arena server-rendered markup.
const root = document.querySelector<HTMLElement>("[data-a4-inline]")!;
if (root) {
  const el = <K extends string>(name: K) =>
    root.querySelector<
      K extends keyof InlineElements ? InlineElements[K] : HTMLElement
    >(`[data-inline-${name}]`)!;
  const ui = (name: string) =>
    root.querySelector<HTMLElement>(`[data-arena-${name}]`)!;
  const status = (text: string) => {
    if (el("status").textContent !== text) el("status").textContent = text;
    el("status").title = text;
  };
  const money = (value: string | number | bigint = "0", precision = 6) => {
    const n = BigInt(value),
      a = n < 0n ? -n : n;
    const fractional = String(a % 1000000n)
      .padStart(6, "0")
      .slice(0, precision);
    return `${n < 0n ? "−" : ""}${a / 1000000n}${precision ? "." + fractional : ""} Yap Coins`;
  };
  let userId: string | null | undefined,
    run: SelectedRun | null | undefined,
    pending: Commitment | null | undefined,
    timeline: Timeline | null | undefined,
    selectedRound: string | null | undefined,
    busy = false,
    listSignature: string | undefined,
    defaultPrice: RoundPoint | null | undefined;
  const sharedTemplate = root.querySelector<HTMLTemplateElement>(
    "[data-shared-bootstrap]",
  );
  let shared: SharedActivity | null = sharedTemplate
    ? JSON.parse(sharedTemplate.content.textContent!)
    : null;
  let usingShared = Boolean(shared?.items.length),
    sharedSelected: string | undefined,
    historyChoice = false,
    sharedTimer: ReturnType<typeof setInterval>,
    sharedBusy = false;
  let accessEpoch = 0;
  let accessRefreshPending = false;
  // Private data refreshes after the viewer's own actions, at known round
  // deadlines, on human-round signals and otherwise every 30 seconds. Signal
  // reads are spread over a few seconds so a room's viewers do not read at once.
  let serverOffset = 0,
    lastPrivate = 0,
    privateDueAt: number | null = null,
    privateFollowUp: number | null = null,
    lastShared = Date.now(),
    sharedDueAt: number | null = null,
    roomLive = false;
  const spread = () => Date.now() + Math.random() * 3000;
  const followDeadline = createDeadlineFollower();
  // Keep a draft off the visible document until its original account is verified.
  // A guest's initiating draft may survive sign-in; another account's draft may not.
  let detachedArgument: { owner: string | null; value: string } | null = null;
  const sharedAbort = new AbortController();
  const selectRound = (item: RoundPoint) =>
    act(async () => {
      if (usingShared) {
        sharedSelected = item.id;
        renderShared();
        return;
      }
      selectedRound = item.id;
      run = { id: item.runId! };
      await list(run.id);
      await refresh();
    });
  const prices = createPriceInspector(root, (item) => {
    chart.preview(item.id);
    selectRound(item);
  });
  const chart = createRoundChart(root, selectRound, (point) => {
    prices.show(point ?? defaultPrice);
  });
  function clearPrivate() {
    userId = null;
    run = null;
    pending = null;
    timeline = null;
    selectedRound = null;
    listSignature = undefined;
    el("runs").replaceChildren(new Option("Choose a round", ""));
    el("argument").value = "";
    el("review").close();
    el("terms").textContent = "";
    el("review-status").textContent = "";
    el("access").hidden = true;
    el("receipt").textContent = "Sign in to view your commitments.";
    ui("history").textContent = "Sign in to view your history.";
    defaultPrice = null;
    prices.clear();
    ui("volume").textContent = "— Yap Coins";
    ui("participants").textContent = "Finalized commitments";
    ui("available").textContent = "Your balance —";
    ui("trade-title").textContent = "Bots sandbox";
    ui("round-label").textContent = "Round history";
    ui("round-state").textContent = "waiting";
    ui("countdown").dataset.opens = "";
    ui("countdown").dataset.closes = "";
    ui("countdown").dataset.state = "";
    countdown();
    ui("yes").textContent = "—";
    ui("no").textContent = "—";
    ui("sentiment-bar").style.removeProperty("--yes-share");
    ui("sentiment-bar").dataset.empty = "true";
    ui("signin").hidden = false;
    chart.clear();
    window.dispatchEvent(new CustomEvent("yap:balance", { detail: null }));
    renderShared();
  }
  async function api<T>(
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const epoch = accessEpoch;
    const response = await fetch(`/api/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result: T & { error?: string } = await response.json();
    if (epoch !== accessEpoch)
      throw new Error(
        "Account changed. Review the current account before continuing.",
      );
    if (!response.ok) {
      if (response.status === 401) {
        detachedArgument = null;
        clearPrivate();
      }
      if (
        response.status === 404 &&
        (path.includes("/timeline") || path.includes("/workspace"))
      ) {
        timeline = null;
        chart.clear("This debate's settled history is unavailable.");
        defaultPrice = null;
        prices.clear();
        ui("volume").textContent = "— Yap Coins";
        ui("participants").textContent = "History unavailable";
        ui("yes").textContent = "—";
        ui("no").textContent = "—";
        ui("sentiment-bar").dataset.empty = "true";
      }
      throw Object.assign(
        new Error(result.error ?? "Unable to load Yap Coins"),
        { status: response.status },
      );
    }
    return result;
  }
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    const epoch = accessEpoch;
    try {
      await work();
    } catch (error) {
      if (epoch !== accessEpoch) return;
      status((error as Error).message);
      ui("sync").textContent =
        shared?.items.length && !userId
          ? "Shared synthetic history · connected"
          : "Connection interrupted · retrying";
    } finally {
      busy = false;
      if (accessRefreshPending) {
        accessRefreshPending = false;
        void act(refreshAccess);
      }
    }
  }
  async function list(selected?: string) {
    const owner = userId;
    const data = await api<Runs>(
      `a4/runs?debateId=${encodeURIComponent(root.dataset.a4Inline!)}`,
    );
    if (owner !== userId) return;
    const next = populateRuns(data, selected);
    run = next ? { id: next } : null;
  }
  function populateRuns(data: Runs, selected?: string) {
    const signature = JSON.stringify([data.items, selected]);
    if (signature === listSignature) return el("runs").value;
    listSignature = signature;
    const items = data.items.filter((r) => r.mode !== "observer");
    const next =
      selected ?? items.find((r) => r.state === "running")?.id ?? items[0]?.id;
    el("runs").replaceChildren(
      new Option("Choose a round", ""),
      ...items.map(
        (r) =>
          new Option(
            `${r.mode === "mixed" ? "BOTS + YOU" : "Human-only"} · ${r.argumentLabel || r.id.slice(0, 8)} · ${r.state}`,
            r.id,
          ),
      ),
    );
    if (next && !items.some((r) => r.id === next))
      el("runs").add(new Option("Selected historical run", next));
    if (next) {
      el("runs").value = next;
    }
    return next;
  }
  function renderReceipts() {
    // The existing truthy filter selects only rounds with a receipt.
    const receipts = (run?.rounds!.filter((r) => r.receipt) ?? []) as (Round & {
      receipt: NonNullable<Round["receipt"]>;
    })[];
    const open = receipts.filter((r) => !r.revealed && r.state !== "void");
    const history = receipts.filter((r) => r.revealed || r.state === "void");
    ui("open-count").textContent = `(${open.length})`;
    const table = (
      rows: (Round & { receipt: NonNullable<Round["receipt"]> })[],
    ) =>
      html`<div class="arena-table-scroll"><table class="arena-order-table"><thead><tr><th>Side</th><th>Contracts</th><th>Limit</th><th>Status</th></tr></thead><tbody>${rows.map((r) => html`<tr><td class="${r.receipt.side === "YES" ? "yes" : "no"}">${r.receipt.side}</td><td>${r.receipt.quantity}</td><td>${r.receipt.limit}</td><td>${r.receipt.status.replaceAll("_", " ")}</td></tr><tr class="arena-receipt-detail"><td colspan="4">Round ${r.period} · reserved ${money(r.receipt.reserved)}${r.receipt.premium !== undefined ? html` · premium ${money(r.receipt.premium)} · fee ${money(r.receipt.fee)} · released ${money(r.receipt.released)}` : " · Binding commitment recorded"}${r.receipt.payout !== undefined ? html`<br>Payout ${money(r.receipt.payout)} · net ${money(r.receipt.net)}` : " · Awaiting final reveal"}</td></tr>`)}</tbody></table></div>`;
    el("receipt").innerHTML = (
      open.length
        ? table(open)
        : html`<p class="arena-order-empty">No open commitments in this run.</p>`
    ).toString();
    ui("history").innerHTML = (
      history.length
        ? table(history)
        : html`<p class="arena-order-empty">No settled commitments in this run yet.</p>`
    ).toString();
  }
  function describeSelection() {
    const active =
      run?.rounds!.find((r) => r.id === selectedRound) ??
      run?.rounds!.find((r) => r.state === "open") ??
      run?.rounds!.at(-1);
    if (active) selectedRound = active.id;
    const historical = timeline?.items.find((r) => r.id === selectedRound);
    const number =
      historical?.number ??
      (timeline?.items.at(-1)?.number ?? 0) + (active?.period ?? 1);
    ui("round-label").textContent = active
      ? `Round ${number}`
      : "Round history";
    ui("round-state").textContent =
      active?.state === "open" ? "open" : (active?.state ?? "waiting");
    ui("round-state").classList.toggle("is-open", active?.state === "open");
    ui("trade-title").textContent = active
      ? `Bots sandbox · Round ${number}`
      : "Bots sandbox";
    ui("countdown").dataset.closes = active?.closesAt ?? "";
    ui("countdown").dataset.opens = active?.opensAt ?? "";
    ui("countdown").dataset.state = active?.state ?? "";
    const selected =
      historical ?? timeline?.items.findLast((r) => r.share !== null);
    const share = sharePercent(selected?.share);
    ui("yes").textContent = share === null ? "—" : `${share.toFixed(1)}%`;
    ui("no").textContent =
      share === null ? "—" : `${(100 - share).toFixed(1)}%`;
    ui("sentiment-caption").textContent = selected
      ? `Settled round ${selected.number}`
      : "Latest revealed round";
    ui("sentiment-bar").style.setProperty(
      "--yes-share",
      share === null ? "0%" : `${share}%`,
    );
    ui("sentiment-bar").dataset.empty = String(share === null);
    ui("sentiment-bar").setAttribute(
      "aria-label",
      share === null
        ? "No settled endorsement share yet"
        : `YES ${share.toFixed(1)}%, NO ${(100 - share).toFixed(1)}%`,
    );
    const open = run?.rounds!.find(
      (r) =>
        r.state === "open" &&
        new Date(r.closesAt).getTime() > Date.now() + serverOffset,
    );
    el("form").hidden = !open || !!open.receipt || run?.state !== "running";
    ui("commit-closed").hidden = !el("form").hidden;
    ui("commit-closed").textContent = open?.receipt
      ? "Your commitment is recorded. Continue watching while the round settles."
      : run?.state === "complete"
        ? "This run has settled. Inspect its results or start another round."
        : run
          ? "The round is processing. Your existing commitment remains recorded."
          : "Choose a round or start a sandbox to participate.";
    // Workspace/shared responses provide the timeline before this renderer runs.
    defaultPrice = timeline!.items.at(-1);
    prices.update(timeline!);
    countdown();
  }
  function countdown() {
    if (usingShared && !userId && shared?.items.length) {
      ui("countdown").textContent = "Shared settled history";
      return;
    }
    const node = ui("countdown");
    const progress = ui("round-progress");
    const { percent, seconds } = roundProgress(
      node.dataset.opens,
      node.dataset.closes,
      Date.now() + serverOffset,
    );
    const open = node.dataset.state === "open";
    progress.style.setProperty("--round-remaining", `${open ? percent : 0}%`);
    progress.dataset.urgent = String(open && seconds <= 10);
    progress.setAttribute(
      "aria-valuenow",
      String(open ? Math.round(percent) : 0),
    );
    progress.setAttribute(
      "aria-valuetext",
      open
        ? `${seconds} seconds remaining`
        : node.dataset.state === "settled"
          ? "Round settled"
          : "Waiting for an open round",
    );
    if (!node.dataset.closes) {
      node.textContent = "Waiting for a round";
      return;
    }
    if (node.dataset.state !== "open") {
      node.textContent =
        node.dataset.state === "settled"
          ? "Final result revealed"
          : "Awaiting final reveal";
      return;
    }
    node.textContent = seconds
      ? `Ends in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : "Cutoff reached · processing";
  }
  function updateEstimate() {
    const fields = new FormData(el("form")),
      q = Number(fields.get("quantity")),
      side = fields.get("side");
    ui("order-help").textContent =
      side === "NO"
        ? "A NO contract pays the final NO share. A ceiling of 0.78 corresponds to a YES-scale floor of 0.22."
        : "A YES contract pays the final YES share. Your ceiling sets the highest purchase price you accept.";
    const fee = run?.config!.feeBps ?? 0;
    ui("reservation").textContent =
      Number.isInteger(q) && q >= 1 && q <= 100
        ? `${q} contracts · maximum reservation ${money((BigInt(q) * 1000000n * BigInt(10000 + fee)) / 10000n, 2)}`
        : "Choose 1–100 contracts.";
  }
  async function refresh() {
    const owner = userId;
    // A signal during this request asks for another read; a failed read
    // waits for the slow interval rather than its passed deadline.
    privateDueAt = null;
    privateFollowUp = null;
    lastPrivate = Date.now();
    const data = await api<TimedWorkspace>(
      `a4/debates/${root.dataset.a4Inline}/workspace${run ? `?runId=${encodeURIComponent(run.id)}` : ""}`,
    );
    if (owner !== userId) return;
    if (data.run?.serverNow)
      serverOffset = new Date(data.run.serverNow).getTime() - Date.now();
    if (data.accountId !== userId) {
      clearPrivate();
      throw new Error("Account changed. Reload before reviewing a commitment.");
    }
    populateRuns(data.runs, run?.id ?? "");
    run = data.run;
    const follow = followDeadline(
      roundDeadlines(run),
      roundStates(run),
      Date.now() + serverOffset,
    );
    privateFollowUp = follow === null ? null : Date.now() + follow;
    if (el("setup").dataset.runId !== (run?.id ?? "")) {
      el("setup").open = !run;
      el("setup").dataset.runId = run?.id ?? "";
    }
    const wallet = data.wallet;
    const balances = wallet.balances,
      available = balances.find((b) => b.kind === "available")?.amount ?? "0",
      reserved = balances.find((b) => b.kind === "reserved")?.amount ?? "0";
    ui("available").textContent = `Your balance ${money(available, 2)}`;
    el("balance").textContent =
      `Reserved ${money(reserved, 2)} · ${run?.mode === "mixed" ? "Private bot sandbox balance" : "Ordinary play balance"}`;
    window.dispatchEvent(
      new CustomEvent("yap:balance", {
        detail: {
          available,
          reserved,
          scope: run?.mode === "mixed" ? "Bot sandbox" : "Ordinary balance",
        },
      }),
    );
    el("bots").hidden =
      wallet.mode === "yap-coins" || wallet.mode === "disabled";
    timeline = usingShared && shared?.items.length ? shared : data.timeline;
    describeSelection();
    chart.render(timeline!, selectedRound);
    renderReceipts();
    updateEstimate();
    ui("volume").textContent = money(timeline!.totals.premium, 2);
    ui("participants").textContent =
      `${timeline!.totals.humanCommitments.toLocaleString()} human commitments${timeline!.totals.botCommitments ? ` · ${timeline!.totals.botCommitments.toLocaleString()} bot commitments` : ""}`;
    ui("scope").textContent =
      timeline!.scope === "sandbox"
        ? "Your private synthetic bot sandboxes · latest 100 settled rounds"
        : "Human-only activity · latest 100 settled rounds";
    ui("sync").textContent = "● Connected · updates after settlement";
    status(
      run
        ? `${run.mode === "mixed" ? run!.config!.population + " synthetic bots + you" : "Human-only round"} · ${run.state}. ${run!.config!.feeBps ? "5% premium fee." : "No fee."} ${run.state === "complete" ? "Final results are available." : "Diagnostics stay sealed until final reveal."}`
        : "Choose a round or start a labeled sandbox.",
    );
    if (usingShared) renderShared();
  }
  // Founder (2026-10-26, Decision 0013): YAP human rounds and the daily play
  // refill are retired here; only the labeled Bots sandbox stays on the page.
  async function create(mode: "mixed") {
    const result = await api<{ id: string }>("a4/runs", {
      debateId: root.dataset.a4Inline,
      mode,
      ...(el("argument").value.trim()
        ? { config: { argumentLabel: el("argument").value.trim() } }
        : {}),
    });
    selectedRound = null;
    el("argument").value = "";
    el("setup").open = false;
    run = { id: result.id };
    await list(result.id);
    await refresh();
  }
  el("bots").addEventListener("click", () => act(() => create("mixed")));
  el("publish").addEventListener("change", () =>
    act(async () => {
      const epoch = accessEpoch;
      try {
        const result = await api<Publication>("a4/publication", {
          published: el("publish").checked,
        });
        el("publish").checked = result.published;
        await loadShared();
      } catch (error) {
        if (epoch === accessEpoch)
          el("publish").checked = !el("publish").checked;
        throw error;
      }
    }),
  );
  el("refresh").addEventListener("click", () =>
    act(async () => {
      await list(run?.id);
      await refresh();
    }),
  );
  el("runs").addEventListener("change", () =>
    act(async () => {
      selectedRound = null;
      run = el("runs").value ? { id: el("runs").value } : null;
      await refresh();
    }),
  );
  el("form").addEventListener("input", updateEstimate);
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-quantity]",
  ))
    button.addEventListener("click", () => {
      el("form").elements.quantity.value = button.dataset.quantity!;
      updateEstimate();
    });
  el("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const round = run?.rounds!.find((r) => r.state === "open" && !r.receipt);
    if (!round) return;
    const fields = Object.fromEntries(
        new FormData(event.target as HTMLFormElement),
      ),
      quantity = Number(fields.quantity);
    pending = {
      roundId: round.id,
      key: crypto.randomUUID(),
      body: {
        accountId: userId,
        side: fields.side,
        ceiling: fields.ceiling,
        quantity,
        rule: run!.config!.rule,
      },
    };
    const reserve =
      (BigInt(quantity) * 1000000n * BigInt(10000 + run!.config!.feeBps)) /
      10000n;
    el("terms").textContent =
      `Account ${userId}. ${run!.debate!.proposition}.${run!.config!.argumentLabel ? ` Argument: ${run!.config!.argumentLabel}.` : ""} ${fields.side}; maximum purchase price ${fields.ceiling} Yap Coins; ${quantity} contracts. Maximum reservation and potential loss ${money(reserve)}, including maximum fee allowance. Actual price is drawn later and execution needs an accepting opposite side. Unused reservation is released. Cutoff ${new Date(round.closesAt).toLocaleString()}; lockup until reveal ${new Date(run!.revealAt!).toLocaleString()}. No edits or cancellation after commitment.`;
    el("review-status").textContent = "";
    el("review").showModal();
    el("commit").focus();
  });
  el("cancel").addEventListener("click", () => el("review").close());
  el("commit").addEventListener("click", async () => {
    if (!pending || busy) return;
    const epoch = accessEpoch,
      commitment = pending;
    busy = true;
    el("commit").disabled = true;
    try {
      const auth = await api<Auth>("auth/me");
      if (auth.user.id !== commitment.body.accountId) {
        clearPrivate();
        throw new Error("Account changed. Reload and review again.");
      }
      await api(
        `a4/rounds/${commitment.roundId}/submit`,
        commitment.body,
        commitment.key,
      );
      pending = null;
      el("review").close();
      await refresh();
    } catch (error) {
      if (epoch === accessEpoch)
        el("review-status").textContent =
          `${(error as Error).message}. Retry preserves your request key.`;
    } finally {
      busy = false;
      el("commit").disabled = false;
      if (accessRefreshPending) {
        accessRefreshPending = false;
        void act(refreshAccess);
      }
    }
  });
  function renderShared() {
    const controls = root.querySelector<HTMLElement>("[data-shared-controls]")!;
    controls.hidden = !shared?.items.length;
    const args = root.querySelector<HTMLElement>("[data-shared-arguments]")!;
    args.hidden = !usingShared || !shared?.arguments.length;
    if (!usingShared || !shared?.items.length) return;
    timeline = shared;
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
    if (!userId) {
      ui("round-label").textContent = `Round ${shared.items.at(-1)!.number}`;
      ui("round-state").textContent = "synthetic";
      ui("countdown").textContent = "Shared settled history";
    }
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
        shared = null;
        root.querySelector<HTMLElement>("[data-shared-controls]")!.hidden =
          true;
        root.querySelector<HTMLElement>("[data-shared-arguments]")!.hidden =
          true;
        if (usingShared) {
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
        if (!historyChoice && !shared?.items.length && next.items.length)
          usingShared = true;
        shared = next;
        renderShared();
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && usingShared)
        ui("sync").textContent =
          "Shared activity connection interrupted · showing last loaded results";
    } finally {
      sharedBusy = false;
    }
  }
  root
    .querySelector<HTMLSelectElement>("[data-shared-view]")!
    .addEventListener("change", (e) => {
      historyChoice = true;
      usingShared = (e.target as HTMLSelectElement).value === "shared";
      if (usingShared) {
        renderShared();
        if (userId) act(refresh);
      } else if (userId) act(refresh);
      else {
        chart.clear("Sign in to see your private history.");
        prices.clear();
      }
      root.querySelector<HTMLElement>("[data-shared-arguments]")!.hidden =
        !usingShared;
    });
  const countdownTimer = setInterval(countdown, 1000);
  function privateTick() {
    if (!userId || busy || document.hidden || el("review").open) return;
    const now = Date.now();
    if (
      (privateDueAt !== null && now >= privateDueAt) ||
      now - lastPrivate >= 30000 ||
      (privateFollowUp !== null && now >= privateFollowUp)
    )
      act(refresh);
  }
  const privateTimer = setInterval(privateTick, 1000);
  // Shared activity re-reads on room signals; the interval is a safety net,
  // slower while the room stream is live.
  // Keep the existing declaration and assignment order during the language migration.
  // eslint-disable-next-line prefer-const
  sharedTimer = setInterval(() => {
    const now = Date.now();
    if (
      (sharedDueAt !== null && now >= sharedDueAt) ||
      now - lastShared >= (roomLive ? 60000 : 15000)
    )
      void loadShared();
  }, 1000);
  const stopWatching = watchRoom({
    room: root.dataset.a4Inline!,
    topics: ["round", "activity"],
    events: window,
    signal(topic) {
      if (topic === "activity") sharedDueAt ??= spread();
      // Human-only rounds reach viewers through the signed-in workspace. A
      // private sandbox is never signalled, so its view keeps its own timing.
      else if (!run?.mode || run.mode === "human") privateDueAt ??= spread();
    },
    health(live) {
      roomLive = live;
    },
  });
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(countdownTimer);
      clearInterval(privateTimer);
      clearInterval(sharedTimer);
      stopWatching();
      sharedAbort.abort();
    },
    { once: true },
  );
  window.addEventListener("focus", () => {
    if (userId && !busy && !el("review").open) act(refresh);
  });
  const access = el("access");
  const startupControls = Array.from(
    access.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >("button, input, select"),
    (control) => ({ control, disabled: control.disabled }),
  );
  access.setAttribute("aria-busy", "true");
  for (const { control } of startupControls) control.disabled = true;
  async function refreshAccess() {
    const epoch = accessEpoch;
    const auth = await api<Auth>("auth/me");
    if (epoch !== accessEpoch) return;
    const draft = detachedArgument;
    detachedArgument = null;
    if (draft && (draft.owner === null || draft.owner === auth.user.id))
      el("argument").value = draft.value;
    if (userId === auth.user.id) {
      await refresh();
      return;
    }
    if (userId) clearPrivate();
    userId = auth.user.id;
    el("access").hidden = false;
    ui("signin").hidden = true;
    const publication = await api<Publication>("a4/publication").catch(() => ({
      published: false,
    }));
    if (epoch !== accessEpoch) return;
    el("publish").checked = publication.published;
    await list();
    if (epoch !== accessEpoch) return;
    await refresh();
  }
  window.addEventListener("yap:account-changed", () => {
    ++accessEpoch;
    detachedArgument ??= {
      owner: userId ?? null,
      value: el("argument").value,
    };
    clearPrivate();
    status("Checking your account. Review the action before confirming.");
    accessRefreshPending = true;
    if (!busy) {
      accessRefreshPending = false;
      void act(refreshAccess);
    }
  });
  act(refreshAccess).finally(() => {
    // act has released its busy guard, so visible controls can now accept input.
    for (const { control, disabled } of startupControls)
      control.disabled = disabled;
    access.setAttribute("aria-busy", "false");
  });
  renderShared();
}
