// Every page's entry for the Yap Coins results notice (Decision 0013,
// interface 10). Signed-out visitors get only this shell: it reuses the
// page's shared sign-in check and makes no results request and no stream.
// The notice itself loads once someone is signed in.
import { sessionStore } from "./lib/session.js";

type Notices = typeof import("./results-notice-view.js");
const store = sessionStore();
let generation = 0;
let notices: Promise<Notices> | null = null;

async function begin() {
  const current = ++generation;
  if (notices) (await notices).stop();
  const user = await store.me().catch(() => null);
  if (current !== generation || !user) return;
  notices ??= import("./results-notice-view.js");
  const view = await notices;
  if (current === generation) view.start(user.id);
}

window.addEventListener("yap:account-changed", () => void begin());
window.addEventListener("yap:provider-logout", () => {
  generation++;
  void notices?.then((view) => view.stop());
});
void begin();
