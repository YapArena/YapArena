import {
  captureAuthReturn,
  clearAuthReturn,
  readAuthReturn,
  safeAuthReturn,
  type AuthResumeAction,
} from "./auth-return.js";
import type { AuthRequest } from "./auth-events.js";
import type { Profile } from "./account-types.js";
import { apiErrorStatus, apiFetch } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";

type HeaderProfile = Pick<
  Profile,
  "handle" | "displayName" | "publicationState"
>;
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? "")
    .join("")
    .toUpperCase();

const header = document.querySelector<HTMLElement>("[data-site-header]");
if (header) {
  header.dataset.enhanced = "true";
  const guest = header.querySelector<HTMLElement>("[data-header-guest]")!;
  const member = header.querySelector<HTMLElement>("[data-header-member]")!;
  const checking = header.querySelector<HTMLElement>("[data-header-checking]")!;
  const retry = header.querySelector<HTMLButtonElement>("[data-header-retry]")!;
  const status = header.querySelector<HTMLElement>("[data-header-status]")!;
  const balance = header.querySelector<HTMLElement>("[data-header-balance]")!;
  const reserved = header.querySelector<HTMLElement>("[data-header-reserved]")!;
  const avatar = header.querySelector<HTMLElement>("[data-header-account]")!;
  const avatarIcon = [...avatar.childNodes].map((node) => node.cloneNode(true));
  const emailFirst =
    document.documentElement.hasAttribute("data-email-first") ||
    Boolean(document.querySelector("#email-auth"));
  const store = sessionStore();
  let version = 0;
  let endedSessionNotice = "";
  let resumeNotice = "";
  const identity = header.querySelector<HTMLElement>("[data-header-identity]")!;
  const identityCaption = [...identity.childNodes].map((node) =>
    node.cloneNode(true),
  );
  const profileLink = header.querySelector<HTMLAnchorElement>(
    "[data-header-profile-link]",
  )!;
  const logout = header.querySelector<HTMLButtonElement>(
    "[data-header-logout]",
  )!;
  function clearAccount() {
    balance.textContent = "—";
    reserved.textContent = "Checking balance…";
    avatar.replaceChildren(...avatarIcon.map((node) => node.cloneNode(true)));
    identity.replaceChildren(
      ...identityCaption.map((node) => node.cloneNode(true)),
    );
    profileLink.href = "/account#profile";
    for (const menu of header!.querySelectorAll<HTMLDetailsElement>("details"))
      menu.open = false;
  }
  // The menu names the account, and links to its public page once published.
  function showProfile(profile: HeaderProfile) {
    const letters = initials(profile.displayName);
    if (letters) avatar.textContent = letters;
    const name = document.createElement("strong");
    const handle = document.createElement("span");
    name.textContent = profile.displayName;
    handle.textContent = `@${profile.handle}`;
    identity.replaceChildren(name, handle);
    profileLink.href =
      profile.publicationState === "published"
        ? `/people/${encodeURIComponent(profile.handle)}`
        : "/account#profile";
  }
  // A signed-in account without a profile picks its name and handle first.
  let setup: Promise<void> | undefined;
  function requireProfile() {
    // Signing out or switching account closes the pop-up with no profile.
    setup ??= import("./profile-setup.js")
      .then(({ openProfileSetup }) => openProfileSetup())
      .then((profile) => {
        if (!profile || header!.dataset.session !== "member") return;
        status.textContent = `Welcome to YAP Arena, @${profile.handle}.`;
        window.dispatchEvent(
          new CustomEvent("yap:profile-changed", { detail: profile }),
        );
        resumeConfirmedAction();
      })
      .catch(() => {
        status.textContent =
          "Your profile setup couldn't load. Refresh the page to try again.";
      })
      .finally(() => {
        setup = undefined;
      });
  }
  window.addEventListener("yap:profile-changed", (event) => {
    if (header.dataset.session === "member") showProfile(event.detail);
  });
  function session(state: "checking" | "guest" | "member" | "unavailable") {
    header!.dataset.session = state;
    guest.hidden = state !== "guest";
    member.hidden = state !== "member";
    checking.hidden = state !== "checking";
    retry.hidden = state !== "unavailable";
  }
  function legacyBalance(
    value: { available: string; reserved: string; scope: string } | null,
  ) {
    const coins = (raw: string) => {
      const amount = BigInt(raw);
      return `${amount / 1000000n}.${String(amount % 1000000n)
        .padStart(6, "0")
        .slice(0, 2)} YC`;
    };
    balance.textContent = value ? coins(value.available) : "—";
    reserved.textContent = value
      ? `${value.scope} · reserved ${coins(value.reserved)}`
      : "Balance unavailable. Reopen to retry.";
  }
  // Yap Coins are always on (Decision 0013): while the coin sandbox runs, the
  // header shows its balance as the account's Yap Coins, with no other label.
  // Without the sandbox route (404) it falls back to the live wallet.
  async function balanceRequest() {
    const options = { cache: "no-store" as const, timeout: 10000 };
    if (emailFirst) {
      const sandbox = await apiFetch("/api/coin-sandbox/summary", options);
      if (sandbox.status !== 404)
        return { response: sandbox, source: "sandbox" as const };
    }
    return {
      response: await apiFetch(
        emailFirst ? "/api/account-wallet" : "/api/a4/wallet",
        options,
      ),
      source: emailFirst ? ("wallet" as const) : ("play" as const),
    };
  }
  // 10,000 atomic units are one Yap Coin for both cash and grant principal.
  const yapCoins = (atoms: bigint) => {
    const fraction = String(atoms % 10_000n)
      .padStart(4, "0")
      .replace(/0+$/, "");
    return `${atoms / 10_000n}${fraction ? `.${fraction}` : ""} YC`;
  };
  // Shows a balance response; returns false when the account is signed out.
  async function showBalance(
    { response, source }: Awaited<ReturnType<typeof balanceRequest>>,
    current: number,
  ) {
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      balance.textContent = "—";
      reserved.textContent = "Balance unavailable. Reopen to retry.";
      return true;
    }
    if (source === "sandbox") {
      const value: {
        balances: {
          cashAvailable: string;
          reserved: string;
          promotionalPrincipal: string;
          promotionalReserved: string;
        };
      } = await response.json();
      if (current !== version) return true;
      const { balances } = value;
      balance.textContent = yapCoins(
        BigInt(balances.cashAvailable) + BigInt(balances.promotionalPrincipal),
      );
      reserved.textContent = `Reserved ${yapCoins(
        BigInt(balances.reserved) + BigInt(balances.promotionalReserved),
      )}`;
    } else if (source === "wallet") {
      const value: { available: string; reserved: string } =
        await response.json();
      if (current !== version) return true;
      balance.textContent = `${value.available} YC`;
      reserved.textContent = `Reserved ${value.reserved} YC`;
    } else {
      const value: { balances: { kind: string; amount: string }[] } =
        await response.json();
      if (current !== version) return true;
      legacyBalance({
        available:
          value.balances.find((item) => item.kind === "available")?.amount ??
          "0",
        reserved:
          value.balances.find((item) => item.kind === "reserved")?.amount ??
          "0",
        scope: "Ordinary play balance",
      });
      header!.querySelector<HTMLElement>(
        "[data-header-balance-heading]",
      )!.textContent = "Your play balance";
      header!.querySelector<HTMLAnchorElement>(
        "[data-header-balances-link]",
      )!.href = "/coins";
    }
    return true;
  }
  // The first read on a page and after an account change is shared with the
  // page's other account scripts; focus, the timer and retry ask again.
  async function refresh(fresh = true) {
    const current = ++version;
    try {
      const user = await store.me({ fresh }).catch((error: unknown) => {
        if (apiErrorStatus(error) === 403) return null;
        throw error;
      });
      if (current !== version) return;
      if (!user) {
        clearAccount();
        session("guest");
        status.textContent = endedSessionNotice;
        return;
      }
      endedSessionNotice = "";
      session("member");
      status.textContent = resumeNotice;
      const [profileResponse, wallet] = await Promise.all([
        apiFetch("/api/me/profile", { cache: "no-store", timeout: 10000 }),
        balanceRequest(),
      ]);
      if (current !== version) return;
      if (profileResponse.ok) {
        const value: { profile: HeaderProfile } = await profileResponse.json();
        if (current !== version) return;
        showProfile(value.profile);
        resumeConfirmedAction();
      } else if (profileResponse.status === 404) requireProfile();
      else resumeConfirmedAction();
      if (!(await showBalance(wallet, current))) {
        clearAccount();
        session("guest");
      }
    } catch {
      if (current !== version) return;
      clearAccount();
      session("unavailable");
      status.textContent =
        "Account access is temporarily unavailable. Retry when your connection returns.";
    }
  }
  async function providerLogout(response: Response) {
    if (!response.headers.get("Content-Type")?.includes("application/json"))
      return null;
    try {
      const body: { redirectTo?: unknown } = await response.json();
      if (typeof body.redirectTo !== "string") return null;
      const target = new URL(body.redirectTo);
      return target.protocol === "https:" || target.protocol === "http:"
        ? target.href
        : null;
    } catch {
      return null;
    }
  }
  window.addEventListener("yap:coins-changed", () => {
    if (header.dataset.session !== "member") return;
    const current = version;
    void balanceRequest()
      .then(async (wallet) => {
        if (current !== version || (await showBalance(wallet, current))) return;
        clearAccount();
        session("guest");
      })
      .catch(() => {
        if (current !== version) return;
        balance.textContent = "—";
        reserved.textContent = "Balance unavailable. Reopen to retry.";
      });
  });
  window.addEventListener("yap:balance", (event) => {
    if (!emailFirst && header.dataset.session === "member")
      legacyBalance(event.detail);
  });
  window.addEventListener("yap:account-changed", () => {
    resumeNotice = "";
    clearAccount();
    session("checking");
    void refresh(false);
  });
  window.addEventListener("yap:provider-logout", (event) => {
    clearAuthReturn();
    cancelResume?.();
    resumeNotice = "";
    ++version;
    const expired: unknown =
      event instanceof CustomEvent ? event.detail : false;
    endedSessionNotice =
      expired === true
        ? "This session had already ended. Sign in again to continue."
        : "";
    clearAccount();
    session("guest");
    status.textContent = endedSessionNotice;
  });
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      clearAccount();
      session("checking");
      void refresh(false);
    }
  });
  retry.addEventListener("click", () => {
    session("checking");
    void refresh();
  });
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 45000);
  void refresh(false);

  let cancelResume: (() => void) | undefined;
  function returnPath(candidate?: string) {
    return (
      safeAuthReturn(candidate ?? null, location.origin) ??
      safeAuthReturn(
        location.pathname + location.search + location.hash,
        location.origin,
      ) ??
      undefined
    );
  }
  function resumeAction(source: HTMLElement | null): AuthResumeAction {
    const follow = source?.closest<HTMLElement>(".follow-button");
    if (
      follow &&
      (follow.dataset.followType === "topics" ||
        follow.dataset.followType === "people") &&
      /^[a-z0-9][a-z0-9-]{2,79}$/.test(follow.dataset.followSlug ?? "")
    )
      return {
        kind: "follow",
        type: follow.dataset.followType,
        slug: follow.dataset.followSlug!,
      };
    if (source?.closest("[data-community-like]"))
      return { kind: "community-like" };
    if (
      source?.closest("[data-community-chat-form],[data-community-send-status]")
    )
      return { kind: "community-chat" };
    if (source?.closest("[data-community-report-form]"))
      return { kind: "community-report" };
    if (source?.closest("#match-signed-out,#match-signed-in"))
      return { kind: "matching" };
    if (source?.closest("[data-a4]")) return { kind: "a4" };
    if (source?.closest("[data-a4-inline]")) return { kind: "inline-a4" };
    return { kind: "page" };
  }
  function focusable(node: HTMLElement | null): node is HTMLElement {
    return Boolean(
      node?.isConnected &&
      node !== document.body &&
      node !== document.documentElement &&
      node.getClientRects().length &&
      getComputedStyle(node).visibility !== "hidden" &&
      !node.matches(":disabled,[aria-disabled='true']"),
    );
  }
  function actionControl(action: AuthResumeAction): HTMLElement | null {
    if (action.kind === "follow")
      return (
        [...document.querySelectorAll<HTMLElement>(".follow-button")].find(
          (node) =>
            node.dataset.followType === action.type &&
            node.dataset.followSlug === action.slug,
        ) ?? null
      );
    if (action.kind === "page" && location.hash)
      try {
        const fragment = document.getElementById(
          decodeURIComponent(location.hash.slice(1)),
        );
        if (focusable(fragment)) return fragment;
      } catch {
        // An invalid fragment cannot select a different action.
      }
    const selectors = {
      page: "[data-header-account]",
      "community-chat": "[data-community-chat-form] textarea",
      "community-like": "[data-community-like]",
      "community-report": "[data-community-report-form] select",
      matching: "#request-create input",
      a4: "[data-a4-create] select",
      "inline-a4": "[data-inline-form] select,[data-inline-setup] summary",
    };
    return document.querySelector<HTMLElement>(selectors[action.kind]);
  }
  // Sign-in is a full-page redirect through the provider. The stored intent
  // returns focus to the action that needed an account once the page the
  // reader started from loads signed in.
  function resumeConfirmedAction() {
    if (document.hidden || header!.dataset.session !== "member") return;
    const intent = readAuthReturn();
    if (!intent || intent.phase === "oauth" || intent.next !== returnPath())
      return;
    const action = intent.action;
    cancelResume?.();
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener("pointerdown", stop);
      document.removeEventListener("keydown", stop);
      cancelResume = undefined;
      clearAuthReturn();
    };
    const focus = () => {
      if (header!.dataset.session !== "member") return;
      const control = actionControl(action);
      if (!focusable(control)) return;
      resumeNotice =
        "You’re signed in. Review the action, then confirm when you’re ready.";
      status.textContent = resumeNotice;
      if (
        !control.matches(
          "a[href],button,input,textarea,select,summary,[tabindex],[contenteditable]",
        )
      )
        control.tabIndex = -1;
      control.focus();
      stop();
    };
    const observer = new MutationObserver(focus);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "disabled", "aria-disabled", "class"],
    });
    const timer = window.setTimeout(() => {
      if (focusable(avatar)) avatar.focus({ preventScroll: true });
      stop();
    }, 12000);
    cancelResume = stop;
    document.addEventListener("pointerdown", stop, { once: true });
    document.addEventListener("keydown", stop, { once: true });
    focus();
  }
  // Header sign-in links return to the page the reader is on.
  function updateSignInLinks() {
    const next = returnPath();
    for (const link of header!.querySelectorAll<HTMLAnchorElement>(
      "a[data-sign-in]",
    )) {
      const target = new URL(link.href, location.origin);
      if (next) target.searchParams.set("return", next);
      else target.searchParams.delete("return");
      link.href = target.pathname + target.search;
    }
    // The header's one Sign in button opens the account page, which offers
    // both methods, and comes back here afterwards.
    const account = header!.querySelector<HTMLAnchorElement>(
      "a[data-header-sign-in]",
    )!;
    account.href =
      next && !next.startsWith("/account")
        ? `/account?next=${encodeURIComponent(next)}`
        : "/account";
  }
  updateSignInLinks();
  window.addEventListener("hashchange", updateSignInLinks);
  window.addEventListener("popstate", updateSignInLinks);
  function remember(next: string | undefined, source: HTMLElement | null) {
    if (!next) return;
    const existing = readAuthReturn();
    captureAuthReturn(
      next,
      existing?.next === next && existing.phase === "pending"
        ? existing.action
        : resumeAction(source),
    );
  }
  // Features ask for an account and then open the account page, which offers
  // both sign-in methods. Remember what the reader was doing.
  window.addEventListener(
    "yap:request-auth",
    (event: CustomEvent<AuthRequest>) => {
      cancelResume?.();
      remember(returnPath(event.detail.returnTo), event.detail.source ?? null);
    },
  );
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin) return;
    if (link.hasAttribute("data-sign-in")) {
      cancelResume?.();
      remember(returnPath(url.searchParams.get("return") ?? undefined), link);
    } else if (
      header.dataset.session === "guest" &&
      url.pathname === "/account" &&
      url.searchParams.has("next")
    ) {
      cancelResume?.();
      remember(returnPath(url.searchParams.get("next") ?? undefined), link);
    }
  });

  logout.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.disabled) return;
    const logoutVersion = version;
    const expectedAccount = store.account();
    button.disabled = true;
    status.textContent = "Signing out…";
    try {
      const response = await store.fetch("/api/auth/logout", {
        method: "POST",
        signal: AbortSignal.timeout(45000),
      });
      if (logoutVersion !== version) {
        if (expectedAccount && expectedAccount === store.account())
          window.dispatchEvent(new Event("yap:account-changed"));
        return;
      }
      if (!response.ok && response.status !== 401)
        throw new Error("logout unavailable");
      const redirectTo = await providerLogout(response);
      clearAccount();
      session("guest");
      store.signedOut(response.status === 401);
      // Signing out also ends this browser's provider session; the provider
      // then returns to the home page.
      if (redirectTo) location.assign(redirectTo);
      else guest.querySelector<HTMLAnchorElement>("a")?.focus();
    } catch {
      if (logoutVersion === version)
        status.textContent = "Sign out could not complete. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
  for (const menu of header.querySelectorAll<HTMLDetailsElement>("details")) {
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });
    menu.addEventListener("toggle", () => {
      if (menu.open)
        for (const other of header.querySelectorAll<HTMLDetailsElement>(
          "details",
        ))
          if (other !== menu) other.open = false;
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of header.querySelectorAll<HTMLDetailsElement>("details"))
      if (event.target instanceof Node && !menu.contains(event.target))
        menu.open = false;
  });
}

// Live topic queue (Decision 0011): header pill, match dialog and queue buttons.
if (document.documentElement.hasAttribute("data-matchmaking"))
  void import("./matchmaking.js");
