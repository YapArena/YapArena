import { publicHomepage } from "./homepage-model.ts";
import { referenceHomepage } from "./homepage-reference.ts";
import type { createPublicBotRepository } from "../a4/public-bots.ts";
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
  renderLive,
  renderMatchmaking,
  renderNotFound,
  renderProfile,
  renderTopic,
  renderTopics,
} from "./web.ts";
import { renderLanding } from "./landing-web.ts";

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

function listParameters(request: Request, response: Response) {
  const query = text(request.query.q, 80);
  const limit = integer(request.query.limit, 12, 50);
  const offset = integer(request.query.offset, 0, 10_000);
  if (query === null || limit === null || limit < 1 || offset === null) {
    invalid(response, request.path, "invalid search or pagination parameters");
    return null;
  }
  return { query, limit, offset };
}

function statusParameter(request: Request, response: Response) {
  const raw = request.query.status;
  if (raw === undefined || raw === "all") return { status: undefined };
  if (typeof raw !== "string" || !statuses.has(raw as DebateStatus)) {
    invalid(response, request.path, "invalid debate status");
    return null;
  }
  return { status: raw as DebateStatus };
}

function invalid(response: Response, requestPath: string, message: string) {
  return requestPath.startsWith("/api/")
    ? response.status(400).json({ error: message })
    : response
        .status(400)
        .type("html")
        .send(
          `<h1>Invalid request</h1><p>${message}</p><a href="/debates">Browse debates</a>`,
        );
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
  homepageReferenceEnabled = false,
  publicBots,
  applicationOrigin,
  emailFirst = false,
  liveOutline,
  matchmakingEnabled = false,
  signedIn = async () => false,
}: {
  discovery: Repository;
  a4Enabled?: boolean;
  mediaEnabled?: boolean;
  // Decision 0012: debate pages carry captions and the AI outline, with the
  // outline's current state embedded so loading it needs no extra request.
  liveOutline?: { snapshot(debateId: string): Promise<unknown> };
  homepageReferenceEnabled?: boolean;
  publicBots?: ReturnType<typeof createPublicBotRepository>;
  applicationOrigin: string;
  emailFirst?: boolean;
  // Live topic queue (Decision 0011): pages load the queue module and show its controls.
  matchmakingEnabled?: boolean;
  // Whether the request carries a valid session; / sends those readers to /home.
  signedIn?: (request: Request) => Promise<boolean>;
}) {
  const router = Router();
  const origin = applicationOrigin.replace(/\/$/, "");
  function html(response: Response, body: string, status = 200) {
    const page = emailFirst
      ? body.replace('<html lang="en">', '<html lang="en" data-email-first>')
      : body;
    return response
      .status(status)
      .type("html")
      .send(
        matchmakingEnabled
          ? page.replace('<html lang="en"', '<html lang="en" data-matchmaking')
          : page,
      );
  }

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/api/public/topics", async (request, response) => {
    const parameters = listParameters(request, response);
    if (!parameters) return;
    response.json(await discovery.listTopics(parameters));
  });
  router.get("/api/public/topics/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const item = key ? await discovery.getTopic(key) : null;
    if (!item)
      return response.status(404).json({ error: "resource not found" });
    return response.json(item);
  });
  router.get("/api/public/debates", async (request, response) => {
    const parameters = listParameters(request, response);
    if (!parameters) return;
    const selected = statusParameter(request, response);
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
    return publicHomepage(visible, debates, activity);
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
  // The landing page (docs/landing-page.md). Signed-in readers go to /home; a
  // session lookup that fails leaves the reader on the landing page.
  router.get("/", async (request, response) => {
    response.vary("Cookie");
    const member = await signedIn(request).catch(() => false);
    if (member) return response.redirect(303, "/home");
    return html(response, renderLanding(origin));
  });
  router.get("/home", async (request, response) => {
    if (request.query.reference !== undefined) {
      if (!homepageReferenceEnabled || request.query.reference !== "1")
        return html(response, renderNotFound(origin), 404);
      return html(response, renderHome(origin, referenceHomepage()));
    }
    try {
      return html(response, renderHome(origin, await homeData(), emailFirst));
    } catch {
      return html(
        response,
        renderHome(
          origin,
          { ...publicHomepage([], []), available: false },
          emailFirst,
        ),
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
    const parameters = listParameters(request, response);
    if (!parameters) return;
    const selected = statusParameter(request, response);
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
  router.get("/topics", async (request, response) => {
    const parameters = listParameters(request, response);
    if (!parameters) return;
    return html(
      response,
      renderTopics(
        origin,
        await discovery.listTopics(parameters),
        parameters.query,
      ),
    );
  });
  router.get("/topics/:slug", async (request, response) => {
    const key = slug(request.params.slug);
    const topic = key ? await discovery.getTopic(key) : null;
    if (!topic) return html(response, renderNotFound(origin), 404);
    const parameters = listParameters(request, response);
    if (!parameters) return;
    const debates = await discovery.listDebates({
      topicSlug: key!,
      limit: parameters.limit,
      offset: parameters.offset,
    });
    return html(
      response,
      renderTopic(origin, topic, debates, matchmakingEnabled),
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
          ),
        )
      : html(response, renderNotFound(origin), 404);
  });
  router.get("/people/:handle", async (request, response) => {
    const key = slug(request.params.handle);
    const profile = key ? await discovery.getProfile(key) : null;
    if (!profile) return html(response, renderNotFound(origin), 404);
    const parameters = listParameters(request, response);
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
  router.get("/account", (_request, response) =>
    html(response, renderAccount(origin, Boolean(liveOutline))),
  );
  return router;
}
