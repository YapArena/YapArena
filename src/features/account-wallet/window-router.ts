import { Router } from "express";
import { createSharedRead } from "../../platform/shared-read.ts";
import type { createCoinDebateSandbox } from "./debate-sandbox.ts";

type PublicWindows = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof createCoinDebateSandbox>["publicWindows"]>
  >
>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Decision 0012: anonymous read of a debate's turn windows (timing and state
// only), re-read on the 'window' room signal. Overlapping reads of one debate
// share a single query, so a signal reaching every viewer costs one read.
export function createTurnWindowRouter(
  debates: Pick<ReturnType<typeof createCoinDebateSandbox>, "publicWindows">,
) {
  const router = Router();
  const read = createSharedRead<PublicWindows | null>();
  router.get("/api/public/debates/:id/windows", async (request, response) => {
    const id = request.params.id;
    response.set("Cache-Control", "no-store");
    if (!uuid.test(id))
      return response.status(404).json({ error: "debate not found" });
    const windows = await read(id, () => debates.publicWindows(id));
    return windows
      ? response.json(windows)
      : response.status(404).json({ error: "debate not found" });
  });
  return router;
}
