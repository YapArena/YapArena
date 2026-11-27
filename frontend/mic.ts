// Decision 0018, borrow the microphone, on the debate page. This module reads
// the debate's mic (the public list, and the signed-in viewer's own pledges),
// shares each read with the rest of the page (frontend/mic-state.ts), and
// puts the interface on a debate that can still run a mic: the Mic tab's
// panel (the same element sits in the phone full screen's Mic sheet), the
// band over the video and the "Yapper incoming" animation. The rules are in
// frontend/mic-model.ts; the server decides every write.
import { api, apiErrorStatus } from "./lib/api.js";
import { claimWelcome, readSummary } from "./lib/coins.js";
import { sessionStore } from "./lib/session.js";
import type { TurnDetail } from "./debate-layout-model.js";
import {
  askerView,
  bandView,
  campView,
  fireable,
  firstCamp,
  fundView,
  INCOMING_MS,
  incomingView,
  INVITE_MS,
  inviteDue,
  liveView,
  micBadge,
  micError,
  micPhase,
  ownSignature,
  pollDelay,
  stateLine,
  wholeCoins,
  yc,
  type CampView,
  type MicOwn,
  type MicPublic,
  type Names,
  type RowView,
  type Side,
} from "./mic-model.js";
import { shareMic } from "./mic-state.js";
import { PHONE_WATCH_QUERY } from "./watch-phone.js";

const arena = document.querySelector<HTMLElement>("[data-arena][data-mic]");
if (arena) start(arena);

