// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  Profile,
  FollowEntry,
  ActivityEntry,
  CollectionPage,
  AccountError,
} from "./account-types.js";
import { api as request } from "./lib/api.js";
import { accountErrorMessage, sessionStore } from "./lib/session.js";

// The wallet moved to /coins; old links keep working.
if (["#account-wallet", "#coin-sandbox"].includes(location.hash))
  location.replace(`/coins${location.search}${location.hash}`);

interface ProfileForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    handle: HTMLInputElement;
    displayName: HTMLInputElement;
    bio: HTMLTextAreaElement;
  };
}
interface SignInMethod {
  method: "email" | "google";
  email: string;
  linkedAt?: string;
}
interface AccountNotification {
  message: string;
  readAt: string | null;
  createdAt: string;
}
type ProfileChanges = Partial<Pick<Profile, "displayName" | "bio">>;

/* global window, document */
const notice = document.querySelector<HTMLElement>("#account-notice")!;
const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const checkingSignOut = document.createElement("button");
checkingSignOut.id = "account-checking-sign-out";
checkingSignOut.type = "button";
checkingSignOut.className = "button-secondary account-checking-signout";
checkingSignOut.textContent = "Sign out";
checkingSignOut.hidden = true;
notice.parentElement!.append(checkingSignOut);
const profileForm = document.querySelector<ProfileForm>("#profile-form")!;
const fields = profileForm.elements;
const saveButton = profileForm.querySelector<HTMLButtonElement>(
  'button[type="submit"]',
)!;
const saveStatus = document.querySelector<HTMLElement>("#profile-save-status")!;
const profileStateBox =
  document.querySelector<HTMLElement>("#profile-state-box")!;
const profileState = document.querySelector<HTMLElement>("#profile-state")!;
const publishButton =
  document.querySelector<HTMLButtonElement>("#profile-publish")!;
const avatarIcon = [
  ...document.querySelector<HTMLElement>("#account-avatar")!.childNodes,
].map((node) => node.cloneNode(true));
const store = sessionStore();
let currentProfile: Profile | null = null;
let accountVersion = 0;
let signOutPending = false;
let saving = false;
let endedSessionNotice = "";

// Progress and problems stay visible; "ready" is only announced.
function say(message: string, quiet = false) {
  notice.textContent = message;
  notice.classList.toggle("is-quiet", quiet);
}

function api<T = void>(path: string, method = "GET", json?: unknown) {
  return request<T>(path, { method, json, errorMessage: accountErrorMessage });
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? "")
    .join("")
    .toUpperCase();

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function when(value: string) {
  const date = new Date(value);
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return "Just now";
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 24 * 60)
    return relative.format(Math.round(minutes / 60), "hour");
  const days = Math.round(minutes / (24 * 60));
  if (Math.abs(days) < 7) return relative.format(days, "day");
  return date.toLocaleDateString("en", { dateStyle: "medium" });
}
function time(value: string) {
  const element = document.createElement("time");
  element.dateTime = value;
  element.textContent = when(value);
  element.title = new Date(value).toLocaleString("en");
  return element;
}

function item(text: string, href?: string) {
  const row = document.createElement("li");
  const content = href
    ? document.createElement("a")
    : document.createElement("span");
  content.textContent = text;
  if (href) (content as HTMLAnchorElement).href = href;
  row.append(content);
  return row;
}
function empty(text: string, link?: { href: string; label: string }) {
  const row = document.createElement("li");
  row.className = "settings-empty";
  row.textContent = text;
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link.href;
    anchor.textContent = link.label;
    row.append(" ", anchor);
  }
  return row;
}

// Sign-in is a full-page redirect through the provider. Return to the page
// that sent the reader here, or to this account page.
function signInReturn() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (
    next?.startsWith("/") &&
    !next.startsWith("//") &&
    !next.includes("\\") &&
    !next.startsWith("/api/")
  ) {
    const destination = new URL(next, window.location.origin);
    if (destination.origin === window.location.origin)
      return destination.pathname + destination.search + destination.hash;
  }
  return "/account";
}
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "#account-sign-in a[data-sign-in]",
)) {
  const target = new URL(link.href, window.location.origin);
  target.searchParams.set("return", signInReturn());
  link.href = target.pathname + target.search;
}
const back = document.querySelector<HTMLAnchorElement>("[data-auth-return]");
if (back && signInReturn() !== "/account") back.href = signInReturn();

