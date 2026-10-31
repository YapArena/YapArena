import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/platform/config.js";
import { createLogger } from "../dist/platform/logger.js";

describe("search indexing", () => {
  const logger = createLogger({ enabled: false });
  const messages = { list: mock.fn(async () => []) };
  const sessions = {
    findUserByTokenHash: async () => null,
    deleteByTokenHash: async () => false,
  };
  const database = { query: async () => ({ rows: [] }) };
  // Staging runs NODE_ENV=production without PRODUCTION_SERVICE.
  const staging = createApp({
    messages,
    sessions,
    logger,
    database,
    environment: "production",
    applicationOrigin: "https://yaparena-staging-web.onrender.com",
  });
  const production = createApp({
    messages,
    sessions,
    logger,
    database,
    environment: "production",
    productionService: true,
    applicationOrigin: "https://yaparena.com",
  });

  it("asks search engines not to index any response outside production", async () => {
    for (const app of [staging, createApp({ messages, sessions, logger })]) {
      for (const [path, status] of [
        ["/health", 200],
        ["/robots.txt", 200],
        ["/no-such-page", 404],
        ["/api/messages", 401],
      ]) {
        const response = await request(app).get(path);
        assert.equal(response.status, status, path);
        assert.equal(response.headers["x-robots-tag"], "noindex", path);
      }
    }
    // Readiness without a database is a 503, and it is marked too.
    const unready = await request(
      createApp({ messages, sessions, logger }),
    ).get("/ready");
    assert.equal(unready.status, 503);
    assert.equal(unready.headers["x-robots-tag"], "noindex");
  });

  it("marks rate-limited responses outside production", async () => {
    const limited = createApp({ messages, sessions, logger, apiRateLimit: 1 });
    assert.equal((await request(limited).get("/health")).status, 200);
    const refused = await request(limited).get("/health");
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["x-robots-tag"], "noindex");
  });

  it("disallows all crawling outside production", async () => {
    const response = await request(staging).get("/robots.txt");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/plain/);
    assert.equal(response.text, "User-agent: *\nDisallow: /\n");
  });

  it("lets search engines crawl production pages but not its API", async () => {
    const robots = await request(production).get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.headers["content-type"], /^text\/plain/);
    assert.equal(robots.headers["cache-control"], "public, max-age=3600");
    assert.equal(
      robots.text,
      "User-agent: *\nDisallow: /api/\nSitemap: https://yaparena.com/sitemap.xml\n",
    );
    assert.equal(robots.headers["x-robots-tag"], undefined);
    for (const path of ["/health", "/no-such-page"]) {
      const response = await request(production).get(path);
      assert.equal(response.headers["x-robots-tag"], undefined, path);
    }
  });

  it("names the sitemap only when production knows its origin", async () => {
    const trailingSlash = createApp({
      messages,
      sessions,
      logger,
      productionService: true,
      applicationOrigin: "https://yaparena.com/",
    });
    assert.equal(
      (await request(trailingSlash).get("/robots.txt")).text,
      "User-agent: *\nDisallow: /api/\nSitemap: https://yaparena.com/sitemap.xml\n",
    );
    const noOrigin = createApp({
      messages,
      sessions,
      logger,
      productionService: true,
    });
    assert.equal(
      (await request(noOrigin).get("/robots.txt")).text,
      "User-agent: *\nDisallow: /api/\n",
    );
  });

  it("serves robots.txt to HEAD requests", async () => {
    const response = await request(staging).head("/robots.txt");
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-robots-tag"], "noindex");
  });

  it("treats only PRODUCTION_SERVICE=true as the production service", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://runtime:secret@localhost/yaparena",
      APP_ORIGIN: "https://yaparena.com",
    };
    assert.equal(loadConfig(base).productionService, false);
    assert.equal(
      loadConfig({ ...base, PRODUCTION_SERVICE: "true" }).productionService,
      true,
    );
  });
});
