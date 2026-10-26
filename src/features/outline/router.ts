import { Router, type RequestHandler } from "express";
import { createSharedRead } from "../../platform/shared-read.ts";
import type {
  OutlineCatchUp,
  OutlineSnapshot,
  createOutlineRepository,
} from "./repository.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const item = /^t[1-9][0-9]{0,4}a[1-9][0-9]{0,2}(p[1-9][0-9]{0,2})?$/;
type Outlines = Pick<
  ReturnType<typeof createOutlineRepository>,
  "isPublic" | "snapshot" | "since" | "flag"
>;

// Decision 0012. GET /api/public/debates/:id/outline?after=<version> returns
// the versions after `after` (at most 50) or a snapshot, with an ETag naming
// the head version. Browsers call it only to catch up on a gap or when LiveKit
// is unavailable; live versions reach them over LiveKit.
export function createOutlineRouter(outlines: Outlines) {
  const router = Router();
  const read = createSharedRead<OutlineSnapshot | OutlineCatchUp | null>();
  router.get("/api/public/debates/:id/outline", async (request, response) => {
    const id = request.params.id;
    const after = request.query.after;
    response.set("Cache-Control", "no-cache");
    if (
      !uuid.test(id) ||
      (after !== undefined &&
        (typeof after !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(after)))
    )
      return response.status(404).json({ error: "outline not found" });
    const value = await read(`${id}:${after ?? ""}`, async () =>
      (await outlines.isPublic(id))
        ? after === undefined
          ? outlines.snapshot(id)
          : outlines.since(id, Number(after))
        : null,
    );
    if (!value)
      return response.status(404).json({ error: "outline not found" });
    const etag = `"o${value.version}-${value.kind}"`;
    response.set("ETag", etag);
    if (request.get("If-None-Match") === etag)
      return response.status(304).end();
    return response.json(value);
  });
  return router;
}

// POST /api/debates/:id/outline/flags: a debater marks an item of one of their
// own turns as a mistake. Behind authentication and same-origin protection.
export function createOutlineFlagRouter(
  outlines: Pick<Outlines, "flag">,
  requireAuth: RequestHandler,
) {
  const router = Router();
  router.post(
    "/api/debates/:id/outline/flags",
    requireAuth,
    async (request, response) => {
      response.set("Cache-Control", "no-store");
      const id = request.params.id;
      const body: unknown = request.body;
      const fields =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      if (
        typeof id !== "string" ||
        !uuid.test(id) ||
        !fields ||
        Object.keys(fields).some(
          (key) => !["turnNumber", "itemId", "note"].includes(key),
        ) ||
        !Number.isSafeInteger(fields.turnNumber) ||
        (fields.turnNumber as number) < 1 ||
        typeof fields.itemId !== "string" ||
        !item.test(fields.itemId) ||
        (fields.note !== undefined &&
          (typeof fields.note !== "string" ||
            !fields.note.trim() ||
            fields.note.length > 280))
      )
        return response.status(400).json({ error: "invalid outline flag" });
      const flagged = await outlines.flag({
        debateId: id,
        userId: request.user!.id,
        turnNumber: fields.turnNumber as number,
        itemId: fields.itemId,
        note: typeof fields.note === "string" ? fields.note.trim() : null,
      });
      return flagged
        ? response.status(201).json({ flagged: true, side: flagged.side })
        : response.status(404).json({
            error: "only the debater who spoke this turn can flag it",
          });
    },
  );
  return router;
}
