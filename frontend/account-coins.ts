import { api as request, apiFetch } from "./lib/api.js";

interface CoinRequest {
  id: string;
  kind: string;
  status: string;
  terms: Record<string, string>;
  expiresAt: string | null;
}
interface CoinSummary {
  sessionId: string;
  simulation: boolean;
  rail: string;
  opened: boolean;
  initialized: boolean;
  financialReviewRequired: boolean;
  projection: {
    grantPrincipal: string;
    grantProfit: string;
    purchasedPrincipal: string;
    purchasedProfit: string;
    withdrawable: string;
    grants: {
      id: string;
      kind: string;
      qualified: boolean;
      remainingTarget: string;
      netProfit: string;
      withdrawableProfit: string;
    }[];
  };
  balances: {
    cashAvailable: string;
    reserved: string;
    pending: string;
    promotionalPrincipal: string;
  };
  requests: CoinRequest[];
}
// A debate round: a speaking turn's window during a live debate, otherwise a
// manual round. Its eligibility says whether this account can still answer.
interface CoinRound {
  id: string;
  proposition: string;
  state: string;
  closesAt: string;
  kind: "turn" | "manual";
  turnNumber: number | null;
  revealAt: string | null;
  participants: number;
  eligibility: { canTakePosition: boolean; reason: string | null };
  own: { side: string; quantity: number; requestId: string } | null;
  outcome?: {
    premium: string;
    fee: string;
    payout: string;
    net: string;
    executed: boolean;
  };
}
interface CoinErrorReport {
  id: string;
  requestId: string;
  description: string;
  events: {
    id: string;
    kind: "review" | "recovery_consent" | "compensated";
    outcome?: string;
    publicNote?: string;
    quoteId?: string;
    quote?: {
      amount: string;
      network: string;
      expiresAt: string;
      description: string;
    };
    amount?: string;
  }[];
}
// Decision 0009, point 8: a sensitive operation is confirmed by signing in
// again. The page records what it was doing, follows the confirmation link
// through the provider and finishes the action when it returns.
interface Confirmation {
  id: string;
  expiresAt: string;
  confirmPath: string;
}
type PendingConfirmation = { operationId: string; expiresAt: number } & (
  | { kind: "withdrawal"; requestId: string }
  | { kind: "recovery"; reportId: string; quoteId: string }
);
const confirmationKey = "yaparena-coin-confirmation";
const identifier =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function takeConfirmation(): PendingConfirmation | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(confirmationKey);
    sessionStorage.removeItem(confirmationKey);
  } catch {
    return null;
  }
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const entry = value as Record<string, unknown>;
    const ids = [
      entry.operationId,
      entry.requestId,
      entry.reportId,
      entry.quoteId,
    ];
    if (
      typeof entry.operationId !== "string" ||
      typeof entry.expiresAt !== "number" ||
      ids.some(
        (id) =>
          id !== undefined && (typeof id !== "string" || !identifier.test(id)),
      )
    )
      return null;
    const base = { operationId: entry.operationId, expiresAt: entry.expiresAt };
    if (entry.kind === "withdrawal" && typeof entry.requestId === "string")
      return { ...base, kind: "withdrawal", requestId: entry.requestId };
    if (
      entry.kind === "recovery" &&
      typeof entry.reportId === "string" &&
      typeof entry.quoteId === "string"
    )
      return {
        ...base,
        kind: "recovery",
        reportId: entry.reportId,
        quoteId: entry.quoteId,
      };
    return null;
  } catch {
    return null;
  }
}
function confirmBySignIn(
  confirmation: Confirmation,
  pending:
    | { kind: "withdrawal"; requestId: string }
    | { kind: "recovery"; reportId: string; quoteId: string },
) {
  const value: PendingConfirmation = {
    ...pending,
    operationId: confirmation.id,
    expiresAt: Date.parse(confirmation.expiresAt),
  };
  try {
    sessionStorage.setItem(confirmationKey, JSON.stringify(value));
  } catch {
    throw new Error(
      "This browser cannot keep the action while you confirm. Allow site storage and try again.",
    );
  }
  const target = new URL(confirmation.confirmPath, location.origin);
  target.searchParams.set("return", "/coins#coin-sandbox");
  location.assign(target.pathname + target.search);
}
const container = document.querySelector<HTMLElement>("#account-wallet");
const usdc = (value: string) => {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? "−" : ""}${a / 1_000_000n}.${
    String(a % 1_000_000n)
      .padStart(6, "0")
      .replace(/0+$/, "") || "0"
  } USDC`;
};
const yc = (value: string) => {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  const fraction = String(a % 10_000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${n < 0n ? "−" : ""}${a / 10_000n}${fraction ? `.${fraction}` : ""} YC`;
};
function amount(value: string) {
  if (!/^(0|[1-9][0-9]{0,20})(\.\d{1,6})?$/.test(value))
    throw new Error("Enter an amount with at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (n <= 0n) throw new Error("Enter a positive amount.");
  return String(n);
}
if (container) {
  const root = document.createElement("section");
  root.id = "coin-sandbox";
  root.hidden = true;
  root.innerHTML = `<h3>Coin sandbox</h3><p class="form-note">Simulated funds. No cash value. These balances are separate from historical play coins and live funds.</p>
    <p data-coin-notice role="status" aria-live="polite" aria-atomic="true"></p><dl class="account-balances" data-coin-balances></dl>
    <button type="button" class="button-secondary" data-coin-refresh>Refresh sandbox</button>
    <button type="button" class="button-secondary" data-coin-daily>Claim daily 500 YC</button><ul class="account-list" data-coin-grants></ul>
    <details class="account-details"><summary>Simulate a purchase</summary><form class="stack-form" data-coin-funding><label>Test USDC amount<input name="amount" inputmode="decimal" value="10" required autocomplete="off"></label><p>Fixed simulation: 1 test USDC buys 100 YC. No crypto is sent and no provider conversion is performed.</p><button class="button" type="submit">Get simulated quote</button></form></details>
    <details class="account-details"><summary>Request a simulated withdrawal</summary><form class="stack-form" data-coin-withdraw><label>Total to deduct (USDC)<input name="gross" inputmode="decimal" value="5" required autocomplete="off"></label><label>External wallet destination<input name="destination" maxlength="200" required autocomplete="off" spellcheck="false"></label><p>Minimum deduction: 5 USDC. The displayed fee comes out of that amount. No daily cap. Purchased funds need no profit target; only grant profits have qualification rules.</p><p>Manual review target: two business days (Toronto weekdays, excluding Canadian federal holidays). Network confirmation time is additional. Pending funds stay reserved.</p><button class="button" type="submit">Review amount and network fee</button></form></details>
    <details class="account-details"><summary>Join a YES/NO debate with sandbox coins</summary><label>Existing debate<select data-coin-debate></select></label><button type="button" class="button-secondary" data-coin-open>Open or join the current round</button><div data-coin-rounds></div><form class="stack-form" data-coin-participate hidden><label>Position<select name="side"><option value="YES">YES</option><option value="NO">NO</option></select></label><label>Maximum purchase price per YC (0–1)<input name="ceiling" inputmode="decimal" value="0.5" required></label><label>Quantity (1–100)<input name="quantity" type="number" min="1" max="100" value="1" required></label><p>The first commitment is final. Oldest grants are used first. A4 uses the existing YES/NO mechanism; participation is not a bet on an externally judged winner.</p><button class="button" type="submit">Review and commit participation</button></form></details>
    <h4>Sandbox receipts</h4><ul class="account-list" data-coin-receipts></ul>
    <details class="account-details"><summary>Report a deposit or payout error</summary><p>Reports have no submission deadline. Include the receipt ID and explain what went wrong. Do not include passwords, verification codes or private keys. Ordinary trading losses are final.</p><form class="stack-form" data-coin-report><label>Receipt ID<input name="requestId" required maxlength="36" autocomplete="off" spellcheck="false"></label><label>What happened?<textarea name="description" required maxlength="2000" rows="4"></textarea></label><button class="button-secondary" type="submit">Submit error report</button></form><p data-coin-report-notice role="status" aria-live="polite" aria-atomic="true"></p><ul class="account-list" data-coin-reports></ul></details>`;
  container.append(root);
  const select = <T extends Element>(selector: string) =>
    root.querySelector<T>(selector)!;
  const notice = select<HTMLElement>("[data-coin-notice]"),
    balanceList = select<HTMLElement>("[data-coin-balances]"),
    grants = select<HTMLElement>("[data-coin-grants]"),
    receipts = select<HTMLElement>("[data-coin-receipts]"),
    reportList = select<HTMLElement>("[data-coin-reports]"),
    reportNotice = select<HTMLElement>("[data-coin-report-notice]"),
    reportForm = select<HTMLFormElement>("[data-coin-report]");
  const funding = select<HTMLFormElement>("[data-coin-funding]"),
    withdraw = select<HTMLFormElement>("[data-coin-withdraw]"),
    participation = select<HTMLFormElement>("[data-coin-participate]"),
    debate = select<HTMLSelectElement>("[data-coin-debate]");
  reportNotice.tabIndex = -1;
  let version = 0,
    busy = false,
    roundId: string | null = null,
    sessionId: string | null = null;
  const keys = new Map<string, string>();
  const key = (scope: string) => {
    let k = keys.get(scope);
    if (!k) {
      k = crypto.randomUUID();
      keys.set(scope, k);
    }
    return k;
  };
  async function api<T>(
    path: string,
    method = "GET",
    data?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return request<T>(`/api/coin-sandbox${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(method !== "GET" && sessionId
          ? { "X-YapArena-Session": sessionId }
          : {}),
      },
      json: data,
      timeout: 30_000,
      errorMessage: (status) =>
        status === 404
          ? "Sandbox is disabled."
          : "Could not confirm the result. Refresh receipts before retrying.",
    });
  }
  function setBusy(value: boolean) {
    busy = value;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = value;
  }
  async function action(work: (generation: number) => Promise<void>) {
    if (busy) return;
    const generation = version;
    const initiatingControl =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBusy(true);
    notice.textContent = "Working…";
    try {
      await work(generation);
    } catch (error) {
      if (generation === version)
        notice.textContent =
          error instanceof Error
            ? error.message
            : "Could not confirm the result. Refresh receipts before retrying.";
    } finally {
      if (generation === version) {
        setBusy(false);
        if (
          initiatingControl?.isConnected &&
          document.activeElement !== reportNotice &&
          !root.hidden &&
          initiatingControl.getClientRects().length &&
          !document.querySelector("dialog[open]")
        )
          initiatingControl.focus();
      }
    }
  }
  async function load(generation = version) {
    let summary = await api<CoinSummary>("/summary");
    if (generation !== version) return;
    sessionId = summary.sessionId;
    // This browser journey intentionally supports the deterministic staging rail
    // only. Real testnet signing/reconciliation runs in its isolated operator DB.
    if (!summary.simulation || summary.rail !== "simulation") {
      root.hidden = true;
      return;
    }
    // Decision 0013: Yap Coins are always on. The first visit claims the
    // welcome grant itself; there is no unlock or claim step. A failed claim
    // still shows the sandbox, and Refresh sandbox tries again.
    let welcomeFailed = false;
    if (!summary.initialized && !summary.financialReviewRequired) {
      try {
        await api("/initialize", "POST", {});
        window.dispatchEvent(new Event("yap:coins-changed"));
        if (generation !== version) return;
        summary = await api<CoinSummary>("/summary");
      } catch {
        welcomeFailed = true;
      }
      if (generation !== version) return;
      sessionId = summary.sessionId;
    }
    root.hidden = false;
    balanceList.replaceChildren();
    grants.replaceChildren();
    receipts.replaceChildren();
    for (const [label, value] of [
      ["Purchased principal", summary.projection.purchasedPrincipal],
      ["Purchased profit", summary.projection.purchasedProfit],
      ["Grant principal (spend-only)", summary.projection.grantPrincipal],
      ["Grant profit", summary.projection.grantProfit],
      ["Withdrawal-eligible", summary.projection.withdrawable],
      ["Reserved cash", summary.balances.reserved],
      ["Pending cash", summary.balances.pending],
    ]) {
      const item = document.createElement("div"),
        term = document.createElement("dt"),
        valueElement = document.createElement("dd");
      term.textContent = label!;
      valueElement.textContent = yc(value!);
      item.append(term, valueElement);
      balanceList.append(item);
    }
    for (const grant of summary.projection.grants) {
      const item = document.createElement("li");
      item.textContent = `${grant.kind === "welcome" ? "Welcome" : "Daily"} grant: ${grant.qualified ? "permanently qualified" : `${yc(grant.remainingTarget)} new net profit needed`}; ${yc(grant.withdrawableProfit)} eligible profit. Principal stays spend-only.`;
      grants.append(item);
    }
    for (const request of summary.requests) {
      const item = document.createElement("li");
      item.textContent = `${request.kind} · ${request.status} · ${request.terms.gross ? `deduct ${usdc(request.terms.gross)}, fee ${usdc(request.terms.fee!)}, receive ${usdc(request.terms.net!)}` : request.terms.amount ? usdc(request.terms.amount) : `${request.terms.side ?? ""} ${request.terms.quantity ?? ""} YC`} · ${request.id}`;
      if (["funding", "withdrawal"].includes(request.kind)) {
        const report = document.createElement("button");
        report.type = "button";
        report.className = "button-secondary";
        report.textContent = "Report a problem";
        report.disabled = busy;
        report.onclick = () => {
          const input = reportForm.elements.namedItem("requestId");
          if (!(input instanceof HTMLInputElement)) return;
          input.value = request.id;
          reportForm.closest("details")!.open = true;
          reportForm.querySelector("textarea")!.focus();
        };
        item.append(report);
      }
      receipts.append(item);
    }
    notice.textContent = summary.financialReviewRequired
      ? "Financial activity is paused for correction review. Ordinary account access remains available."
      : welcomeFailed
        ? "Your welcome grant couldn't be added yet. Use Refresh sandbox to try again."
        : "Sandbox balances refreshed. Simulated withdrawals require manual operator review.";
    await loadReports(generation);
  }
  async function loadReports(generation = version) {
    try {
      const reports = await api<CoinErrorReport[]>("/reports");
      if (generation !== version) return;
      reportList.replaceChildren();
      for (const report of reports) {
        const item = document.createElement("li"),
          description = document.createElement("p");
        description.textContent = `${report.requestId}: ${report.description}`;
        item.append(description);
        const latest = report.events.at(-1);
        for (const event of report.events) {
          const detail = document.createElement("p");
          detail.textContent =
            event.kind === "recovery_consent"
              ? "Recovery cost consent recorded. No charge or recovery started."
              : event.kind === "compensated"
                ? `${usdc(event.amount!)} restored to its original balance sources.`
                : event.publicNote || "Operator review recorded.";
          item.append(detail);
          if (
            event.id === latest?.id &&
            event.quote &&
            event.quoteId &&
            new Date(event.quote.expiresAt).getTime() > Date.now()
          ) {
            const quoteId = event.quoteId,
              cost = document.createElement("p"),
              consent = document.createElement("button");
            cost.textContent = `${event.quote.description}: ${usdc(event.quote.amount)} on ${event.quote.network}. Expires ${new Date(event.quote.expiresAt).toLocaleString()}. Consent records your agreement only; no charge or recovery starts.`;
            consent.type = "button";
            consent.className = "button-secondary";
            consent.textContent = "Review recovery cost";
            consent.disabled = busy;
            consent.onclick = () =>
              void action(async (g) => {
                if (!sessionId)
                  throw new Error("Refresh the account before confirming.");
                const current = await api<{ terms: Record<string, string> }>(
                  `/reports/${report.id}/recovery-quotes/${quoteId}`,
                );
                if (g !== version) return;
                if (
                  !window.confirm(
                    `${current.terms.description ?? "Recovery cost"}: ${usdc(event.quote!.amount)} on ${event.quote!.network}. Consent records your agreement only. Continue to confirm by signing in again?`,
                  )
                ) {
                  notice.textContent = "Consent cancelled. Nothing recorded.";
                  return;
                }
                const confirmation = await api<Confirmation>(
                  `/reports/${report.id}/recovery-consents/authorization`,
                  "POST",
                  { quoteId },
                );
                if (g !== version) return;
                confirmBySignIn(confirmation, {
                  kind: "recovery",
                  reportId: report.id,
                  quoteId,
                });
              });
            item.append(cost, consent);
          }
        }
        reportList.append(item);
      }
      reportNotice.textContent = reports.length
        ? "Showing the latest 50 reports. Every submitted report is retained."
        : "No deposit or payout errors reported.";
    } catch {
      if (generation === version)
        reportNotice.textContent =
          "Error reports could not be loaded. Refresh the sandbox to try again.";
    }
  }
  reportForm.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      const data = new FormData(reportForm),
        requestId = String(data.get("requestId")).trim(),
        description = String(data.get("description")).trim(),
        scope = JSON.stringify(["report", requestId, description]);
      await api("/reports", "POST", { requestId, description }, key(scope));
      if (g !== version) return;
      keys.delete(scope);
      reportForm.reset();
      await loadReports(g);
      if (g !== version) return;
      reportNotice.textContent =
        "Error report recorded for evidence review. No funds were changed.";
      reportNotice.focus();
      notice.textContent =
        "Error report recorded for evidence review. No funds were changed.";
    });
  };
  async function loadRounds(generation = version) {
    if (!debate.value) return;
    const rows = await api<CoinRound[]>(
      `/debates/${encodeURIComponent(debate.value)}/rounds`,
    );
    if (generation !== version) return;
    roundId = rows.find((r) => r.eligibility.canTakePosition)?.id ?? null;
    participation.hidden = !roundId;
    const list = select<HTMLElement>("[data-coin-rounds]");
    list.replaceChildren();
    for (const round of rows) {
      const p = document.createElement("p");
      p.textContent = `${round.kind === "turn" ? `Turn ${round.turnNumber}` : round.proposition}: ${round.eligibility.canTakePosition ? "taking answers" : round.state === "open" ? "locked" : round.state}, cutoff ${new Date(round.closesAt).toLocaleString()}, ${round.participants} answered.${round.own ? ` Your ${round.own.side} ${round.own.quantity} YC commitment is final.` : ""}${round.outcome ? ` Paid ${yc(String(BigInt(round.outcome.premium) + BigInt(round.outcome.fee)))}, received ${yc(round.outcome.payout)}, net ${yc(round.outcome.net)}.` : ""}`;
      list.append(p);
    }
  }
  select<HTMLButtonElement>("[data-coin-refresh]").onclick = () =>
    void action(async (g) => {
      let settlementError: unknown;
      try {
        await api("/settlements", "POST", {});
      } catch (error) {
        settlementError = error;
      }
      if (g !== version) return;
      await load(g);
      await loadRounds(g);
      if (g === version && settlementError) throw settlementError;
    });
  // Finishes the action a confirmation was started for, once, when the
  // provider returns here with ?confirmed=<operation>.
  async function finishConfirmation(generation: number) {
    const parameters = new URLSearchParams(location.search);
    const confirmed = parameters.get("confirmed");
    if (!confirmed) return;
    parameters.delete("confirmed");
    const query = parameters.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
    const pending = takeConfirmation();
    if (!pending || pending.operationId !== confirmed) return;
    if (pending.expiresAt <= Date.now()) {
      notice.textContent = "That confirmation expired. Start the action again.";
      return;
    }
    const approval = { id: pending.operationId };
    if (pending.kind === "withdrawal") {
      await api(`/withdrawals/${pending.requestId}`, "POST", { approval });
      if (generation !== version) return;
      await load(generation);
      notice.textContent =
        "Withdrawal request confirmed. It now waits for manual review.";
    } else {
      await api(
        `/reports/${pending.reportId}/recovery-consents`,
        "POST",
        { quoteId: pending.quoteId, approval },
        key(`recovery-consent:${pending.reportId}:${pending.quoteId}`),
      );
      if (generation !== version) return;
      await loadReports(generation);
      notice.textContent =
        "Recovery cost consent recorded. No charge or recovery started.";
    }
    root.scrollIntoView({ block: "start" });
  }
  select<HTMLButtonElement>("[data-coin-daily]").onclick = () =>
    void action(async (g) => {
      await api("/grants/daily", "POST", {});
      window.dispatchEvent(new Event("yap:coins-changed"));
      await load(g);
    });
  funding.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      const input = amount(String(new FormData(funding).get("amount"))),
        scope = `funding:${input}`;
      const quote = await api<CoinRequest>(
        "/funding/quotes",
        "POST",
        { amount: input },
        key(scope),
      );
      if (g !== version) return;
      if (
        !window.confirm(
          `SIMULATION ONLY: ${usdc(input)} → ${yc(input)}. No conversion fee. Quote expires ${new Date(quote.expiresAt!).toLocaleTimeString()}. Confirm simulated funding?`,
        )
      ) {
        notice.textContent = "Quote cancelled. No coins issued.";
        return;
      }
      await api(`/funding/${quote.id}/confirm`, "POST", {});
      window.dispatchEvent(new Event("yap:coins-changed"));
      if (g !== version) return;
      keys.delete(scope);
      await load(g);
    });
  };
  withdraw.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      const data = new FormData(withdraw),
        gross = amount(String(data.get("gross"))),
        destination = String(data.get("destination")).trim();
      if (BigInt(gross) < 5_000_000n)
        throw new Error("The total deduction must be at least 5 USDC.");
      const scope = `withdrawal:${gross}:${destination}`,
        quote = await api<CoinRequest>(
          "/withdrawals/quotes",
          "POST",
          { gross, destination },
          key(scope),
        );
      if (g !== version) return;
      if (
        !window.confirm(
          `SIMULATION ONLY\nDeduct: ${usdc(quote.terms.gross!)}\nNetwork fee included: ${usdc(quote.terms.fee!)}\nWallet receives: ${usdc(quote.terms.net!)}\nDestination: ${quote.terms.destination}\nManual review; no real payment. Continue to confirm by signing in again?`,
        )
      ) {
        notice.textContent = "Withdrawal cancelled. Nothing reserved.";
        return;
      }
      if (!sessionId) throw new Error("Refresh the account before confirming.");
      const confirmation = await api<Confirmation>(
        `/withdrawals/${quote.id}/operations`,
        "POST",
        {},
      );
      if (g !== version) return;
      keys.delete(scope);
      confirmBySignIn(confirmation, {
        kind: "withdrawal",
        requestId: quote.id,
      });
    });
  };
  select<HTMLButtonElement>("[data-coin-open]").onclick = () =>
    void action(async (g) => {
      if (!debate.value) throw new Error("Choose a published debate.");
      const scope = `round:${debate.value}`;
      await api(`/debates/${debate.value}/rounds`, "POST", {}, key(scope));
      if (g !== version) return;
      keys.delete(scope);
      await loadRounds(g);
      notice.textContent = "Round ready. Review a position before committing.";
    });
  debate.onchange = () =>
    void action(async (g) => {
      await loadRounds(g);
      notice.textContent = "Debate rounds refreshed.";
    });
  participation.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      if (!roundId) throw new Error("Choose an open round.");
      const selected = roundId,
        data = new FormData(participation),
        side = String(data.get("side")),
        ceiling = String(data.get("ceiling")),
        quantity = Number(data.get("quantity"));
      if (
        !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(ceiling) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      )
        throw new Error(
          "Use a price from 0 to 1 and an integer quantity from 1 to 100.",
        );
      if (
        !window.confirm(
          `SIMULATION: commit ${side}, ${quantity} YC at a maximum ${ceiling} per YC? Up to ${quantity} YC will be reserved, oldest grant first. The first commitment cannot be edited or cancelled.`,
        )
      ) {
        notice.textContent = "Participation cancelled. Nothing reserved.";
        return;
      }
      await api(
        `/rounds/${selected}/submit`,
        "POST",
        { side, ceiling, quantity },
        key(`stake:${selected}:${side}:${ceiling}:${quantity}`),
      );
      window.dispatchEvent(new Event("yap:coins-changed"));
      if (g !== version) return;
      await load(g);
      await loadRounds(g);
      notice.textContent =
        "Commitment recorded. It settles when this round's results are revealed.";
    });
  };
  async function start() {
    const generation = ++version;
    setBusy(false);
    sessionId = null;
    root.hidden = true;
    receipts.replaceChildren();
    grants.replaceChildren();
    balanceList.replaceChildren();
    select<HTMLElement>("[data-coin-rounds]").replaceChildren();
    funding.reset();
    withdraw.reset();
    participation.reset();
    participation.hidden = true;
    notice.textContent = "";
    reportList.replaceChildren();
    reportForm.reset();
    reportNotice.textContent = "";
    keys.clear();
    roundId = null;
    debate.replaceChildren();
    try {
      await load(generation);
      if (generation !== version || root.hidden) return;
      await finishConfirmation(generation).catch((error: unknown) => {
        if (generation === version)
          notice.textContent =
            error instanceof Error
              ? error.message
              : "The confirmed action could not finish. Refresh and try again.";
      });
      if (generation !== version) return;
      const response = await apiFetch("/api/public/debates?limit=100", {
        cache: "no-store",
        timeout: 10_000,
      });
      if (!response.ok) return;
      const data: { items: { id: string; proposition: string }[] } =
        await response.json();
      if (generation !== version) return;
      for (const item of data.items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.proposition;
        debate.append(option);
      }
      await loadRounds(generation);
    } catch {
      if (generation === version) root.hidden = true;
    }
  }
  window.addEventListener("yap:account-changed", () => void start());
  window.addEventListener("yap:provider-logout", () => {
    ++version;
    sessionId = null;
    roundId = null;
    setBusy(false);
    root.hidden = true;
    keys.clear();
    receipts.replaceChildren();
    reportList.replaceChildren();
    reportForm.reset();
    reportNotice.textContent = "";
    grants.replaceChildren();
    balanceList.replaceChildren();
    select<HTMLElement>("[data-coin-rounds]").replaceChildren();
    debate.replaceChildren();
    funding.reset();
    withdraw.reset();
    participation.reset();
    participation.hidden = true;
    notice.textContent = "";
  });
  void start();
}