// Tabs follow the address, so /account#security opens that section.
const tabNames = ["profile", "security", "notifications", "privacy"] as const;
type TabName = (typeof tabNames)[number];
const legacyTabs: Readonly<Record<string, TabName>> = {
  "profile-settings": "profile",
  "account-security": "security",
  "account-activity": "security",
};
const tabs = [
  ...document.querySelectorAll<HTMLAnchorElement>('.settings-tab[role="tab"]'),
];
function tabFromAddress(): TabName {
  const name = decodeURIComponent(location.hash.slice(1));
  return (
    legacyTabs[name] ??
    tabNames.find((candidate) => candidate === name) ??
    "profile"
  );
}
function selectTab(name: TabName, focus = false) {
  for (const tab of tabs) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")!)!.hidden =
      !selected;
    if (selected && focus) tab.focus();
  }
}
selectTab(tabFromAddress());
window.addEventListener("hashchange", () => selectTab(tabFromAddress()));
for (const tab of tabs)
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const name = tabNames[next]!;
    history.replaceState(history.state, "", `#${name}`);
    selectTab(name, true);
  });

function showIdentity(profile: Profile | null, email: string) {
  const avatar = document.querySelector<HTMLElement>("#account-avatar")!;
  const letters = profile ? initials(profile.displayName) : "";
  if (letters) avatar.textContent = letters;
  document.querySelector<HTMLElement>("#account-display-name")!.textContent =
    profile?.displayName || "Your account";
  document.querySelector<HTMLElement>("#account-handle")!.textContent = profile
    ? `@${profile.handle}`
    : "";
  if (email)
    document.querySelector<HTMLElement>("#account-name")!.textContent = email;
  const view = document.querySelector<HTMLAnchorElement>("#view-profile")!;
  view.hidden = profile?.publicationState !== "published";
  if (profile) view.href = `/people/${encodeURIComponent(profile.handle)}`;
}

function setCount(input: HTMLInputElement | HTMLTextAreaElement) {
  const counter = document.querySelector<HTMLElement>(
    `[data-count-for="${input.id}"]`,
  );
  if (counter) counter.textContent = `${input.value.length}/${input.maxLength}`;
}
function fieldError(field: string, message = "") {
  if (field !== "displayName" && field !== "bio") return false;
  const target = profileForm.querySelector<HTMLElement>(
    `[data-error-for="${field}"]`,
  )!;
  const input = field === "displayName" ? fields.displayName : fields.bio;
  target.textContent = message;
  target.hidden = !message;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  return true;
}
function profileChanges(): ProfileChanges {
  if (!currentProfile) return {};
  const changes: ProfileChanges = {};
  const displayName = fields.displayName.value.trim();
  const bio = fields.bio.value;
  if (displayName !== currentProfile.displayName)
    changes.displayName = displayName;
  if (bio !== (currentProfile.bio ?? "")) changes.bio = bio || null;
  return changes;
}
function updateSaveButton() {
  saveButton.disabled =
    saving ||
    !currentProfile ||
    currentProfile.publicationState === "hidden" ||
    !Object.keys(profileChanges()).length;
}

function setFormEnabled(enabled: boolean) {
  for (const control of [fields.displayName, fields.bio])
    control.disabled = !enabled;
}

