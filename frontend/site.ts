interface HeaderBalance {
  available: string;
  reserved: string;
  scope: string;
}
interface FollowDetail {
  type: string;
  slug: string;
  following: boolean;
}
declare global {
  interface Window {
    yapFollows: {
      initialize(scope?: ParentNode): void;
      read(type: string, slug: string): Promise<boolean>;
    };
  }
  interface WindowEventMap {
    "yap:balance": CustomEvent<HeaderBalance | null>;
    // A Yap Coins balance changed; the header reloads its balance.
    "yap:coins-changed": Event;
    // The debate replay's position, for the betting panel and the outline.
    "yap:playback": CustomEvent<{
      debateId: string;
      positionSeconds: number;
      playing: boolean;
    }>;
    "yap:follow": CustomEvent<FollowDetail>;
  }
}
/* global window, document */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// One shared follow controller handles initial and progressively inserted controls.
const followReads = new Map<string, Promise<boolean>>();
const initializedFollows = new WeakMap<
  Element,
  { set(value: boolean): void }
>();
const refreshingFollows = new WeakSet<HTMLButtonElement>();
let followAccountEpoch = 0;
const followKey = (type: string, slug: string) => `${type}/${slug}`;
function readFollow(type: string, slug: string) {
  const key = followKey(type, slug);
  if (!followReads.has(key)) {
    const read = fetch(`/api/me/follows/${type}/${encodeURIComponent(slug)}`, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw Object.assign(new Error("Follow status unavailable"), {
            status: response.status,
          });
        return Boolean(
          ((await response.json()) as { following: boolean }).following,
        );
      })
      .catch((error: unknown) => {
        followReads.delete(key);
        throw error;
      });
    followReads.set(key, read);
  }
  return followReads.get(key)!;
}
function initializeFollows(scope: ParentNode = document) {
  for (const button of scope.querySelectorAll<HTMLButtonElement>(
    ".follow-button",
  )) {
    if (initializedFollows.has(button)) continue;
    const type = button.dataset.followType!,
      slug = button.dataset.followSlug!;
    const endpoint = `/api/me/follows/${type}/${encodeURIComponent(slug)}`;
    const message = button.nextElementSibling!;
    let following = false;
    function label() {
      button.setAttribute("aria-pressed", String(following));
      button.textContent = button.dataset.followCompact
        ? following
          ? "✓ Following"
          : "+ Follow"
        : `${following ? "Following" : "Follow"} ${type === "topics" ? "topic" : "person"}`;
    }
    const readEpoch = followAccountEpoch;
    readFollow(type, slug)
      .then((value) => {
        if (readEpoch !== followAccountEpoch) return;
        following = value;
        label();
      })
      .catch(() => {});
    initializedFollows.set(button, {
      set(value) {
        following = value;
        label();
      },
    });
    button.addEventListener("click", async () => {
      const epoch = followAccountEpoch;
      button.disabled = true;
      try {
        const response = await fetch(endpoint, {
          method: following ? "DELETE" : "PUT",
          credentials: "same-origin",
        });
        if (epoch !== followAccountEpoch) return;
        if (response.status === 401) {
          const returnTo =
            window.location.pathname +
            window.location.search +
            window.location.hash;
          if (
            window.dispatchEvent(
              new CustomEvent("yap:request-auth", {
                cancelable: true,
                detail: { returnTo, source: button },
              }),
            )
          )
            window.location.assign(
              `/account?next=${encodeURIComponent(returnTo)}`,
            );
          return;
        }
        if (!response.ok) {
          const data: { error?: string } = await response.json();
          throw new Error(data.error || "Could not update follow.");
        }
        following = !following;
        followReads.set(followKey(type, slug), Promise.resolve(following));
        label();
        message.textContent = following
          ? "Added to your follows."
          : "Removed from your follows.";
        window.dispatchEvent(
          new CustomEvent("yap:follow", { detail: { type, slug, following } }),
        );
      } catch (error) {
        if (epoch === followAccountEpoch)
          message.textContent = (error as Error).message;
      } finally {
        button.disabled = false;
        if (epoch !== followAccountEpoch)
          refreshFollowButton(button, followAccountEpoch);
      }
    });
  }
}
window.addEventListener("yap:follow", (event) => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".follow-button",
  )) {
    if (
      button.dataset.followType === event.detail.type &&
      button.dataset.followSlug === event.detail.slug
    )
      initializedFollows.get(button)?.set(event.detail.following);
  }
});
window.yapFollows = { initialize: initializeFollows, read: readFollow };
initializeFollows();
function refreshFollowButton(button: HTMLButtonElement, epoch: number) {
  if (button.disabled && !refreshingFollows.has(button)) return;
  refreshingFollows.add(button);
  button.disabled = true;
  void readFollow(button.dataset.followType!, button.dataset.followSlug!)
    .then((following) => {
      if (epoch === followAccountEpoch)
        initializedFollows.get(button)?.set(following);
    })
    .catch(() => {})
    .finally(() => {
      if (epoch === followAccountEpoch) {
        refreshingFollows.delete(button);
        button.disabled = false;
      }
    });
}
window.addEventListener("yap:account-changed", () => {
  const epoch = ++followAccountEpoch;
  followReads.clear();
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".follow-button",
  )) {
    initializedFollows.get(button)?.set(false);
    if (button.nextElementSibling) button.nextElementSibling.textContent = "";
    refreshFollowButton(button, epoch);
  }
});

// Retain the current round/action when this page's sign-in link returns here.
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>(
    'a[href^="/account?next="]',
  );
  if (!link) return;
  const account = new URL(link.href, window.location.origin);
  const next = account.searchParams.get("next");
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return;
  const destination = new URL(next, window.location.origin);
  if (
    destination.origin === window.location.origin &&
    destination.pathname === window.location.pathname
  ) {
    account.searchParams.set(
      "next",
      window.location.pathname + window.location.search + window.location.hash,
    );
    link.href = account.pathname + account.search;
  }
});
