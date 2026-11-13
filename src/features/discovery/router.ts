import { publicHomepage } from "./homepage-model.ts";
import { emptyHomeList, homeList } from "./home-list-model.ts";
import { avatarAsset } from "./assets.ts";
import type { createPublicBotRepository } from "../a4/public-bots.ts";
import type { TopicEndorsementView } from "../endorsement/topic-page.ts";
import { digest } from "../a4/engine.ts";
import { Router } from "express";
import type { Request, Response } from "express";
import type { createDiscoveryRepository, DebateStatus } from "./repository.ts";
import {
  renderCoins,
  renderAbout,
  renderAccount,
  renderDebate,
  renderDebates,
  renderHome,
  renderInvalidRequest,
  renderLive,
  renderMatchmaking,
  renderNotFound,
  renderProfile,
  renderQueue,
  renderTopic,
  renderTopics,
} from "./web.ts";
import { renderLanding } from "./landing-web.ts";
import { renderCookies, renderPrivacy, renderTerms } from "./legal-web.ts";
import { html as markup } from "../../platform/html.ts";
import { isTopicCategory } from "./topic-categories.ts";

type Repository = ReturnType<typeof createDiscoveryRepository>;
const statuses = new Set<DebateStatus>([
  "accepted",
  "scheduled",
  "ready",
  "live",
  "ended",
  "replay",
  "void_review",
  "finalized",
  "cancelled",
]);

function text(value: unknown, maximum: number): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maximum) return null;
  return value.trim();
}

function integer(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

type Invalid = (
  response: Response,
  requestPath: string,
  message: string,
) => unknown;

function listParameters(
  request: Request,
  response: Response,
  invalid: Invalid,
) {
  const query = text(request.query.q, 80);
  const limit = integer(request.query.limit, 12, 50);
  const offset = integer(request.query.offset, 0, 10_000);
  if (query === null || limit === null || limit < 1 || offset === null) {
    invalid(response, request.path, "invalid search or pagination parameters");
    return null;
  }
  return { query, limit, offset };
}

function statusParameter(
  request: Request,
  response: Response,
  invalid: Invalid,
) {
  const raw = request.query.status;
  if (raw === undefined || raw === "all") return { status: undefined };
  if (typeof raw !== "string" || !statuses.has(raw as DebateStatus)) {
    invalid(response, request.path, "invalid debate status");
    return null;
  }
  return { status: raw as DebateStatus };
}

// An optional topic category filter: absent or empty lists every category.
function categoryParameter(
  request: Request,
  response: Response,
  invalid: Invalid,
) {
  const raw = request.query.category;
  if (raw === undefined || raw === "") return { category: undefined };
  if (!isTopicCategory(raw)) {
    invalid(response, request.path, "invalid topic category");
    return null;
  }
  return { category: raw };
}

// Sends a server-rendered page with this deployment's page flags. The app's
// not-found page uses it too, so it matches every other page.
export function createPageSender({
  emailFirst = false,
  matchmakingEnabled = false,
  firstRunWelcome = false,
  firstRunTips = false,
}: {
  emailFirst?: boolean;
  matchmakingEnabled?: boolean;
  // The first-run guide's switches: the welcome screen and the tips.
  firstRunWelcome?: boolean;
  firstRunTips?: boolean;
}) {
  const flags = [
    matchmakingEnabled ? " data-matchmaking" : "",
    firstRunWelcome ? " data-first-run-welcome" : "",
    firstRunTips ? " data-first-run-tips" : "",
  ].join("");
  return (response: Response, body: string, status = 200) => {
    const page = emailFirst
      ? body.replace('<html lang="en">', '<html lang="en" data-email-first>')
      : body;
    return response
      .status(status)
      .type("html")
      .send(
        flags
          ? page.replace('<html lang="en"', `<html lang="en"${flags}`)
          : page,
      );
  };
}

function slug(value: string | string[]): string | null {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{2,99}$/.test(value))
    return null;
  return value;
}

