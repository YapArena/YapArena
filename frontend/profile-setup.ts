// The first thing a new account sees: a pop-up that asks for a name and a
// permanent handle before anything else. The header opens it on every page
// while a signed-in account has no profile, so it cannot be skipped.
import type { Profile } from "./account-types.js";
import { apiFetch } from "./lib/api.js";

const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;
const handleHelp = "Lowercase letters, numbers and hyphens.";

/** Turns what someone types into a valid handle as they type it. */
export function normalizeHandle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);
}

export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? "")
    .join("")
    .toUpperCase();
}

function handleProblem(value: string) {
  if (!value) return "Pick a handle.";
  if (value.length < 3) return "Use at least 3 characters.";
  if (!handlePattern.test(value)) return handleHelp;
  return null;
}

const mark = `<svg class="ps-mark" viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="20" rx="13" ry="16" transform="rotate(30 20 20)"/><path d="M9 35 31 5"/></svg>`;

// Shown when people hover over, tap or focus either label's info button.
const handleTip =
  "Handles never change, so links to your profile never break. Your username and bio can change anytime in Settings.";
const label = (id: string, text: string, count: string) =>
  `<div class="ps-label-row"><span class="ps-label"><label for="${id}">${text}</label><button type="button" class="ps-info" aria-label="About ${text.toLowerCase()}s" aria-describedby="${id}-tip">i</button><span class="ps-tip" role="tooltip" id="${id}-tip">${handleTip}</span></span><span class="ps-count" ${count} aria-hidden="true">0/${id === "ps-name" ? 80 : 40}</span></div>`;

const template = `<div class="ps-glow" aria-hidden="true"></div>
<form class="ps-form" novalidate>
  <div class="ps-brand">${mark}<span>YAP ARENA</span></div>
  <div class="ps-progress" role="progressbar" aria-label="Profile setup" aria-valuemin="1" aria-valuemax="2" aria-valuenow="1" aria-valuetext="Step 1 of 2" data-progress="1"><span></span><span></span></div>
  <section class="ps-step" data-step="details">
    <div class="ps-preview" aria-hidden="true">
      <span class="ps-avatar" data-ps-avatar>?</span>
      <span class="ps-preview-text"><strong data-ps-preview-name>Username</strong><span data-ps-preview-handle>@handle</span></span>
    </div>
    <div class="ps-field">
      ${label("ps-name", "Username", "data-ps-name-count")}
      <input id="ps-name" name="displayName" maxlength="80" autocomplete="nickname" placeholder="How should people call you?" required aria-describedby="ps-name-error ps-name-tip" autofocus>
      <p class="ps-error" id="ps-name-error" hidden></p>
    </div>
    <div class="ps-field">
      ${label("ps-handle", "Handle", "data-ps-handle-count")}
      <div class="ps-handle" data-state="idle"><span class="ps-at" aria-hidden="true">@</span><input id="ps-handle" name="handle" maxlength="40" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="your-handle" required aria-describedby="ps-handle-status ps-handle-tip"><span class="ps-handle-icon" aria-hidden="true"></span></div>
      <p class="ps-status" id="ps-handle-status" aria-live="polite">${handleHelp}</p>
    </div>
    <button class="ps-primary" type="submit" data-ps-continue>Continue</button>
  </section>
  <section class="ps-step" data-step="confirm" hidden>
    <h2 class="ps-sr" tabindex="-1">Confirm your handle</h2>
    <div class="ps-claim"><span class="ps-avatar ps-avatar-large" data-ps-confirm-avatar></span><strong data-ps-confirm-name></strong><span data-ps-confirm-handle></span></div>
    <p class="ps-form-error" role="alert" data-ps-form-error hidden></p>
    <div class="ps-actions"><button class="ps-secondary" type="button" data-ps-back>Edit</button><button class="ps-primary" type="submit" data-ps-claim>Claim my handle</button></div>
  </section>
  <section class="ps-step ps-done" data-step="done" hidden>
    <span class="ps-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></span>
    <h2 tabindex="-1" data-ps-done-title>Welcome to the arena</h2>
    <button class="ps-primary" type="button" data-ps-finish>Start exploring</button>
  </section>
</form>`;

let open: Promise<Profile | null> | undefined;

/**
 * Shows the pop-up until the account has a profile. Resolves with the new
 * profile, or null when the page signs out or switches account first.
 */
export function openProfileSetup() {
  open ??= show().finally(() => {
    open = undefined;
  });
  return open;
}

