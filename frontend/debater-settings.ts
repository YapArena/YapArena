import { api, apiFetch } from "./lib/api.js";

// Decision 0012: the account's debate language and its consent to
// transcription and the public AI outline. The card stays hidden unless the
// live outline is enabled (the API answers 404 otherwise) and the visitor is
// signed in (401).

interface DebaterSettings {
  language: "fr" | "en" | null;
  consented: boolean;
}

const card = document.querySelector<HTMLElement>("#debater-settings");
const form = document.querySelector<HTMLFormElement>("#debater-settings-form");
if (card && form) {
  const language = form.querySelector<HTMLSelectElement>("#debater-language")!;
  const consent = form.querySelector<HTMLInputElement>("#debater-consent")!;
  const status = form.querySelector<HTMLElement>("#debater-save-status")!;
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const show = (settings: DebaterSettings) => {
    language.value = settings.language ?? "";
    consent.checked = settings.consented;
    card.hidden = false;
  };
  const describe = (settings: DebaterSettings) =>
    settings.consented
      ? "Saved. You're ready to debate."
      : "Saved. Agree to transcription before you debate.";
  void (async () => {
    const response = await apiFetch("/api/me/debater-settings").catch(
      () => undefined,
    );
    if (response?.ok) show((await response.json()) as DebaterSettings);
  })();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (language.value !== "fr" && language.value !== "en") {
      language.setAttribute("aria-invalid", "true");
      status.textContent = "Choose the language you debate in.";
      language.focus();
      return;
    }
    language.removeAttribute("aria-invalid");
    save.disabled = true;
    status.textContent = "Saving…";
    void api<DebaterSettings>("/api/me/debater-settings", {
      method: "PUT",
      json: { language: language.value, consent: consent.checked },
    })
      .then((settings) => {
        show(settings);
        status.textContent = describe(settings);
      })
      .catch((error: unknown) => {
        status.textContent =
          error instanceof Error ? error.message : "Couldn't save. Try again.";
      })
      .finally(() => {
        save.disabled = false;
      });
  });
}
