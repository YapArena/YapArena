// The in-app Yap Coins results notice (Decision 0013, interface 10), loaded
// by results-notice.ts only for a signed-in viewer. When the viewer's
// positions are revealed or voided, a dismissible notice lists each debate's
// result and links to it. It checks when started, when the tab regains focus,
// and on the personal stream's "results" event, which carries no data. A
// last-seen time per account is kept on this device.
import { api, apiErrorStatus } from "./lib/api.js";
import { userStream } from "./lib/user-stream.js";
import {
  groupLine,
  newestRevealed,
  noteText,
  noticeGroups,
  sinceFor,
  type ResultsResponse,
} from "./results-notice-model.js";

// The notice names at most this many debates and counts the rest.
const shownDebates = 3;
let userId: string | null = null;
let generation = 0;
let busy = false;
let again = false;
let unavailable = false;
let stopStream: (() => void) | null = null;
let pending: number | undefined;
let notice: HTMLElement | null = null;
// The newest reveal this page has read; undefined before the first read.
let newestRead: string | null | undefined;

const seenKey = (id: string) => `yaparena-results-seen:${id}`;
// Per-device convenience only; without storage the notice uses a week back.
function stored(name: string) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}
function remember(name: string, value: string) {
  try {
    localStorage.setItem(name, value);
  } catch {
    // Private windows may refuse storage; the notice still works this page.
  }
}

function close() {
  notice?.remove();
  notice = null;
}
function show(results: ResultsResponse["results"], account: string) {
  const seen = stored(seenKey(account));
  const groups = noticeGroups(results, seen);
  const newest = newestRevealed(results);
  if (!groups.length || !newest) return;
  // Seen once the viewer dismisses the notice or opens a debate from it.
  const acknowledge = () => {
    if (account === userId) remember(seenKey(account), newest);
    close();
  };
  close();
  const box = document.createElement("aside");
  box.className = "results-notice";
  box.setAttribute("role", "status");
  box.setAttribute("aria-labelledby", "results-notice-title");
  const title = document.createElement("h2");
  title.id = "results-notice-title";
  title.textContent = "Your Yap Coins results are in";
  const list = document.createElement("ul");
  for (const group of groups.slice(0, shownDebates)) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/debates/${encodeURIComponent(group.slug)}`;
    link.textContent = groupLine(group);
    link.addEventListener("click", acknowledge);
    item.append(link);
    list.append(item);
  }
  const note = document.createElement("p");
  note.textContent = noteText(groups.length - shownDebates);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", acknowledge);
  box.append(title, list, note, dismiss);
  document.body.append(box);
  notice = box;
}

// A stream event during a read asks for one more read afterwards; focus and
// visibility checks during a read are already covered by it.
async function check(queue = false) {
  const account = userId;
  const current = generation;
  if (!account || unavailable || document.hidden) return;
  if (busy) {
    if (queue) again = true;
    return;
  }
  busy = true;
  try {
    const since = sinceFor(stored(seenKey(account)), Date.now());
    const value = await api<ResultsResponse>(
      `/api/coin-sandbox/results?since=${encodeURIComponent(since)}`,
      { cache: "no-store", timeout: 10000 },
    );
    if (current !== generation) return;
    show(value.results, account);
    // A reveal after this page loaded changes the balance everywhere on it.
    const newest = newestRevealed(value.results);
    if (newestRead !== undefined && newest && newest !== newestRead)
      window.dispatchEvent(new Event("yap:coins-changed"));
    newestRead = newest ?? newestRead ?? null;
    // Listen for reveals only once Yap Coins answered for this account.
    stopStream ??= userStream().on("results", soon);
  } catch (error) {
    // Signed out, or Yap Coins off on this site: stop asking on this page.
    if ([401, 403, 404].includes(apiErrorStatus(error) ?? 0)) {
      unavailable = true;
      stopStream?.();
      stopStream = null;
    }
  } finally {
    busy = false;
    if (again) {
      again = false;
      void check(true);
    }
  }
}
// Everyone in a debate hears its reveal at once; spread the reads.
function soon() {
  window.clearTimeout(pending);
  pending = window.setTimeout(() => void check(true), Math.random() * 3000);
}

/** Stops notices for the previous account and removes any notice shown. */
export function stop() {
  generation++;
  userId = null;
  newestRead = undefined;
  unavailable = false;
  window.clearTimeout(pending);
  stopStream?.();
  stopStream = null;
  close();
}
/** Starts notices for a signed-in account. */
export function start(account: string) {
  stop();
  userId = account;
  void check();
}

window.addEventListener("focus", () => void check());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void check();
});
