import type {
  Auth,
  Balance,
  Commitment,
  Fraction,
  FundingPolicy,
  Publication,
  Run,
  Runs,
  SelectedRun,
  Wallet,
} from "./arena-types.js";
import { html } from "../src/platform/html.ts";
import {
  createDeadlineFollower,
  roundDeadlines,
  roundStates,
} from "./community-stream.js";
interface A4Elements {
  review: HTMLDialogElement;
  submit: HTMLFormElement;
  create: HTMLFormElement & {
    elements: HTMLFormControlsCollection & { debateId: HTMLSelectElement };
  };
  runs: HTMLSelectElement;
  speed: HTMLSelectElement;
  publish: HTMLInputElement;
  "book-prev": HTMLButtonElement;
  "book-next": HTMLButtonElement;
  "history-more": HTMLButtonElement;
  commit: HTMLButtonElement;
}
interface History {
  items: {
    createdAt: string;
    kind: string;
    bucket: string;
    amount: string;
    scope: string;
  }[];
  hasMore: boolean;
}
interface Pending extends Commitment {
  accountId: string | undefined;
}
/* global document, Option, location, window */
// These selectors refer to the fixed A4 server-rendered markup.
const root = document.querySelector<HTMLElement>("[data-a4]")!;
if (root) {
  const el = <K extends string>(name: K) =>
    document.querySelector<
      K extends keyof A4Elements ? A4Elements[K] : HTMLElement
    >(`[data-a4-${name}]`)!;
  const notice = (message: string) => {
    el("notice").textContent = message;
  };
  const money = (value: string | number | bigint = "0") => {
    const n = BigInt(value),
      sign = n < 0n ? "−" : "",
      a = n < 0n ? -n : n;
    return `${sign}${a / 1000000n}.${String(a % 1000000n).padStart(6, "0")} Yap Coins`;
  };
  const ratio = (v: Fraction | null | undefined) =>
    v
      ? `${((100 * Number(v.n)) / Number(v.d)).toFixed(2)}%`
      : "Undefined · empty round";
  const price = (v: Fraction | null | undefined) =>
    v ? `${(Number(v.n) / Number(v.d)).toFixed(6)} Yap Coins` : "No offer";
  let accountId: string | undefined,
    run: SelectedRun | null | undefined,
    pending: Pending | null | undefined,
    busy = false,
    bookOffset = 0,
    historyOffset = 0,
    lastRefresh = 0;
  // The run view carries the database clock its round deadlines use. Besides
  // the viewer's own actions, a run refreshes shortly after each known deadline
  // and otherwise every 30 seconds.
  let serverOffset = 0,
    followUpAt: number | null = null;
  const followDeadline = createDeadlineFollower();
  let accessEpoch = 0;
  let accessRefreshPending = false;
  function clearAccess() {
    accountId = undefined;
    run = null;
    pending = null;
    bookOffset = 0;
    historyOffset = 0;
    el("runs").replaceChildren(new Option("Select a run", ""));
    el("submit").hidden = true;
    el("refill").hidden = true;
    el("content").hidden = true;
    el("login").hidden = false;
    el("controls").hidden = true;
    el("balance").textContent = "Balance unavailable";
    el("reserved").textContent = "";
    el("review-notice").textContent = "";
    for (const name of ["rounds", "history", "run-summary", "terms"])
      el(name).replaceChildren();
    el("review").close();
  }
  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const epoch = accessEpoch;
    const response = await fetch(`/api/${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const data: T & { error?: string } = await response.json();
    if (epoch !== accessEpoch)
      throw new Error(
        "Account changed. Review the current account before continuing.",
      );
    if (!response.ok) {
      if (response.status === 401) {
        clearAccess();
      }
      throw new Error(data.error ?? "Request failed");
    }
    return data;
  }
  async function write<T = unknown>(
    path: string,
    body: unknown,
    key: string = crypto.randomUUID(),
  ) {
    return api<T>(path, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  }
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    const epoch = accessEpoch;
    const buttons = [...root.querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await action();
    } catch (error) {
      if (epoch === accessEpoch) notice((error as Error).message);
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
      if (run?.rounds) {
        el("book-prev").disabled = bookOffset === 0;
        el("book-next").disabled = !run!.rounds!.some(
          (r) => r.diagnostics?.pagination.hasMore,
        );
      }
      if (accessRefreshPending) {
        accessRefreshPending = false;
        void perform(start);
      }
    }
  }
  function showFunding(policy: FundingPolicy | undefined) {
    if (policy)
      el("funding-policy").textContent =
        `${policy.starterCoins.toLocaleString()} starter coins per account and scope. Refill adds ${policy.refillCoins.toLocaleString()} once per UTC day. Multiple wallets share one account allowance.`;
  }
  function showBalances(balances: Balance[]) {
    el("balance").textContent = money(
      balances.find((b) => b.kind === "available")?.amount,
    );
    el("reserved").textContent =
      `Reserved: ${money(balances.find((b) => b.kind === "reserved")?.amount)}`;
  }
  // refresh replaces the selected id with a full run before rendering.
  function render() {
    showBalances(run!.balances!);
    showFunding(run!.fundingPolicy);
    el("run-summary").innerHTML =
      html`<h3>${run!.mode === "human" ? "Human-only" : run!.observer ? "BOT-ONLY OBSERVER" : "BOTS + YOU"} · ${run!.state!}</h3><p>${run!.debate!.proposition}</p><p><a href="/debates/${run!.debate!.slug}">Watch debate / chat →</a></p><p>YES endorses this proposition; NO rejects it. ${run!.config!.population} synthetic bots. Beliefs: ${run!.config!.preset === "reference" ? "homogeneous reference" : "heterogeneous stress fixture"}. ${run!.config!.feeBps ? "Experimental 5% premium fee" : "No fee"}. Epsilon ${run!.config!.epsilon / 1000000}.</p><p>Final reveal: ${new Date(run!.revealAt!).toLocaleString()}. Each period settles against its own share. Maximum lockup ends at this boundary once processing completes.</p>`.toString();
    el("controls").hidden =
      run!.mode === "human" || ["complete", "archived"].includes(run!.state!);
    // Decision 0010: only a Bots run's own balance can still be refilled;
    // the account-wide refill and human rounds are retired.
    el("refill").hidden = run!.mode === "human" || Boolean(run!.observer);
    el("speed").value = String(run!.speed);
    const open = run!.rounds!.find(
      (r) =>
        r.state === "open" &&
        new Date(r.closesAt).getTime() > Date.now() + serverOffset,
    );
    el("submit").hidden =
      !open || run!.observer || run!.state! !== "running" || !!open.receipt;
    el("rounds").innerHTML = html`${run!.rounds!.map((r) => {
      const o = r.receipt,
        d = r.diagnostics,
        t = d?.totals;
      const receipt = o
        ? html`<dl class="a4-receipt"><dt>Your commitment</dt><dd>${o.side} · limit ${o.limit} on YES scale · ${o.quantity} contracts</dd><dt>Status</dt><dd>${o.status.replaceAll("_", " ")}</dd><dt>Maximum reserved</dt><dd>${money(o.reserved)}</dd>${o.premium !== undefined ? html`<dt>Spent on premium</dt><dd>${money(o.premium)}</dd><dt>Fee</dt><dd>${money(o.fee)}</dd><dt>Released</dt><dd>${money(o.released)}</dd>` : ""}${o.payout !== undefined ? html`<dt>Payout</dt><dd>${money(o.payout)}</dd><dt>Net profit / loss</dt><dd>${money(o.net)}</dd>` : ""}</dl>`
        : html`<p>No human commitment in this round.</p>`;
      return html`<article class="a4-round"><h3>Round ${r.period} · ${r.state}</h3><p>Cutoff: ${new Date(r.closesAt).toLocaleString()}. Shared YES offer: ${price(r.offer)}.</p>${receipt}${d ? html`<details ${run!.observer ? "open" : ""}><summary>${run!.observer ? "Authorized bot-only diagnostics" : "Revealed results and orders"}</summary><p>YES endorsement share: <strong>${ratio(d.pricing?.share)}</strong>. ${t!.humans} human / ${t!.bots} synthetic bot submissions.</p><label>Endorsement share <meter min="0" max="1" value="${d.pricing?.share ? Number(d.pricing.share.n) / Number(d.pricing.share.d) : 0}">${ratio(d.pricing?.share)}</meter></label><p>Acceptance ${t!.participants ? ((100 * t!.accepted) / t!.participants).toFixed(1) : "0"}% · execution ${t!.participants ? ((100 * t!.executed) / t!.participants).toFixed(1) : "0"}% · ${t!.quantity} executed contracts. ${d.noTrade ? "No trades. Endorsements still count." : "All accepting quantities executed in full."}</p><p>Branch: ${d.pricing?.branch ?? "Not drawn"} · median NO floor ${price(d.pricing?.a)} · median YES ceiling ${price(d.pricing?.b)}. Random offer ${price(d.pricing?.price)}.</p><p>Participant premium ${money(t!.premium)} · payout ${money(t!.payout)} · fees ${money(t!.fee)}. Run center issuance ${money(d.centerFunding)}; center available ${money(d.centerAvailable)}. Round center trading result ${money(d.centerTrading)}; fees ${money(d.centerFees)}; total ${money(d.centerResult)}.</p><div class="a4-table" tabindex="0" role="region" aria-label="Round ${r.period} submitted order history"><table><caption>Submitted orders · ${bookOffset + 1} onward · limits on YES scale</caption><thead><tr><th>Participant</th><th>Side</th><th>Limit</th><th>Contracts</th><th>Outcome</th><th>Net Yap Coins</th></tr></thead><tbody>${d.book.map((b) => html`<tr><td>${b.label} · ${b.kind}</td><td>${b.side}</td><td>${b.limit}</td><td>${b.quantity}</td><td>${b.outcome?.status ?? r.state}</td><td>${b.outcome ? money(b.outcome.net) : "Pending"}</td></tr>`)}</tbody></table></div><p>Seed commitment: <code>${r.seedCommitment}</code>. Locked snapshot: <code>${d.snapshotHash ?? "Not locked"}</code>.</p></details>` : html`<p>Group medians, counts, orders and profit remain sealed.</p>`}</article>`;
    })}`.toString();
    el("book-prev").disabled = bookOffset === 0;
    el("book-next").disabled = !run!.rounds!.some(
      (r) => r.diagnostics?.pagination.hasMore,
    );
  }
  async function refresh() {
    const owner = accountId;
    const auth = await api<Auth>("auth/me");
    if (owner !== accountId) return;
    if (auth.user.id !== accountId) {
      run = null;
      pending = null;
      el("review").close();
      el("rounds").replaceChildren();
      throw new Error("Account changed. Reload to review the current account.");
    }
    if (run) {
      followUpAt = null;
      const next = await api<Run & { serverNow?: string }>(
        `a4/runs/${run!.id}?offset=${bookOffset}`,
      );
      if (owner !== accountId) return;
      if (next.serverNow)
        serverOffset = new Date(next.serverNow).getTime() - Date.now();
      // The clock differs on every read; only run content triggers a render.
      const changed =
        JSON.stringify({ ...next, serverNow: undefined }) !==
        JSON.stringify({ ...run, serverNow: undefined });
      run = next;
      if (changed) render();
      const follow = followDeadline(
        roundDeadlines(run),
        roundStates(run),
        Date.now() + serverOffset,
      );
      followUpAt = follow === null ? null : Date.now() + follow;
    } else {
      const wallet = await api<Wallet>("a4/wallet");
      if (owner !== accountId) return;
      showBalances(wallet.balances);
      showFunding(wallet.fundingPolicy);
    }
    lastRefresh = Date.now();
  }
  async function listRuns(selected?: string) {
    const owner = accountId;
    const list = await api<Runs>("a4/runs");
    if (owner !== accountId) return;
    el("runs").replaceChildren(
      new Option("Select a run", ""),
      ...list.items.map(
        (r) => new Option(`${r.mode} · ${r.state} · ${r.id.slice(0, 8)}`, r.id),
      ),
    );
    if (selected) el("runs").value = selected;
  }
  async function history() {
    const owner = accountId;
    const data = await api<History>(`a4/history?offset=${historyOffset}`);
    if (owner !== accountId) return;
    el("history").innerHTML =
      html`<ul>${data.items.map((i) => html`<li>${new Date(i.createdAt).toLocaleString()} · ${i.kind} · ${i.bucket} ${money(i.amount)} · ${i.scope === "global" ? "ordinary balance" : "bot sandbox"}</li>`)}</ul>`.toString();
    el("history-more").disabled = !data.hasMore;
  }
  el("create").addEventListener("submit", (event) => {
    event.preventDefault();
    perform(async () => {
      const fields = Object.fromEntries(
        new FormData(event.target as HTMLFormElement),
      );
      const mode = fields.mode,
        periods = Number(fields.periods);
      const config = {
        epsilon: Number(fields.epsilon),
        feeBps: Number(fields.feeBps),
        population: mode === "human" ? 0 : Number(fields.population),
        preset: fields.preset,
        quantity: Number(fields.quantity),
        periods,
        delayed: periods > 1,
        roundSeconds: Number(fields.roundSeconds),
      };
      const body: {
        debateId: FormDataEntryValue | undefined;
        mode: FormDataEntryValue | undefined;
        config: typeof config;
        speed: number;
        seed?: FormDataEntryValue;
      } = {
        debateId: fields.debateId,
        mode,
        config,
        speed: mode === "human" ? 1 : Number(fields.speed),
      };
      if (fields.seed) {
        if (mode !== "observer")
          throw new Error(
            "Replay seeds are available only for bot-only observer runs.",
          );
        body.seed = fields.seed;
      }
      const result = await write<{ id: string }>("a4/runs", body);
      run = { id: result.id };
      bookOffset = 0;
      await listRuns(result.id);
      await refresh();
      await history();
      notice(
        "Run created. Bot activity is synthetic; its funding and history are separate.",
      );
    });
  });
  el("runs").addEventListener("change", () =>
    perform(async () => {
      run = el("runs").value ? { id: el("runs").value } : null;
      bookOffset = 0;
      await refresh();
    }),
  );
  el("list").addEventListener("click", () => perform(() => listRuns(run?.id)));
  el("submit").addEventListener("submit", (event) => {
    event.preventDefault();
    // This form is shown only after a full running run has been rendered.
    const round = run!.rounds!.find((r) => r.state === "open" && !r.receipt);
    if (!round)
      return notice("No open round. Refresh to recover current state.");
    const fields = Object.fromEntries(
      new FormData(event.target as HTMLFormElement),
    );
    const quantity = Number(fields.quantity),
      reserve =
        (BigInt(quantity) * 1000000n * (10000n + BigInt(run!.config!.feeBps))) /
        10000n;
    pending = {
      roundId: round.id,
      key: crypto.randomUUID(),
      body: {
        side: fields.side,
        ceiling: fields.ceiling,
        quantity,
        rule: run!.config!.rule,
        accountId,
      },
      accountId,
    };
    el("terms").innerHTML =
      html`<p>Account ${String(accountId)} · ${run!.debate!.proposition}</p><p>${String(fields.side)} · maximum purchase price ${String(fields.ceiling)} Yap Coins · ${quantity} contracts.</p><p>Maximum reservation and potential loss: <strong>${money(reserve)}</strong>, including up to ${money(reserve - BigInt(quantity) * 1000000n)} fee. Actual premium is determined by the later shared offer; unused reservation is released. Execution requires an accepting opposite side.</p><p>Cutoff ${new Date(round.closesAt).toLocaleString()}; reveal ${new Date(run!.revealAt!).toLocaleString()}. Binding once committed; no edits or cancellation.</p>`.toString();
    el("review-notice").textContent = "";
    el("review").showModal();
    el("commit").focus();
  });
  el("cancel").addEventListener("click", () => el("review").close());
  el("commit").addEventListener("click", async () => {
    if (!pending || busy) return;
    const epoch = accessEpoch,
      commitment = pending;
    el("commit").disabled = true;
    try {
      const auth = await api<Auth>("auth/me");
      if (auth.user.id !== commitment.accountId)
        throw new Error("Account changed; review again.");
      await write(
        `a4/rounds/${commitment.roundId}/submit`,
        commitment.body,
        commitment.key,
      );
      pending = null;
      el("review").close();
      await refresh();
      await history();
      notice("Binding commitment recorded. Reloading restores your receipt.");
    } catch (error) {
      if (epoch === accessEpoch)
        el("review-notice").textContent =
          `${(error as Error).message}. Retry preserves the same request key.`;
    } finally {
      if (epoch === accessEpoch) el("commit").disabled = false;
    }
  });
  el("refill").addEventListener("click", () =>
    perform(async () => {
      if (!run) return;
      const result = await write<{ issued: boolean; amount: string }>(
        "a4/refill",
        { runId: run.id },
      );
      await refresh();
      await history();
      notice(
        result.issued
          ? `Issued ${money(result.amount)} in this balance scope.`
          : "Today's refill was already issued in this scope.",
      );
    }),
  );
  root
    .querySelectorAll<HTMLButtonElement>("[data-a4-control]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        perform(async () => {
          if (!run) return;
          const action = button.dataset.a4Control;
          await write(`a4/runs/${run!.id}/control`, { action });
          await refresh();
          await listRuns(run!.id);
          notice(
            action === "archive"
              ? "Sandbox archived. Locked obligations remain recoverable; start a new run with fresh isolated balances."
              : `Control recorded: ${action}.`,
          );
        }),
      ),
    );
  el("speed").addEventListener("change", () =>
    perform(async () => {
      await write(`a4/runs/${run!.id}/control`, {
        action: "speed",
        speed: Number(el("speed").value),
      });
      await refresh();
    }),
  );
  el("refresh").addEventListener("click", () => perform(refresh));
  el("book-next").addEventListener("click", () =>
    perform(async () => {
      bookOffset += 50;
      await refresh();
    }),
  );
  el("book-prev").addEventListener("click", () =>
    perform(async () => {
      bookOffset = Math.max(0, bookOffset - 50);
      await refresh();
    }),
  );
  el("history-more").addEventListener("click", () =>
    perform(async () => {
      historyOffset += 50;
      await history();
    }),
  );
  el("publish").addEventListener("change", () =>
    perform(async () => {
      const epoch = accessEpoch;
      try {
        const result = await write<Publication>("a4/publication", {
          published: el("publish").checked,
        });
        el("publish").checked = result.published;
      } catch (error) {
        if (epoch === accessEpoch)
          el("publish").checked = !el("publish").checked;
        throw error;
      }
    }),
  );
  async function start() {
    const epoch = accessEpoch;
    try {
      const auth = await api<Auth>("auth/me");
      if (epoch !== accessEpoch) return;
      if (accountId === auth.user.id) {
        el("content").hidden = false;
        el("login").hidden = true;
        await refresh();
        return;
      }
      accountId = auth.user.id;
      run = null;
      pending = null;
      el("review").close();
      el("rounds").replaceChildren();
      el("history").replaceChildren();
      const publication = await api<Publication>("a4/publication").catch(
        () => ({
          published: false,
        }),
      );
      if (epoch !== accessEpoch) return;
      el("publish").checked = publication.published;
      const debates = await api<{
          items: { proposition: string; id: string }[];
        }>("public/debates?limit=50"),
        items = debates.items;
      if (epoch !== accessEpoch) return;
      const selected =
        new URLSearchParams(location.search).get("debate") ||
        el("create").elements.debateId.value;
      el("create").elements.debateId.replaceChildren(
        ...items.map((d) => new Option(d.proposition, d.id)),
      );
      if (selected && items.some((d) => d.id === selected))
        el("create").elements.debateId.value = selected;
      el("content").hidden = false;
      el("login").hidden = true;
      await listRuns();
      if (epoch !== accessEpoch) return;
      await refresh();
      if (epoch !== accessEpoch) return;
      await history();
      if (epoch !== accessEpoch) return;
      notice(
        "Choose a debate and a clearly labeled mode. Watching remains available without a commitment.",
      );
    } catch (error) {
      if (epoch !== accessEpoch) return;
      notice((error as Error).message);
      el("login").hidden = false;
    }
  }
  setInterval(() => {
    if (
      run &&
      !["complete", "archived"].includes(run!.state!) &&
      !busy &&
      !document.hidden &&
      !el("review").open &&
      (Date.now() - lastRefresh > 30000 ||
        (followUpAt !== null && Date.now() >= followUpAt))
    )
      perform(refresh);
  }, 1000);
  window.addEventListener("online", () => perform(refresh));
  window.addEventListener("yap:account-changed", () => {
    ++accessEpoch;
    clearAccess();
    notice("Checking your account. Review the action before confirming.");
    accessRefreshPending = true;
    if (!busy) {
      accessRefreshPending = false;
      void perform(start);
    }
  });
  start();
}
