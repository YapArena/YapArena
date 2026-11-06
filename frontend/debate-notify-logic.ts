// "Notify me" on a scheduled debate (first-run build plan PR 9): the button's words and the
// server request, kept apart from the DOM so they can be tested.

export const notifyEndpoint = (debateId: string) =>
  `/api/matching/events/${encodeURIComponent(debateId)}/notify`;

export const notifyLabel = (notifying: boolean) =>
  notifying ? "Notifying you" : "Notify me";

// Shown under the button after a change.
export const notifyMessage = (notifying: boolean) =>
  notifying
    ? "You’ll get a notice in your notifications a few minutes before it starts."
    : "You won’t get a notice for this debate.";

export const notifyFailure =
  "Couldn’t update. Check your connection and try again.";

// The server's reason when it refuses, such as "This debate starts in a few minutes."
export function notifyError(body: unknown) {
  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string" &&
    body.error
    ? body.error
    : notifyFailure;
}

// Milliseconds until the debate's start, when the button goes away; null once it has passed.
export function untilStart(startsAt: string | undefined, now: number) {
  const start = Date.parse(startsAt ?? "");
  return Number.isFinite(start) && start > now ? start - now : null;
}