function start(arena: HTMLElement) {
  const debateId = arena.dataset.debateId ?? "";
  const turnSeconds = Number(arena.dataset.turnSeconds) || 60;
  const stake = arena.querySelector<HTMLElement>("[data-stake-panel]");
  const names: Names = {
    A: stake?.dataset.speakerA ?? "Speaker A",
    B: stake?.dataset.speakerB ?? "Speaker B",
  };
  const base = `/api/debates/${encodeURIComponent(debateId)}/mic`;
  const store = sessionStore();

  // ---- Reading ----
  let mic: MicPublic | null = null;
  let own: MicOwn | null = null;
  let signedIn = false;
  let available = true;
  let eventStatus = arena.dataset.debateStatus ?? "";
  let offset = 0;
  let turn: TurnDetail | null = null;
  let reading = false;
  let again = false;
  let wantOwn = true;
  let ownSeen = "";
  let timer = 0;

  const viewer = () => ({ signedIn, own, eventStatus });
  async function read() {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    window.clearTimeout(timer);
    try {
      mic = await api<MicPublic>(base, { cache: "no-store", timeout: 10_000 });
      const live =
        eventStatus === "live" && micPhase(mic, eventStatus) !== "off";
      if (!signedIn || !live) own = null;
      else if (wantOwn || ownSignature(mic, own) !== ownSeen)
        try {
          own = await api<MicOwn>(`${base}/mine`, {
            cache: "no-store",
            timeout: 10_000,
          });
          wantOwn = false;
          ownSeen = ownSignature(mic, own);
        } catch (error) {
          if (apiErrorStatus(error) === 401) {
            signedIn = false;
            own = null;
          }
        }
    } catch (error) {
      // No mic routes on this server: nothing more to read or show. Any
      // other failure keeps the last read; the next one tries again.
      if (apiErrorStatus(error) === 404) {
        available = false;
        mic = null;
      }
    } finally {
      reading = false;
    }
    shareMic({ debateId, mic, own, signedIn });
    render();
    if (again) {
      again = false;
      void read();
      return;
    }
    const delay = pollDelay({
      available,
      eventStatus,
      hidden: document.hidden,
      busy: Boolean(mic?.mics.some((entry) => entry.state !== "done")),
    });
    if (delay !== null) timer = window.setTimeout(() => void read(), delay);
  }
  let soonTimer = 0;
  function soon() {
    window.clearTimeout(soonTimer);
    soonTimer = window.setTimeout(() => void read(), 150);
  }
  async function session() {
    try {
      signedIn = Boolean(await store.me());
    } catch {
      signedIn = false;
    }
    wantOwn = true;
    void read();
  }
  let turnKey = "";
  window.addEventListener("yap:turn", (event) => {
    if (event.detail.debateId !== debateId) return;
    turn = event.detail;
    eventStatus = turn.eventStatus;
    offset = turn.serverOffset;
    const key = `${turn.eventStatus}:${turn.state}:${turn.turnNumber}:${turn.turnDeadlineAt}`;
    if (key === turnKey) return;
    turnKey = key;
    if (available) soon();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && available) soon();
  });
  window.addEventListener("yap:account-changed", () => void session());

  // ---- The page's parts; none on a debate that can run no mic ----
  const panel = arena.querySelector<HTMLElement>("[data-mic-panel]");
  const one = <T extends HTMLElement = HTMLElement>(selector: string) =>
    panel?.querySelector<T>(selector) ?? null;
  const tab = arena.querySelector<HTMLButtonElement>("#arena-tab-mic");
  const railButton = arena.querySelector<HTMLButtonElement>(
    '[data-watch-open="mic"]',
  );
  const sheet = arena.querySelector<HTMLElement>('[data-watch-sheet="mic"]');
  const stateText = one("[data-mic-state]");
  const you = one("[data-mic-you]");
  const youTitle = one("[data-mic-you-title]");
  const sayForm = one<HTMLFormElement>("[data-mic-say]");
  const sayText = one<HTMLTextAreaElement>("#mic-say-text");
  const live = one("[data-mic-live]");
  const liveLine = one("[data-mic-live-line]");
  const fund = one("[data-mic-fund]");
  const fundTitle = one("[data-mic-fund-title]");
  const fundMeter = one("[data-mic-fund-meter]");
  const fundProgress = one("[data-mic-fund-progress]");
  const keep = one("[data-mic-keep]");
  const queued = one("[data-mic-queued]");
  const camps = one("[data-mic-camps]");
  const campSwitch = one("[data-mic-switch]");
  const fireTop = one<HTMLButtonElement>("[data-mic-fire-top]");
  const signIn = one("[data-mic-signin]");
  const status = one("[data-mic-status]");
  const askForm = one<HTMLFormElement>("[data-mic-ask]");
  const askText = one<HTMLTextAreaElement>("#mic-ask-text");
  const askPledge = one<HTMLInputElement>("#mic-ask-pledge");
  const askSubmit = one<HTMLButtonElement>("[data-mic-ask-submit]");
  const backForm = one<HTMLFormElement>("[data-mic-back]");
  const backAmount = one<HTMLInputElement>("#mic-back-amount");
  const backAdd = one<HTMLInputElement>("#mic-back-add");
  const band = arena.querySelector<HTMLElement>("[data-mic-band]");
  const incoming = arena.querySelector<HTMLElement>("[data-mic-incoming]");
  const invite = arena.querySelector<HTMLButtonElement>("[data-mic-invite]");
  const announce = arena.querySelector<HTMLElement>("[data-mic-announce]");
  const phone = matchMedia(PHONE_WATCH_QUERY);

  const setText = (node: Element | null, text: string) => {
    if (node && node.textContent !== text) node.textContent = text;
  };
  const show = (node: HTMLElement | null, shown: boolean) => {
    if (node && node.hidden === shown) node.hidden = !shown;
  };
  // A phone floats the line over its Mic sheet, so it goes after a while.
  let sayTimer = 0;
  function say(text: string) {
    setText(status, text);
    window.clearTimeout(sayTimer);
    if (text) sayTimer = window.setTimeout(() => setText(status, ""), 6000);
  }
  const first = (side: Side) => names[side].trim().split(/\s+/)[0] ?? "";

  // ---- Writing: each one holds, returns or spends the viewer's coins ----
  let busy = false;
  async function write<T>(
    path: string,
    method: "POST" | "DELETE",
    json?: Record<string, unknown>,
  ): Promise<T | null> {
    if (busy) return null;
    busy = true;
    if (panel) panel.dataset.busy = "";
    try {
      // The server checks the write against the account's current session,
      // and holds coins only once the welcome grant is claimed.
      const summary = await claimWelcome(await readSummary(15_000), 15_000);
      const result = await api<T>(`${base}${path}`, {
        method,
        cache: "no-store",
        headers: { "X-YapArena-Session": summary.sessionId },
        ...(json ? { json } : {}),
        timeout: 15_000,
      });
      window.dispatchEvent(new Event("yap:coins-changed"));
      return result;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      say(
        micError(
          apiErrorStatus(error),
          error instanceof Error ? error.message : "",
          typeof code === "string" ? code : undefined,
        ),
      );
      return null;
    } finally {
      busy = false;
      if (panel) delete panel.dataset.busy;
      wantOwn = true;
      void read();
    }
  }
  const requestId = () => crypto.randomUUID();
  const amountError = "Enter a whole number of Yap Coins, at least 1.";
  function pledge(questionId: string, amount: number, add: string | null) {
    return write(`/questions/${questionId}/pledges`, "POST", {
      amount,
      add,
      requestId: requestId(),
    }).then((result) => {
      if (result) say(`Pledged ${yc(amount)}.`);
      return result;
    });
  }
  function keepOn(amount: number) {
    return write<{ amount: number; funded: boolean }>("/keep", "POST", {
      amount,
      requestId: requestId(),
    }).then((result) => {
      if (result)
        say(
          result.funded
            ? `Pledged ${yc(result.amount)}. The extra question is funded.`
            : `Pledged ${yc(result.amount)}. It comes back if the price isn't reached.`,
        );
      return result;
    });
  }

  // A first press arms a write that spends coins for good or removes a
  // question; a second press within five seconds does it.
  let armed: { key: string; timer: number } | null = null;
  function arm(key: string) {
    if (armed?.key === key) {
      window.clearTimeout(armed.timer);
      armed = null;
      return true;
    }
    if (armed) window.clearTimeout(armed.timer);
    armed = {
      key,
      timer: window.setTimeout(() => {
        armed = null;
        render();
      }, 5000),
    };
    render();
    return false;
  }

  // ---- The two lists: one for each debater, most backed first ----
  // "Other" opens the one amount form under a question or the fund; "Ask"
  // opens the one question form under a debater's list.
  type Other = { kind: "question"; id: string } | { kind: "keep" } | null;
  let other: Other = null;
  let asking: Side | null = null;
  // Phones (public/mic.css): one debater's list at a time, and a question's
  // amounts open under it from its Pledge button, one question at a time.
  let shown: Side | null = null;
  let shownList = "";
  let tray: string | null = null;
  interface Row {
    item: HTMLLIElement;
    rank: HTMLElement;
    text: HTMLElement;
    total: HTMLElement;
    meta: HTMLElement;
    adds: HTMLUListElement;
    mine: HTMLUListElement;
    add: HTMLButtonElement;
    chips: HTMLElement;
    seen: string;
  }
  interface Camp {
    section: HTMLElement;
    count: HTMLElement | null;
    list: HTMLElement | null;
    empty: HTMLElement | null;
    askOpen: HTMLButtonElement | null;
    rows: Map<string, Row>;
  }
  const camp = (side: Side): Camp | null => {
    const section = camps?.querySelector<HTMLElement>(
      `[data-mic-camp="${side}"]`,
    );
    return section
      ? {
          section,
          count: section.querySelector("[data-mic-camp-count]"),
          list: section.querySelector("[data-mic-list]"),
          empty: section.querySelector("[data-mic-empty]"),
          askOpen: section.querySelector("[data-mic-ask-open]"),
          rows: new Map(),
        }
      : null;
  };
  const parts: Record<Side, Camp | null> = { A: camp("A"), B: camp("B") };
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  function amountChips() {
    const chips = element("span", "mic-chips");
    for (const amount of [10, 50]) {
      const chip = element("button", "mic-chip");
      chip.type = "button";
      chip.dataset.micAmount = String(amount);
      chip.textContent = `+${amount}`;
      chip.setAttribute("aria-label", `Pledge ${yc(amount)}`);
      chips.append(chip);
    }
    const more = element("button", "mic-chip");
    more.type = "button";
    more.dataset.micOther = "";
    more.textContent = "Other";
    chips.append(more);
    return chips;
  }
  function createRow(id: string): Row {
    const item = element("li", "mic-q");
    item.dataset.question = id;
    const head = element("div", "mic-q-head");
    const rank = element("span", "mic-q-rank");
    const total = element("strong", "mic-q-total");
    const text = element("p", "mic-q-text");
    head.append(rank, text, total);
    const meta = element("p", "mic-q-meta");
    const adds = element("ul", "mic-q-adds");
    adds.setAttribute("aria-label", "Comments from people who pledged");
    const mine = element("ul", "mic-q-mine");
    mine.setAttribute("aria-label", "Your pledges on this question");
    const add = element("button", "mic-q-add");
    add.type = "button";
    add.dataset.micTray = "";
    add.textContent = "Pledge";
    const chips = amountChips();
    item.append(head, meta, adds, mine, add, chips);
    return { item, rank, text, total, meta, adds, mine, add, chips, seen: "" };
  }
  function updateRow(row: Row, data: RowView) {
    const open = tray === data.id;
    const signature = JSON.stringify([data, armed?.key, other, open]);
    if (signature === row.seen) return;
    // A total that moved pulses once.
    if (row.seen && row.total.textContent !== data.total) {
      row.total.classList.remove("mic-bump");
      void row.total.offsetWidth;
      row.total.classList.add("mic-bump");
    }
    row.seen = signature;
    setText(row.rank, `#${data.rank}`);
    row.item.dataset.rank = String(data.rank);
    row.item.style.setProperty("--share", `${data.share}%`);
    row.item.toggleAttribute("data-own", data.own);
    row.item.toggleAttribute("data-tray", open);
    setText(row.text, data.text);
    setText(row.total, data.total);
    setText(row.meta, data.meta);
    row.adds.replaceChildren(
      ...data.adds.map((add) => {
        const line = document.createElement("li");
        line.textContent = `“${add.text}” · ${add.by}`;
        return line;
      }),
    );
    show(row.adds, data.adds.length > 0);
    row.mine.replaceChildren(
      ...data.mine.map((held) => {
        const line = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${held.wager ? "Your question" : "You pledged"} · ${yc(held.amount)}`;
        const withdraw = element("button", "mic-link");
        withdraw.type = "button";
        withdraw.dataset.micWithdraw = held.id;
        if (held.wager) withdraw.dataset.wager = "";
        withdraw.textContent =
          armed?.key === `withdraw:${held.id}`
            ? "Press again: removes your question"
            : "Withdraw";
        line.append(label, withdraw);
        return line;
      }),
    );
    show(row.mine, data.mine.length > 0);
    const typing = other?.kind === "question" && other.id === data.id;
    show(row.add, data.canPledge && !typing);
    row.add.setAttribute("aria-expanded", String(open));
    row.add.setAttribute(
      "aria-label",
      open ? "Close the amounts" : `Pledge on question ${data.rank}`,
    );
    show(row.chips, data.canPledge && !typing);
  }
  function closeOther() {
    if (!backForm || !panel) return;
    other = null;
    backForm.hidden = true;
    panel.append(backForm);
  }
  function openOther(next: NonNullable<Other>, host: HTMLElement) {
    if (!backForm) return;
    other = next;
    if (backAdd) backAdd.hidden = next.kind === "keep";
    host.append(backForm);
    backForm.hidden = false;
    render();
    backAmount?.focus({ preventScroll: true });
    backAmount?.select();
  }
  function closeAsk() {
    if (!askForm || !panel) return;
    asking = null;
    askForm.hidden = true;
    panel.append(askForm);
  }
  function renderList(part: Camp, view: CampView) {
    const list = part.list;
    if (!list) return;
    const kept = new Set(view.rows.map((row) => row.id));
    for (const [id, row] of part.rows)
      if (!kept.has(id)) {
        if (other?.kind === "question" && other.id === id) closeOther();
        if (tray === id) tray = null;
        row.item.remove();
        part.rows.delete(id);
      }
    // Rows move as totals change; a field being typed in keeps its focus.
    const focused = document.activeElement;
    let previous: Element | null = null;
    for (const data of view.rows) {
      const row = part.rows.get(data.id) ?? createRow(data.id);
      part.rows.set(data.id, row);
      updateRow(row, data);
      const expected: Element | null = previous
        ? previous.nextElementSibling
        : list.firstElementChild;
      if (expected !== row.item) list.insertBefore(row.item, expected);
      previous = row.item;
    }
    if (
      focused instanceof HTMLElement &&
      focused !== document.activeElement &&
      list.contains(focused)
    )
      focused.focus({ preventScroll: true });
  }
  function renderCamps(open: boolean) {
    show(camps, open);
    show(campSwitch, open);
    show(signIn, open && !signedIn);
    const firing = open && mic ? fireable(mic, viewer(), names) : null;
    show(fireTop, Boolean(firing));
    if (firing && fireTop) {
      fireTop.dataset.question = firing.row.id;
      setText(
        fireTop,
        armed?.key === `fire:${firing.row.id}`
          ? `Press again to fire · ${firing.row.total} to the debaters`
          : `Fire the mic · you're #1 for ${first(firing.target)}`,
      );
    }
    if (!open || !mic) {
      closeOther();
      closeAsk();
      for (const part of Object.values(parts)) {
        if (!part) continue;
        for (const row of part.rows.values()) row.item.remove();
        part.rows.clear();
      }
      tray = null;
      return;
    }
    // Each new list starts on the debater the viewer asked, else the one
    // with the most backed question; after that the viewer chooses.
    const listId = mic.list?.id ?? "";
    if (shown === null || listId !== shownList) {
      shown = firstCamp(mic, own);
      shownList = listId;
    }
    for (const node of [camps, campSwitch])
      if (node && node.dataset.shown !== shown) node.dataset.shown = shown;
    for (const side of ["A", "B"] as const) {
      const part = parts[side];
      if (!part) continue;
      const view = campView(mic, side, viewer(), names);
      if (asking === side && view.askBlocked !== null) closeAsk();
      renderList(part, view);
      const key = campSwitch?.querySelector<HTMLButtonElement>(
        `[data-mic-show="${side}"]`,
      );
      key?.setAttribute("aria-pressed", String(side === shown));
      setText(
        key?.querySelector("[data-mic-switch-count]") ?? null,
        view.rows.length ? String(view.rows.length) : "",
      );
      setText(part.count, view.rows.length ? String(view.rows.length) : "");
      setText(part.empty, view.rows.length ? "" : view.empty);
      show(part.empty, !view.rows.length && view.empty !== "");
      // No sentence says why a viewer can't ask: the button is just not
      // there (signed out, the one sign-in line under the lists says it).
      show(part.askOpen, view.askBlocked === null && asking !== side);
    }
    renderAskKey();
  }
  function renderAskKey() {
    const amount = wholeCoins(askPledge?.value ?? "");
    setText(
      askSubmit,
      asking && amount
        ? `Ask ${first(asking)} with ${yc(amount)}`
        : asking
          ? `Ask ${first(asking)}`
          : "Ask",
    );
  }

  // ---- The live mic, the fund and the asker's own controls ----
  function renderLive() {
    const view = mic ? liveView(mic, names) : null;
    const money = mic ? fundView(mic, own) : null;
    show(live, Boolean(view || money));
    const line = view?.line
      ? `${view.line} · ${view.detail.charAt(0).toLowerCase()}${view.detail.slice(1)}`
      : "";
    setText(liveLine, line);
    show(liveLine, line !== "");
    show(fund, Boolean(money));
    if (money) {
      setText(fundTitle, money.open ? money.title : money.note);
      setText(
        fundProgress,
        money.mine ? `${money.progress} · ${money.mine}` : money.progress,
      );
      fundMeter?.setAttribute("aria-valuenow", String(money.percent));
      fundMeter
        ?.querySelector<HTMLElement>("span")
        ?.style.setProperty("width", `${money.percent}%`);
      const canKeep = money.open && signedIn && own !== null && !own.seated;
      if (!canKeep && other?.kind === "keep") closeOther();
      show(keep, canKeep);
      show(
        keep?.querySelector<HTMLElement>(".mic-chips") ?? null,
        other?.kind !== "keep",
      );
      if (backAmount && other?.kind === "keep")
        backAmount.max = String(Math.max(1, money.left));
      else backAmount?.removeAttribute("max");
    } else if (other?.kind === "keep") closeOther();
    const lines = view?.queued ?? [];
    if (queued && queued.dataset.seen !== lines.join("\n")) {
      queued.dataset.seen = lines.join("\n");
      queued.replaceChildren(
        ...lines.map((text) => {
          const item = document.createElement("li");
          item.textContent = `Next: ${text}`;
          return item;
        }),
      );
    }
    show(queued, lines.length > 0);
  }
  let askerTurn: number | null = null;
  function renderYou() {
    const view = askerView(mic, own, names);
    show(you, Boolean(view));
    if (!view || !mic?.turn) {
      askerTurn = null;
      return;
    }
    setText(youTitle, view.title);
    if (askerTurn === mic.turn.turnNumber) return;
    // The viewer's turn just started: their controls come to them.
    askerTurn = mic.turn.turnNumber;
    if (sayText) {
      const backed = mic.mics.find((entry) => entry.id === mic!.turn!.micId);
      sayText.value = mic.turn.kind === "question" ? (backed?.text ?? "") : "";
    }
    openPanel();
    requestAnimationFrame(() => sayText?.focus({ preventScroll: true }));
  }
  // The Mic sheet in the phone full screen, the Mic tab anywhere else.
  function openPanel() {
    if (arena.dataset.watch === "open") {
      if (sheet?.hidden) railButton?.click();
    } else if (tab && !tab.hidden) tab.click();
  }

  // ---- Over the video ----
  let spokenTurn: number | null = null;
  let incomingSeen: number | null = null;
  let incomingTimer = 0;
  function renderStage() {
    const view = bandView(mic, names);
    show(band, Boolean(view));
    const starting = incomingView({
      mic,
      names,
      seen: incomingSeen,
      now: Date.now() + offset,
      turnSeconds,
    });
    if (view && band) {
      band.dataset.asking = String(view.asking);
      setText(band.querySelector("[data-mic-band-kicker]"), view.kicker);
      setText(band.querySelector("[data-mic-band-line]"), view.line);
      const text = band.querySelector<HTMLElement>("[data-mic-band-text]");
      setText(text, view.text);
      show(text, view.text !== "");
      const money = band.querySelector<HTMLElement>("[data-mic-band-fund]");
      show(money, Boolean(view.fund));
      if (view.fund && money) {
        setText(
          money.querySelector("[data-mic-band-fund-label]"),
          view.fund.label,
        );
        money
          .querySelector<HTMLElement>(".mic-meter span")
          ?.style.setProperty("width", `${view.fund.percent}%`);
      }
    }
    if (starting && incoming) {
      incomingSeen = starting.turnNumber;
      setText(
        incoming.querySelector("[data-mic-incoming-asker]"),
        starting.asker,
      );
      setText(
        incoming.querySelector("[data-mic-incoming-target]"),
        starting.target,
      );
      setText(incoming.querySelector("[data-mic-incoming-cut]"), starting.cut);
      // Showing it again restarts its animation.
      incoming.hidden = true;
      void incoming.offsetWidth;
      incoming.hidden = false;
      window.clearTimeout(incomingTimer);
      incomingTimer = window.setTimeout(() => {
        incoming.hidden = true;
      }, INCOMING_MS);
    }
    // Each mic turn is said once, with the words on screen.
    const current = mic?.turn ?? null;
    if (view && current && current.turnNumber !== spokenTurn) {
      spokenTurn = current.turnNumber;
      setText(
        announce,
        `${starting ? `${starting.spoken} ` : ""}${view.kicker}. ${view.line}.${view.text ? ` ${view.text}` : ""}`,
      );
    }
  }

  // ---- "Yappers, the mic is open": the phone full screen's invitation ----
  // The phone has no list in view, so when a list opens (or the viewer
  // opens the full screen on an open list) an animated line over the
  // cameras says so, once for each list; a tap opens the Mic sheet.
  const inviteKey = `yaparena-mic-invite:${debateId}`;
  let invitedList: string | null = null;
  try {
    invitedList = sessionStorage.getItem(inviteKey);
  } catch {
    // Without storage the invitation plays once for each page load.
  }
  let inviteTimer = 0;
  function renderInvite() {
    if (!invite) return;
    const due = inviteDue({ mic, eventStatus, own, seen: invitedList });
    if (!due || !phone.matches || arena.dataset.watch !== "open") return;
    if (!sheet?.hidden || !incoming?.hidden) return;
    invitedList = due;
    try {
      sessionStorage.setItem(inviteKey, due);
    } catch {
      // As above.
    }
    invite.hidden = true;
    void invite.offsetWidth;
    invite.hidden = false;
    setText(announce, "Yappers, the mic is open. Ask a debater your question.");
    window.clearTimeout(inviteTimer);
    inviteTimer = window.setTimeout(() => {
      invite.hidden = true;
    }, INVITE_MS);
  }
  invite?.addEventListener("click", () => {
    window.clearTimeout(inviteTimer);
    invite.hidden = true;
    openPanel();
  });
  window.addEventListener("yap:watch", (event) => {
    if (event.detail.debateId !== debateId) return;
    if (event.detail.open) window.setTimeout(renderInvite, 900);
    else if (invite) invite.hidden = true;
  });

  function render() {
    if (!panel) return;
    const phase = micPhase(mic, eventStatus);
    arena.dataset.micPhase = phase;
    const off = phase === "off";
    if (tab && tab.hidden !== off) {
      tab.hidden = off;
      // A hidden tab can't stay the one shown.
      if (off && arena.dataset.tab === "mic")
        arena
          .querySelector<HTMLButtonElement>(
            "[data-arena-tabs] [role='tab']:not([hidden])",
          )
          ?.click();
    }
    if (railButton) railButton.hidden = off;
    const badge = micBadge(mic, viewer(), names);
    const canFire = Boolean(mic && fireable(mic, viewer(), names));
    for (const node of arena.querySelectorAll<HTMLElement>(
      "[data-mic-badge]",
    )) {
      setText(node, badge);
      node.toggleAttribute("data-fire", canFire);
    }
    railButton?.setAttribute(
      "aria-label",
      canFire
        ? "Mic: your question is first, you can fire"
        : badge
          ? `Mic: ${badge} questions`
          : "Mic",
    );
    setText(stateText, phase === "open" ? "" : stateLine(phase, mic));
    renderYou();
    renderLive();
    renderCamps(phase === "open");
    renderStage();
    renderInvite();
  }

  if (panel) {
    // The on-screen keyboard covers the bottom of a phone's Mic sheet, where
    // the question field sits; its height lifts that field clear.
    const viewport = window.visualViewport;
    if (viewport) {
      const lift = () =>
        panel.style.setProperty(
          "--mic-keyboard",
          `${
            Math.abs(viewport.scale - 1) < 0.01
              ? Math.max(
                  0,
                  Math.round(
                    window.innerHeight - viewport.height - viewport.offsetTop,
                  ),
                )
              : 0
          }px`,
        );
      viewport.addEventListener("resize", lift);
      viewport.addEventListener("scroll", lift);
    }
    fireTop?.addEventListener("click", () => {
      const id = fireTop.dataset.question;
      if (!id || !arm(`fire:${id}`)) return;
      void write<{ state: "live" | "queued" }>(
        `/questions/${id}/fire`,
        "POST",
        { requestId: requestId() },
      ).then((fired) => {
        if (fired)
          say(
            fired.state === "live"
              ? "Fired. You have the mic."
              : "Fired. Your mic starts after the one before it.",
          );
      });
    });
    panel.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "button",
      );
      if (!button) return;
      const row = button.closest<HTMLElement>("[data-question]");
      const section = button.closest<HTMLElement>("[data-mic-camp]");
      const inFund = Boolean(button.closest("[data-mic-keep]"));
      if (button.dataset.micShow) {
        shown = button.dataset.micShow === "B" ? "B" : "A";
        closeAsk();
        closeOther();
        tray = null;
        render();
      } else if ("micTray" in button.dataset && row?.dataset.question) {
        tray = tray === row.dataset.question ? null : row.dataset.question;
        if (other?.kind === "question") closeOther();
        render();
      } else if (button.dataset.micAmount) {
        const amount = Number(button.dataset.micAmount);
        if (inFund) void keepOn(amount);
        else if (row?.dataset.question)
          void pledge(row.dataset.question, amount, null);
      } else if ("micOther" in button.dataset) {
        if (inFund && keep) openOther({ kind: "keep" }, keep);
        else if (row?.dataset.question)
          openOther({ kind: "question", id: row.dataset.question }, row);
      } else if (button.dataset.micWithdraw) {
        const held = button.dataset.micWithdraw;
        if ("wager" in button.dataset && !arm(`withdraw:${held}`)) return;
        void write<{ removedQuestion: boolean }>(
          `/pledges/${held}`,
          "DELETE",
        ).then((result) => {
          if (result)
            say(
              result.removedQuestion
                ? "Your question is withdrawn and every pledge on it is refunded."
                : "Withdrawn. The coins are back in your balance.",
            );
        });
      } else if ("micAskOpen" in button.dataset && section && askForm) {
        asking = section.dataset.micCamp === "B" ? "B" : "A";
        section.append(askForm);
        askForm.hidden = false;
        if (askText) askText.placeholder = `Your question for ${names[asking]}`;
        render();
        askText?.focus({ preventScroll: true });
      }
    });
    backForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const amount = wholeCoins(backAmount?.value ?? "");
      const target = other;
      if (!target) return;
      if (!amount) return say(amountError);
      const add = backAdd?.value.trim() ?? "";
      void (
        target.kind === "keep"
          ? keepOn(amount)
          : pledge(target.id, amount, add || null)
      ).then((result) => {
        if (!result) return;
        if (backAdd) backAdd.value = "";
        closeOther();
        render();
      });
    });
    backForm
      ?.querySelector("[data-mic-back-cancel]")
      ?.addEventListener("click", () => {
        closeOther();
        render();
      });
    askForm?.addEventListener("input", renderAskKey);
    askForm
      ?.querySelector("[data-mic-ask-cancel]")
      ?.addEventListener("click", () => {
        const opener = asking ? parts[asking]?.askOpen : null;
        closeAsk();
        render();
        opener?.focus({ preventScroll: true });
      });
    askForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const amount = wholeCoins(askPledge?.value ?? "");
      const text = askText?.value.trim() ?? "";
      const target = asking;
      if (!target) return;
      if (!text) return say("Write your question first.");
      if (!amount) return say(amountError);
      void write("/questions", "POST", {
        target,
        text,
        wager: amount,
        requestId: requestId(),
      }).then((result) => {
        if (!result) return;
        if (askText) askText.value = "";
        closeAsk();
        say(`Your question is on the list with ${yc(amount)}.`);
        render();
      });
    });
    sayForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = sayText?.value.trim() ?? "";
      if (!text) return say("Write your question first.");
      void write("/turn/text", "POST", { text }).then((result) => {
        if (result) say("It's on screen.");
      });
    });
    one("[data-mic-end]")?.addEventListener("click", () => {
      void write("/turn", "POST", { action: "end" }).then((result) => {
        if (result) say("Your turn is over.");
      });
    });
  }

  void session();
}
