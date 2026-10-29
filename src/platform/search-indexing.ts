import { Router } from "express";

// Only the production web service (PRODUCTION_SERVICE=true) belongs in search
// results. Every other deployment, staging and local development included,
// sends X-Robots-Tag: noindex on every response and disallows all crawling.
// Production keeps crawlers out of /api/: its JSON is not a page, and each
// /api/auth/login request starts a sign-in.
const productionRobots = "User-agent: *\nDisallow: /api/\n";
const blockedRobots = "User-agent: *\nDisallow: /\n";

export function createSearchIndexing({
  productionService,
}: {
  productionService: boolean;
}) {
  const router = Router();
  if (!productionService)
    router.use((_request, response, next) => {
      response.set("X-Robots-Tag", "noindex");
      next();
    });
  router.get("/robots.txt", (_request, response) => {
    response
      .type("text/plain")
      .set("Cache-Control", "public, max-age=3600")
      .send(productionService ? productionRobots : blockedRobots);
  });
  return router;
}
