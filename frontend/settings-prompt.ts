// While the live outline is on, debating needs a debate language and transcription consent
// (Decisions 0011 and 0012). The server refuses with this code; the queue, challenge form and
// challenge dialog then link the player to the setting on their account page.

export const DEBATER_SETTINGS_CODE = "debater_settings_required";
export const DEBATER_SETTINGS_URL = "/account#debater-settings";

/** Whether a failed request was refused for missing debater settings. */
export function needsDebaterSettings(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === DEBATER_SETTINGS_CODE
  );
}

/** Shows the server's message followed by a link to the setting. */
export function showSettingsPrompt(element: HTMLElement, message: string) {
  const link = document.createElement("a");
  link.className = "text-link";
  link.href = DEBATER_SETTINGS_URL;
  link.textContent = "Open your account settings";
  element.replaceChildren(`${message} `, link);
}