function fillProfile(profile: Profile | null) {
  currentProfile = profile;
  fields.handle.value = profile?.handle ?? "";
  fields.displayName.value = profile?.displayName ?? "";
  fields.bio.value = profile?.bio ?? "";
  for (const input of [fields.displayName, fields.bio]) setCount(input);
  fieldError("displayName");
  fieldError("bio");
  const url = document.querySelector<HTMLAnchorElement>("#profile-url")!;
  url.textContent = profile ? `${location.host}/people/${profile.handle}` : "";
  url.href = profile
    ? `/people/${encodeURIComponent(profile.handle)}`
    : "/account#profile";
  url.hidden = profile?.publicationState !== "published";
  const restricted = profile?.publicationState === "hidden";
  // Every profile is public. One made private earlier is offered a way out.
  const draft = profile?.publicationState === "draft";
  profileStateBox.hidden = Boolean(profile) && !restricted && !draft;
  publishButton.hidden = !draft;
  profileState.textContent = !profile
    ? "Choose your username and handle in the pop-up to set up your profile."
    : restricted
      ? "Moderators have hidden your profile. Contact support before changing it."
      : draft
        ? "Your profile is private. Make it public so people can find you and you can chat in debates."
        : "";
  setFormEnabled(Boolean(profile) && !restricted);
  updateSaveButton();
}

async function loadProfile(version = accountVersion) {
  let profile: Profile | null = null;
  try {
    profile = (await api<{ profile: Profile }>("/api/me/profile")).profile;
  } catch (error) {
    if ((error as AccountError).status !== 404) throw error;
  }
  if (version !== accountVersion) return null;
  fillProfile(profile);
  return profile;
}

async function loadCollection<T>(
  path: string,
  selector: string,
  render: (entry: T) => HTMLLIElement,
  none: () => HTMLLIElement,
  version = accountVersion,
) {
  const list = document.querySelector<HTMLElement>(selector)!;
  let offset = 0;
  async function nextPage() {
    const data = await api<CollectionPage<T>>(
      `${path}?limit=20&offset=${offset}`,
    );
    if (version !== accountVersion) return;
    if (!offset) list.replaceChildren();
    if (!offset && !data.items.length) list.append(none());
    for (const entry of data.items) list.append(render(entry));
    offset += data.items.length;
    list.querySelector<HTMLElement>(".load-more")?.closest("li")?.remove();
    if (data.pagination.hasMore) {
      const row = document.createElement("li");
      row.className = "settings-more";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small-button load-more";
      button.textContent = "Show more";
      button.addEventListener("click", () =>
        nextPage().catch((error: unknown) =>
          say((error as AccountError).message),
        ),
      );
      row.append(button);
      list.append(row);
    }
  }
  await nextPage();
}

