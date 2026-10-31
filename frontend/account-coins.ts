import { api as request, apiFetch } from "./lib/api.js";
import { formatCoins, formatSignedCoins } from "./lib/coin-format.js";
import { features, held, type CoinFeatures } from "./lib/coins.js";

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
  features?: CoinFeatures;
  book: {
    grants: {
      id: string;
      kind: "welcome" | "daily";
      createdAt: string;
      principal: string;
    }[];
  };
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
    promotionalReserved: string;
  };
  requests: CoinRequest[];
}
// One revealed or voided position, from GET /api/coin-sandbox/results.
interface CoinResult {
  roundId: string;
  slug: string;
  proposition: string;
  turnNumber: number | null;
  state: "settled" | "void";
  side: "YES" | "NO";
  quantity: number;
  outcome: { status: string; net: string } | null;
  revealedAt: string;
}
// The grant day, as the server counts it: the calendar day in Toronto.
const torontoDay = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
const nextClaim = "next claim after midnight Toronto time";
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
const yc = (value: string) => formatCoins(value);
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
  // Founder D3/D5: purchases, withdrawals, their error reports and manual
  // rounds appear only when the server offers them (summary.features).
  root.innerHTML = `<p data-coin-notice role="status" aria-live="polite" aria-atomic="true"></p>
    <div class="coin-claim"><button type="button" class="button-secondary" data-coin-daily>Claim today’s 500 YC</button><p class="form-note" data-coin-claim-status role="status" aria-live="polite"></p></div>
    <h3 class="coin-section-title">Grants</h3><ul class="account-list" data-coin-grants></ul>
    <h3 class="coin-section-title">History</h3><p class="form-note" data-coin-open-positions></p><ul class="account-list" data-coin-history></ul>
    <div data-coin-transfers hidden><h3 class="coin-section-title">Simulated purchases and withdrawals</h3><p class="form-note">This deployment simulates buying and withdrawing for testing. No real money moves.</p><dl class="account-balances" data-coin-balances></dl>
    <button type="button" class="button-secondary" data-coin-refresh>Refresh sandbox</button>
    <details class="account-details"><summary>Simulate a purchase</summary><form class="stack-form" data-coin-funding><label>Test USDC amount<input name="amount" inputmode="decimal" value="10" required autocomplete="off"></label><p>Fixed simulation: 1 test USDC buys 100 YC, up to 1,000 USDC at a time. No crypto is sent and no provider conversion is performed.</p><button class="button" type="submit">Get simulated quote</button></form></details>
    <details class="account-details"><summary>Request a simulated withdrawal</summary><form class="stack-form" data-coin-withdraw><label>Total to deduct (USDC)<input name="gross" inputmode="decimal" value="5" required autocomplete="off"></label><label>External wallet destination<input name="destination" maxlength="200" required autocomplete="off" spellcheck="false"></label><p>Minimum deduction: 5 USDC. The displayed fee comes out of that amount. No daily cap. Purchased funds need no profit target; only grant profits have qualification rules.</p><p>Manual review target: two business days (Toronto weekdays, excluding Canadian federal holidays). Network confirmation time is additional. Pending funds stay reserved.</p><button class="button" type="submit">Review amount and network fee</button></form></details>
    <h4>Sandbox receipts</h4><ul class="account-list" data-coin-receipts></ul>
    <details class="account-details"><summary>Report a deposit or payout error</summary><p>Reports have no submission deadline. Include the receipt ID and explain what went wrong. Do not include passwords, verification codes or private keys. Ordinary trading losses are final.</p><form class="stack-form" data-coin-report><label>Receipt ID<input name="requestId" required maxlength="36" autocomplete="off" spellcheck="false"></label><label>What happened?<textarea name="description" required maxlength="2000" rows="4"></textarea></label><button class="button-secondary" type="submit">Submit error report</button></form><p data-coin-report-notice role="status" aria-live="polite" aria-atomic="true"></p><ul class="account-list" data-coin-reports></ul></details></div>
    <details class="account-details" data-coin-manual hidden><summary>Join a YES/NO debate with sandbox coins</summary><label>Existing debate<select data-coin-debate></select></label><button type="button" class="button-secondary" data-coin-open>Open or join the current round</button><div data-coin-rounds></div><form class="stack-form" data-coin-participate hidden><label>Position<select name="side"><option value="YES">YES</option><option value="NO">NO</option></select></label><label>Maximum purchase price per YC (0–1)<input name="ceiling" inputmode="decimal" value="0.5" required></label><label>Quantity (1–100)<input name="quantity" type="number" min="1" max="100" value="1" required></label><p>The first commitment is final. Oldest grants are used first. Positions are Yes or No answers to the debate’s question; nobody is judged the winner.</p><button class="button" type="submit">Review and commit participation</button></form></details>`;
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
    debate = select<HTMLSelectElement>("[data-coin-debate]"),
    transfers = select<HTMLElement>("[data-coin-transfers]"),
    manual = select<HTMLElement>("[data-coin-manual]"),
    claimStatus = select<HTMLElement>("[data-coin-claim-status]"),
    historyList = select<HTMLElement>("[data-coin-history]"),
    openPositions = select<HTMLElement>("[data-coin-open-positions]");
  reportNotice.tabIndex = -1;
  let version = 0,
    busy = false,
    roundId: string | null = null,
    sessionId: string | null = null,
    offered: CoinFeatures = { transfers: false, manualRounds: false };
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
          ? "Yap Coins aren’t available on this site."
          : "Couldn’t confirm the result. Refresh the page before trying again.",
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
          error instanceof Error && offered.transfers
            ? error.message
            : "Something went wrong. Refresh the page and try again.";
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
    // still shows the page, and a refresh tries again.
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
    offered = features(summary);
    transfers.hidden = !offered.transfers;
    manual.hidden = !offered.manualRounds;
    balanceList.replaceChildren();
    grants.replaceChildren();
    receipts.replaceChildren();
    showGrants(summary);
    const open = summary.requests.filter(
      (entry) => entry.kind === "stake" && entry.status === "reserved",
    ).length;
    openPositions.textContent = open
      ? `${open} open ${open === 1 ? "position holds" : "positions hold"} ${yc(String(held(summary.balances)))}. Each one's result arrives when its turn is revealed.`
      : "No open positions.";
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
    for (const request of offered.transfers ? summary.requests : []) {
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
      ? "Your Yap Coins are paused for a correction review. Everything else on your account works as usual."
      : welcomeFailed
        ? "Your welcome grant couldn’t be added yet. Refresh the page to try again."
        : offered.transfers
          ? "Sandbox balances refreshed. Simulated withdrawals require manual operator review."
          : "";
    await loadHistory(generation);
    if (offered.transfers) await loadReports(generation);
  }
  // Grants: the welcome grant and each daily claim, newest first, and
  // whether today's daily claim is done.
  function showGrants(summary: CoinSummary) {
    const today = torontoDay(new Date());
    const list = [...summary.book.grants].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const grant of list) {
      const item = document.createElement("li");
      const day = new Date(grant.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      item.textContent =
        grant.kind === "welcome"
          ? `Welcome grant: ${yc(grant.principal)}`
          : `Daily grant: ${yc(grant.principal)} · ${day}`;
      grants.append(item);
    }
    if (!list.length) {
      const item = document.createElement("li");
      item.textContent = "No grants yet.";
      grants.append(item);
    }
    const claimed = list.some(
      (grant) =>
        grant.kind === "daily" &&
        torontoDay(new Date(grant.createdAt)) === today,
    );
    claimStatus.textContent = claimed ? `Claimed today — ${nextClaim}.` : "";
  }
  // History: revealed and voided positions, newest first, from the results
  // the notice also reads (interface 10).
  async function loadHistory(generation = version) {
    let results: CoinResult[];
    try {
      results = (
        await api<{ results: CoinResult[] }>(
          `/results?since=${encodeURIComponent(new Date(0).toISOString())}`,
        )
      ).results;
    } catch {
      if (generation !== version) return;
      historyList.replaceChildren(
        Object.assign(document.createElement("li"), {
          textContent:
            "Your history couldn’t load. Refresh the page to try again.",
        }),
      );
      return;
    }
    if (generation !== version) return;
    historyList.replaceChildren(
      ...results.map((result) => {
        const item = document.createElement("li"),
          link = document.createElement("a");
        link.href = `/debates/${encodeURIComponent(result.slug)}`;
        link.textContent = `“${result.proposition}”`;
        // An executed position's outcome is "pending" in the engine's words;
        // the others never filled and were refunded.
        const outcome =
          result.state === "void"
            ? "voided · refunded"
            : result.outcome &&
                !["no_opposite", "limit_not_met"].includes(
                  result.outcome.status,
                )
              ? formatSignedCoins(result.outcome.net)
              : "not filled · refunded";
        item.append(
          link,
          document.createTextNode(
            ` · ${result.turnNumber === null ? "Round" : `Turn ${result.turnNumber}`} · ${result.side === "YES" ? "Yes" : "No"} · ${result.quantity} · ${outcome}`,
          ),
        );
        return item;
      }),
    );
    if (!results.length)
      historyList.append(
        Object.assign(document.createElement("li"), {
          textContent:
            "No results yet. Answer “Do you agree?” during a live debate’s speaking turns.",
        }),
      );
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
      const claim = await api<{ created: boolean }>(
        "/grants/daily",
        "POST",
        {},
      );
      window.dispatchEvent(new Event("yap:coins-changed"));
      await load(g);
      if (g !== version) return;
      claimStatus.textContent = claim.created
        ? `Claimed — ${nextClaim}.`
        : `Already claimed today — ${nextClaim}.`;
    });
  // A stake, a reveal or the header changed the balance elsewhere.
  window.addEventListener("yap:coins-changed", () => {
    if (busy || root.hidden) return;
    const generation = version;
    void load(generation).catch(() => {
      // The page keeps its last figures; the next change reads again.
    });
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
    historyList.replaceChildren();
    openPositions.textContent = "";
    claimStatus.textContent = "";
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
      if (generation !== version || !offered.manualRounds) return;
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
    historyList.replaceChildren();
    openPositions.textContent = "";
    claimStatus.textContent = "";
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
