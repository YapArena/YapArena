import { Router } from "express";
import {
  parseDebaterSettings,
  type createDebaterSettings,
} from "./debater-settings.ts";

// GET/PUT /api/me/debater-settings. Mounted behind authentication and the
// application's same-origin write protection. The matchmaking queue screen
// uses the same API.
export function createDebaterSettingsRouter(
  settings: Pick<ReturnType<typeof createDebaterSettings>, "get" | "save">,
) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store").set("Vary", "Cookie");
    next();
  });
  router.get("/", async (request, response) =>
    response.json(await settings.get(request.user!.id)),
  );
  router.put("/", async (request, response) => {
    const input = parseDebaterSettings(request.body);
    if (!input)
      return response.status(400).json({
        error:
          'Send language ("fr" or "en") and consent (true or false), and nothing else.',
      });
    return response.json(await settings.save(request.user!.id, input));
  });
  return router;
}