function show() {
  const { promise, resolve } = Promise.withResolvers<Profile | null>();
  const dialog = document.createElement("dialog");
  dialog.className = "profile-setup";
  dialog.setAttribute("aria-label", "Create your profile");
  dialog.innerHTML = template;
  const q = <T extends Element>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const form = q<HTMLFormElement>(".ps-form");
  const name = q<HTMLInputElement>("#ps-name");
  const nameError = q<HTMLElement>("#ps-name-error");
  const handle = q<HTMLInputElement>("#ps-handle");
  const handleBox = q<HTMLElement>(".ps-handle");
  const handleStatus = q<HTMLElement>("#ps-handle-status");
  const progress = q<HTMLElement>(".ps-progress");
  const continueButton = q<HTMLButtonElement>("[data-ps-continue]");
  const claimButton = q<HTMLButtonElement>("[data-ps-claim]");
  const formError = q<HTMLElement>("[data-ps-form-error]");
  const steps = [...dialog.querySelectorAll<HTMLElement>("[data-step]")];

  let step = "details";
  let finished = false;
  let handleEdited = false;
  let suggested = "";
  let available: { handle: string; value: boolean | null } = {
    handle: "",
    value: null,
  };
  let timer: number | undefined;
  let check: AbortController | undefined;
  let created: Profile | null = null;

  function goTo(next: "details" | "confirm" | "done") {
    step = next;
    for (const section of steps) section.hidden = section.dataset.step !== next;
    // The bar shows progress without words; the value is announced.
    const position = next === "details" ? 1 : 2;
    progress.dataset.progress = next === "done" ? "done" : String(position);
    progress.setAttribute("aria-valuenow", String(position));
    progress.setAttribute(
      "aria-valuetext",
      next === "done" ? "Done" : `Step ${position} of 2`,
    );
    const active = steps.find((section) => section.dataset.step === next)!;
    if (next === "details") name.focus();
    else
      active.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
  }

  function setHandleState(
    state: "idle" | "checking" | "available" | "taken" | "invalid",
    message: string,
  ) {
    handleBox.dataset.state = state;
    handleStatus.textContent = message;
    handle.setAttribute(
      "aria-invalid",
      String(state === "taken" || state === "invalid"),
    );
  }

  function render() {
    const displayName = name.value.trim();
    const value = handle.value;
    q<HTMLElement>("[data-ps-avatar]").textContent =
      initials(displayName) || "?";
    q<HTMLElement>("[data-ps-preview-name]").textContent =
      displayName || "Username";
    q<HTMLElement>("[data-ps-preview-handle]").textContent =
      `@${value || "handle"}`;
    q<HTMLElement>("[data-ps-name-count]").textContent =
      `${name.value.length}/80`;
    q<HTMLElement>("[data-ps-handle-count]").textContent = `${value.length}/40`;
    continueButton.disabled = Boolean(
      !displayName ||
      handleProblem(value) ||
      (available.handle === value && available.value === false),
    );
  }

  async function checkHandle(value: string) {
    check?.abort();
    const request = (check = new AbortController());
    try {
      const response = await apiFetch(
        `/api/me/handles/${encodeURIComponent(value)}`,
        { cache: "no-store", signal: request.signal, timeout: 8000 },
      );
      if (handle.value !== value) return;
      if (!response.ok) throw new Error("unavailable");
      const body: { available: boolean; reason?: string } =
        await response.json();
      if (handle.value !== value) return;
      available = { handle: value, value: body.available };
      if (body.available) setHandleState("available", `@${value} is free.`);
      else
        setHandleState(
          body.reason === "taken" ? "taken" : "invalid",
          body.reason === "taken"
            ? `@${value} is taken. Try another.`
            : handleHelp,
        );
    } catch {
      if (handle.value !== value || request.signal.aborted) return;
      available = { handle: value, value: null };
      setHandleState(
        "idle",
        "We couldn't check it right now. You can still continue.",
      );
    }
    render();
  }

  function handleChanged() {
    clearTimeout(timer);
    check?.abort();
    const value = handle.value;
    const problem = handleProblem(value);
    if (problem) {
      available = { handle: value, value: null };
      setHandleState(value ? "invalid" : "idle", value ? problem : handleHelp);
    } else if (available.handle === value && available.value !== null) {
      // Back to a handle already checked: show that answer again.
      setHandleState(
        available.value ? "available" : "taken",
        available.value
          ? `@${value} is free.`
          : `@${value} is taken. Try another.`,
      );
    } else {
      setHandleState("checking", `Checking @${value}…`);
      timer = window.setTimeout(() => void checkHandle(value), 300);
    }
    render();
  }

  function suggest(from: string) {
    const value = normalizeHandle(from).replace(/-+$/, "");
    return value.length >= 3 ? value : "";
  }

  name.addEventListener("input", () => {
    nameError.hidden = true;
    name.removeAttribute("aria-invalid");
    if (!handleEdited) {
      const next = suggest(name.value) || suggested;
      if (next !== handle.value) {
        handle.value = next;
        handleChanged();
      }
    }
    render();
  });
  handle.addEventListener("input", () => {
    handleEdited = true;
    const normalized = normalizeHandle(handle.value);
    if (normalized !== handle.value) {
      const end = handle.selectionEnd ?? normalized.length;
      const removed = handle.value.length - normalized.length;
      handle.value = normalized;
      const caret = Math.max(0, end - removed);
      handle.setSelectionRange(caret, caret);
    }
    handleChanged();
  });

  function showNameError(message: string) {
    nameError.textContent = message;
    nameError.hidden = false;
    name.setAttribute("aria-invalid", "true");
  }

  function detailsReady() {
    const displayName = name.value.trim();
    if (!displayName) {
      showNameError("Enter a username.");
      name.focus();
      return false;
    }
    const problem = handleProblem(handle.value);
    if (problem) {
      setHandleState("invalid", problem);
      handle.focus();
      return false;
    }
    if (available.handle === handle.value && available.value === false) {
      handle.focus();
      return false;
    }
    return true;
  }

  async function claim() {
    claimButton.disabled = true;
    claimButton.textContent = "Claiming…";
    formError.hidden = true;
    try {
      const response = await apiFetch("/api/me/profile", {
        method: "POST",
        json: {
          handle: handle.value,
          displayName: name.value.trim(),
          // Every profile is public (founder, 2026-10-24).
          publicationState: "published",
        },
        timeout: 15000,
      });
      const body: {
        profile?: Profile;
        error?: string;
        code?: string;
        field?: string;
      } = await response.json().catch(() => ({}));
      if (response.status === 201 && body.profile) {
        created = body.profile;
        q<HTMLElement>("[data-ps-done-title]").textContent =
          `Welcome to the arena, ${created.displayName.split(/\s+/)[0]}`;
        goTo("done");
        return;
      }
      if (response.status === 401) return finish(null);
      if (response.status === 409 && body.code === "profile_exists")
        return finish(await existingProfile());
      if (body.field === "handle") {
        goTo("details");
        available = {
          handle: handle.value,
          value: body.code === "handle_taken" ? false : null,
        };
        setHandleState(
          body.code === "handle_taken" ? "taken" : "invalid",
          body.error ?? handleHelp,
        );
        render();
        handle.focus();
        return;
      }
      if (body.field === "displayName") {
        goTo("details");
        showNameError(body.error ?? "Enter a username.");
        return;
      }
      formError.textContent =
        body.error && response.status !== 500
          ? body.error
          : "We couldn't save your profile. Try again.";
      formError.hidden = false;
    } catch {
      formError.textContent =
        "We couldn't reach YAP Arena. Check your connection and try again.";
      formError.hidden = false;
    } finally {
      claimButton.disabled = false;
      claimButton.textContent = "Claim my handle";
    }
  }

  async function existingProfile() {
    const response = await apiFetch("/api/me/profile", {
      cache: "no-store",
      timeout: 10000,
    }).catch(() => null);
    if (!response?.ok) return null;
    const body: { profile: Profile } = await response.json();
    return body.profile;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (step === "details") {
      if (!detailsReady()) return;
      q<HTMLElement>("[data-ps-confirm-avatar]").textContent = initials(
        name.value,
      );
      q<HTMLElement>("[data-ps-confirm-name]").textContent = name.value.trim();
      q<HTMLElement>("[data-ps-confirm-handle]").textContent =
        `@${handle.value}`;
      formError.hidden = true;
      goTo("confirm");
    } else if (step === "confirm") void claim();
  });
  q<HTMLButtonElement>("[data-ps-back]").addEventListener("click", () =>
    goTo("details"),
  );
  q<HTMLButtonElement>("[data-ps-finish]").addEventListener("click", () =>
    finish(created),
  );

  // The step is required: Escape does nothing, and a forced close reopens it.
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.addEventListener("close", () => {
    if (!finished) dialog.showModal();
  });

  function finish(profile: Profile | null) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    check?.abort();
    window.removeEventListener("yap:account-changed", ended);
    window.removeEventListener("yap:provider-logout", ended);
    dialog.close();
    dialog.remove();
    resolve(profile);
  }
  const ended = () => finish(null);
  window.addEventListener("yap:account-changed", ended);
  window.addEventListener("yap:provider-logout", ended);

  document.body.append(dialog);
  render();
  dialog.showModal();

  // The sign-in email suggests a first handle.
  void apiFetch("/api/auth/methods", { cache: "no-store", timeout: 10000 })
    .then(async (response) => {
      if (!response.ok || finished) return;
      const body: { methods: { email: string }[] } = await response.json();
      const email = body.methods[0]?.email;
      if (!email || finished) return;
      suggested = suggest(email.split("@")[0] ?? "");
      if (!handleEdited && !name.value && !handle.value && suggested) {
        handle.value = suggested;
        handleChanged();
      }
    })
    .catch(() => {});
  return promise;
}