const methodIcons = {
  google: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z"/><path fill="#34a853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z"/><path fill="#ea4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6Z"/></svg>`,
  email: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>`,
};
function methodRow(entry: SignInMethod) {
  const row = document.createElement("li");
  row.className = "settings-method";
  const mark = document.createElement("span");
  mark.className = "settings-method-icon";
  mark.dataset.method = entry.method;
  mark.innerHTML = methodIcons[entry.method];
  const text = document.createElement("span");
  const name = document.createElement("strong");
  const email = document.createElement("small");
  name.textContent = entry.method === "google" ? "Google" : "Email code";
  email.textContent = entry.email;
  text.append(name, email);
  row.append(mark, text);
  if (entry.linkedAt) {
    const added = document.createElement("span");
    added.className = "settings-method-date";
    added.textContent = `Added ${new Date(entry.linkedAt).toLocaleDateString(
      "en",
      { dateStyle: "medium" },
    )}`;
    row.append(added);
  }
  return row;
}

async function loadAccount() {
  // Refreshing the account already on screen updates it in place, so the page
  // does not collapse and lose the reader's place. Another account, or none,
  // still clears everything first.
  const shown = signedIn.hidden ? null : store.account();
  if (shown) ++accountVersion;
  else {
    clearAccountState(true);
    say("Checking your account…");
  }
  let version = accountVersion;
  try {
    // Shared with the header's read of the same account.
    const user = await store.me();
    if (version !== accountVersion) return;
    if (!user) {
      showSignedOut();
      return;
    }
    if (shown && user.id !== shown) {
      clearAccountState(true);
      version = accountVersion;
    }
    endedSessionNotice = "";
    checkingSignOut.hidden = true;
    signedOut.hidden = true;
    signedIn.hidden = false;
    const [methods, profile] = await Promise.all([
      api<{ methods: SignInMethod[] }>("/api/auth/methods"),
      loadProfile(version),
    ]);
    if (version !== accountVersion) return;
    showIdentity(profile, methods.methods[0]?.email || user.email || "");
    document
      .querySelector<HTMLElement>("#sign-in-methods")
      ?.replaceChildren(...methods.methods.map(methodRow));
    await Promise.all([
      loadNotifications(version),
      loadCollection<FollowEntry>(
        "/api/me/follows",
        "#follow-list",
        (entry) =>
          item(
            `${entry.targetType === "topic" ? "Topic" : "Person"}: ${entry.title}`,
            entry.targetType === "topic"
              ? `/topics/${encodeURIComponent(entry.slug)}`
              : `/people/${encodeURIComponent(entry.slug)}`,
          ),
        () =>
          empty("You're not following anyone yet.", {
            href: "/debates",
            label: "Explore debates",
          }),
        version,
      ),
      loadCollection<ActivityEntry>(
        "/api/me/activity",
        "#activity-list",
        (entry) => {
          const row = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = entry.label;
          row.append(label, time(entry.occurredAt));
          return row;
        },
        () => empty("No recent activity."),
        version,
      ),
    ]);
    if (version !== accountVersion) return;
    say("Account ready.", true);
  } catch (error) {
    if (version !== accountVersion) return;
    if ((error as AccountError).status === 401) {
      store.remember(null);
      showSignedOut();
      return;
    }
    // An in-place refresh that cannot confirm the account must not leave the
    // previous details on screen.
    if (shown) clearAccountState(true);
    say((error as AccountError).message);
  }
}

function showSignedOut() {
  clearAccountState();
  say(endedSessionNotice, !endedSessionNotice);
}

const signOutButtons = [
  document.querySelector<HTMLButtonElement>("#sign-out")!,
  checkingSignOut,
];
for (const button of signOutButtons)
  button.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (signOutPending || button.disabled) return;
    signOutPending = true;
    const version = accountVersion;
    const expectedAccount = store.account();
    for (const control of signOutButtons) control.disabled = true;
    say("Signing out…");
    try {
      const response = await store.fetch("/api/auth/logout", {
        method: "POST",
        signal: AbortSignal.timeout(45000),
      });
      const body: { error?: string; redirectTo?: unknown } = response.headers
        .get("Content-Type")
        ?.includes("application/json")
        ? await response.json()
        : {};
      if (!response.ok && response.status !== 401)
        throw new Error(
          body.error || "Sign out could not complete. Try again.",
        );
      const expired = response.status === 401;
      if (version !== accountVersion) {
        if (expectedAccount && expectedAccount === store.account())
          window.dispatchEvent(new Event("yap:account-changed"));
        return;
      }
      store.signedOut(expired);
      // Signing out also ends this browser's provider session; the provider
      // then returns to the home page.
      if (typeof body.redirectTo === "string") {
        const target = new URL(body.redirectTo);
        if (target.protocol === "https:" || target.protocol === "http:") {
          window.location.assign(target.href);
          return;
        }
      }
      document
        .querySelector<HTMLAnchorElement>("#account-sign-in a[data-sign-in]")
        ?.focus();
    } catch (error) {
      if (version === accountVersion) say((error as AccountError).message);
    } finally {
      signOutPending = false;
      for (const control of signOutButtons) control.disabled = false;
    }
  });

for (const input of [fields.displayName, fields.bio])
  input.addEventListener("input", () => {
    setCount(input);
    fieldError(input.name);
    saveStatus.textContent = "";
    updateSaveButton();
  });
publishButton.addEventListener("click", async () => {
  if (saving || currentProfile?.publicationState !== "draft") return;
  const version = accountVersion;
  saving = true;
  publishButton.disabled = true;
  try {
    const { profile } = await api<{ profile: Profile }>(
      "/api/me/profile",
      "PATCH",
      { publicationState: "published" },
    );
    if (version !== accountVersion) return;
    fillProfile(profile);
    showIdentity(profile, "");
    saveStatus.textContent = "Your profile is public.";
    window.dispatchEvent(
      new CustomEvent("yap:profile-changed", { detail: profile }),
    );
  } catch (error) {
    if (version === accountVersion)
      profileState.textContent = (error as AccountError).message;
  } finally {
    saving = false;
    publishButton.disabled = false;
    updateSaveButton();
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const changes = profileChanges();
  if (saving || !Object.keys(changes).length) return;
  if (changes.displayName === "") {
    fieldError("displayName", "Enter a username between 1 and 80 characters.");
    fields.displayName.focus();
    return;
  }
  const version = accountVersion;
  saving = true;
  updateSaveButton();
  saveStatus.textContent = "Saving…";
  try {
    const { profile } = await api<{ profile: Profile }>(
      "/api/me/profile",
      "PATCH",
      changes,
    );
    if (version !== accountVersion) return;
    fillProfile(profile);
    showIdentity(profile, "");
    saveStatus.textContent = "Saved.";
    window.dispatchEvent(
      new CustomEvent("yap:profile-changed", { detail: profile }),
    );
  } catch (error) {
    if (version !== accountVersion) return;
    const problem = error as AccountError;
    const field = problem.field;
    if (field && fieldError(field, problem.message)) {
      saveStatus.textContent = "";
      (field === "bio" ? fields.bio : fields.displayName).focus();
    } else saveStatus.textContent = problem.message;
  } finally {
    saving = false;
    updateSaveButton();
  }
});

async function loadNotifications(version = accountVersion) {
  const list = document.querySelector<HTMLElement>("#account-notifications")!;
  const { notifications } = await api<{
    notifications: AccountNotification[];
  }>("/api/matching/notifications");
  if (version !== accountVersion) return;
  list.replaceChildren();
  if (!notifications.length) list.append(empty("You're all caught up."));
  for (const notification of notifications) {
    const row = document.createElement("li");
    if (!notification.readAt) row.className = "is-unread";
    const message = document.createElement("span");
    message.textContent = notification.message;
    row.append(message, time(notification.createdAt));
    list.append(row);
  }
  const unread = notifications.filter((entry) => !entry.readAt).length;
  const badge = document.querySelector<HTMLElement>("#notification-count")!;
  badge.textContent = unread > 9 ? "9+" : String(unread);
  badge.hidden = !unread;
}

document
  .querySelector<HTMLButtonElement>("[data-open-measurement]")!
  .addEventListener("click", () =>
    document.querySelector<HTMLButtonElement>(".measurement-settings")?.click(),
  );

function clearAccountState(checking = false) {
  ++accountVersion;
  currentProfile = null;
  signedIn.hidden = true;
  signedOut.hidden = checking;
  checkingSignOut.hidden = !checking;
  const avatar = document.querySelector<HTMLElement>("#account-avatar")!;
  avatar.replaceChildren(...avatarIcon.map((node) => node.cloneNode(true)));
  for (const selector of [
    "#account-display-name",
    "#account-handle",
    "#account-name",
  ])
    document.querySelector<HTMLElement>(selector)!.textContent = "";
  document.querySelector<HTMLElement>("#view-profile")!.hidden = true;
  profileForm.reset();
  fillProfile(null);
  profileStateBox.hidden = true;
  saveStatus.textContent = "";
  for (const selector of [
    "#sign-in-methods",
    "#follow-list",
    "#activity-list",
    "#account-notifications",
  ])
    document.querySelector<HTMLElement>(selector)!.replaceChildren();
  document.querySelector<HTMLElement>("#notification-count")!.hidden = true;
}
window.addEventListener("yap:provider-logout", (event) => {
  const expired: unknown = event instanceof CustomEvent ? event.detail : false;
  endedSessionNotice =
    expired === true
      ? "This session had already ended. Sign in again to continue."
      : "";
  clearAccountState();
  say(endedSessionNotice, !endedSessionNotice);
});
window.addEventListener("yap:account-changed", () => void loadAccount());
// The pop-up created the profile, or another page saved it.
window.addEventListener("yap:profile-changed", (event) => {
  if (signedIn.hidden || saving) return;
  fillProfile(event.detail);
  showIdentity(event.detail, "");
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void loadAccount();
});
loadAccount();