export function createDiscoveryRouter({
  discovery,
  a4Enabled = false,
  mediaEnabled = false,
  publicBots,
  topicEndorsement,
  applicationOrigin,
  emailFirst = false,
  liveOutline,
  matchmakingEnabled = false,
  firstRunWelcome = false,
  firstRunTips = false,
  pushKey,
  signedIn = async () => false,
}: {
  discovery: Repository;
  a4Enabled?: boolean;
  mediaEnabled?: boolean;
  // Decision 0012: debate pages carry captions and the AI outline, with the
  // outline's current state embedded so loading it needs no extra request.
  liveOutline?: { snapshot(debateId: string): Promise<unknown> };
  // The old home's sample dataset; the debate list replaced that home, so
  // /home?reference=1 is not found either way (first-run plan PR 7 removes it).
  homepageReferenceEnabled?: boolean;
  publicBots?: ReturnType<typeof createPublicBotRepository>;
  // Decision 0015: the topic page's last-answer figure, its history and each
  // counted debate's final figure. Wired only when Yap Coins are on.
  topicEndorsement?: { topic(topicId: string): Promise<TopicEndorsementView> };
  applicationOrigin: string;
  emailFirst?: boolean;
  // Live topic queue (Decision 0011): pages load the queue module and show its controls.
  matchmakingEnabled?: boolean;
  // The first-run guide's switches, as page flags for the browser.
  firstRunWelcome?: boolean;
  firstRunTips?: boolean;
  // Web push for "Notify me" (first-run build plan PR 10): the VAPID public key, when push is on.
  pushKey?: string;
  // Whether the request carries a valid session; / sends those readers to /home.
  signedIn?: (request: Request) => Promise<boolean>;
}) {
  const router = Router();
  const origin = applicationOrigin.replace(/\/$/, "");
  const html = createPageSender({
    emailFirst,
    matchmakingEnabled,
    firstRunWelcome,
    firstRunTips,
  });
  const invalid: Invalid = (response, requestPath, message) =>
    requestPath.startsWith("/api/")
      ? response.status(400).json({ error: message })
      : html(response, renderInvalidRequest(origin), 400);

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/api/public/topics", async (request, response) => {
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const selected = categoryParameter(request, response, invalid);
    if (!selected) return;
    response.json(
      await discovery.listTopics({
        ...parameters,
        category: selected.category,
      }),
    );
  });
  router.get("/api/public/topics/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const item = key ? await discovery.getTopic(key) : null;
    if (!item)
      return response.status(404).json({ error: "resource not found" });
    return response.json(item);
  });
  router.get("/api/public/debates", async (request, response) => {
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const selected = statusParameter(request, response, invalid);
    if (!selected) return;
    const topicSlug = text(request.query.topic, 80);
    const profileHandle = text(request.query.profile, 40);
    if (topicSlug === null || profileHandle === null) {
      invalid(response, request.path, "invalid filter parameters");
      return;
    }
    response.json(
      await discovery.listDebates({
        ...parameters,
        status: selected.status,
        topicSlug: topicSlug || undefined,
        profileHandle: profileHandle || undefined,
      }),
    );
  });
  router.get("/api/public/debates/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const item = key ? await discovery.getDebate(key) : null;
    if (!item)
      return response.status(404).json({ error: "resource not found" });
    return response.json(item);
  });
  router.get("/api/public/people/:handle", async (request, response) => {
    const key = slug(request.params.handle);
    const item = key ? await discovery.getProfile(key) : null;
    if (!item)
      return response.status(404).json({ error: "resource not found" });
    return response.json(item);
  });

  async function homeData() {
    const topics = await discovery.listTopics({ limit: 12 });
    const [debates, activity] = await Promise.all([
      typeof discovery.listHomepageDebates === "function"
        ? discovery.listHomepageDebates(topics.items.map((t) => t.id))
        : mediaEnabled
          ? discovery.listWatchableDebates()
          : [],
      publicBots ? publicBots.topics(topics.items.map((t) => t.id)) : {},
    ]);
    const visible =
      typeof discovery.listHomepageDebates === "function"
        ? topics.items.filter((t) =>
            debates.some((d) => d.topic.slug === t.slug),
          )
        : topics.items;
    return publicHomepage(visible, debates, activity, avatarAsset);
  }
  router.get("/api/public/homepage", async (request, response) => {
    try {
      const data = await homeData(),
        revision = digest(data);
      return request.query.revision === revision
        ? response.status(204).end()
        : response.json({ ...data, revision });
    } catch {
      return response
        .status(503)
        .json({ error: "Homepage activity is unavailable" });
    }
  });
  router.get("/api/public/debates/:id/activity", async (request, response) => {
    const key = request.params.id;
    if (
      !publicBots ||
      typeof key !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        key,
      )
    )
      return response.status(404).json({ error: "Debate not found" });
    const data = await publicBots.debate(key);
    return data
      ? response.json(data)
      : response.status(404).json({ error: "Debate not found" });
  });
  // Public pages for search engines; demo listings are left out. Profiles are
  // listed only once their owner has appeared in a public debate.
  router.get("/sitemap.xml", async (_request, response) => {
    const { topics, debates, profiles } = await discovery.listSitemap();
    const paths = [
      "/",
      "/home",
      "/live",
      "/debates",
      "/topics",
      "/about",
      ...topics.map((key) => `/topics/${encodeURIComponent(key)}`),
      ...debates.map((key) => `/debates/${encodeURIComponent(key)}`),
      ...profiles.map((key) => `/people/${encodeURIComponent(key)}`),
    ];
    return response
      .set("Cache-Control", "public, max-age=3600")
      .type("application/xml")
      .send(
        markup`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((page) => markup`<url><loc>${origin}${page}</loc></url>`)}</urlset>\n`.toString(),
      );
  });
  // The landing page (docs/landing-page.md). Signed-in readers go to /home; a
  // session lookup that fails leaves the reader on the landing page.
  router.get("/", async (request, response) => {
    response.vary("Cookie");
    const member = await signedIn(request).catch(() => false);
    if (member) return response.redirect(303, "/home");
    return html(response, renderLanding(origin));
  });
  // The home's lists (first-run plan PR 6) from the public debate reads:
  // what is live, scheduled, and finished with a recording. homeList keeps
  // only debates starting within a day and puts replays still taking answers
  // apart from finished ones.
  async function homeListData() {
    const read = (status: DebateStatus, limit: number) =>
      discovery.listDebates({ status, limit }).then((list) => list.items);
    const [live, scheduled, ready, replays, finalized] = await Promise.all([
      read("live", 12),
      read("scheduled", 50),
      read("ready", 12),
      read("replay", 24),
      read("finalized", 12),
    ]);
    return homeList(
      {
        live,
        scheduled: [...scheduled, ...ready],
        ended: [...replays, ...finalized],
      },
      new Date(),
      { matchmaking: matchmakingEnabled, avatarUrl: avatarAsset },
    );
  }
  router.get("/home", async (request, response) => {
    // The sample dataset showed the old trending home, which the debate list
    // replaced; its flag no longer changes this page.
    if (request.query.reference !== undefined)
      return html(response, renderNotFound(origin), 404);
    try {
      return html(
        response,
        renderHome(origin, await homeListData(), emailFirst),
      );
    } catch {
      return html(
        response,
        renderHome(origin, emptyHomeList(new Date(), false), emailFirst),
        503,
      );
    }
  });
  router.get("/live", async (_request, response) => {
    const [debates, topics] = await Promise.all([
      mediaEnabled ? discovery.listWatchableDebates() : [],
      discovery.listTopics({ limit: 3 }),
    ]);
    return html(response, renderLive(origin, debates, topics));
  });
  // Founder D4: Bots mode appears on /coins only while A4 is enabled.
  router.get("/coins", (_request, response) =>
    html(response, renderCoins(origin, a4Enabled)),
  );
  router.get("/match", (_request, response) =>
    html(response, renderMatchmaking(origin, matchmakingEnabled)),
  );
  router.get("/debates", async (request, response) => {
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const selected = statusParameter(request, response, invalid);
    if (!selected) return;
    const list = await discovery.listDebates({
      ...parameters,
      status: selected.status,
    });
    return html(
      response,
      renderDebates(origin, list, parameters.query, selected.status ?? "all"),
    );
  });
  // Explore's topics, with the API's category filter for the category chips.
  router.get("/topics", async (request, response) => {
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const selected = categoryParameter(request, response, invalid);
    if (!selected) return;
    return html(
      response,
      renderTopics(
        origin,
        await discovery.listTopics(
          selected.category
            ? { ...parameters, category: selected.category }
            : parameters,
        ),
        parameters.query,
        selected.category,
      ),
    );
  });
  // The Queue tab: every open question with its two sides (first-run plan PR 3).
  router.get("/queue", async (request, response) => {
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const selected = categoryParameter(request, response, invalid);
    if (!selected) return;
    return html(
      response,
      renderQueue(
        origin,
        await discovery.listTopics({
          ...parameters,
          query: "",
          category: selected.category,
        }),
        matchmakingEnabled,
        selected.category ?? null,
      ),
    );
  });
  router.get("/topics/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const topic = key ? await discovery.getTopic(key) : null;
    if (!topic) return html(response, renderNotFound(origin), 404);
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    // The topic's figure is optional: without Yap Coins, or when it cannot
    // be read, the page shows its debates alone.
    const [debates, endorsement] = await Promise.all([
      discovery.listDebates({
        topicSlug: key!,
        limit: parameters.limit,
        offset: parameters.offset,
      }),
      topicEndorsement
        ? topicEndorsement.topic(topic.id).catch(() => null)
        : null,
    ]);
    return html(
      response,
      renderTopic(origin, topic, debates, matchmakingEnabled, endorsement),
    );
  });
  router.get("/debates/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const debate = key ? await discovery.getDebate(key) : null;
    return debate
      ? html(
          response,
          renderDebate(
            origin,
            debate,
            a4Enabled,
            publicBots ? await publicBots.debate(debate.id) : undefined,
            matchmakingEnabled,
            liveOutline
              ? { state: await liveOutline.snapshot(debate.id) }
              : undefined,
            pushKey,
          ),
        )
      : html(response, renderNotFound(origin), 404);
  });
  router.get("/people/:handle", async (request, response) => {
    const key = slug(request.params.handle);
    const profile = key ? await discovery.getProfile(key) : null;
    if (!profile) return html(response, renderNotFound(origin), 404);
    const parameters = listParameters(request, response, invalid);
    if (!parameters) return;
    const debates = await discovery.listDebates({
      profileHandle: key!,
      limit: parameters.limit,
      offset: parameters.offset,
    });
    return html(response, renderProfile(origin, profile, debates));
  });
  router.get("/about", (_request, response) =>
    html(response, renderAbout(origin)),
  );
  // Production runbook step 9.1; Google's sign-in branding links to both.
  router.get("/privacy", (_request, response) =>
    html(response, renderPrivacy(origin)),
  );
  router.get("/terms", (_request, response) =>
    html(response, renderTerms(origin)),
  );
  router.get("/cookies", (_request, response) =>
    html(response, renderCookies(origin)),
  );
  router.get("/account", (_request, response) =>
    html(response, renderAccount(origin, Boolean(liveOutline))),
  );
  return router;
}
