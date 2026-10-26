import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  applyCatchUp,
  applyVersion,
  emptyView,
  fromSnapshot,
  parseOutlineMessage,
} from "../public/outline-state.js";
import {
  createOutlineFlagRouter,
  createOutlineRouter,
} from "../dist/features/outline/router.js";

// Decision 0012: the page's copy of the outline and the public outline API.

const span = { startMs: 0, endMs: 1000 };
const version = (n, turnNumber, edits, side = "A", language = "fr") => ({
  version: n,
  turnNumber,
  side,
  language,
  edits,
});
const addArgument = (turn, index, label) => ({
  op: "add_argument",
  id: `t${turn}a${index}`,
  label,
  span,
});

describe("page outline state", () => {
  it("applies only the next version and reports what is new", () => {
    let view = emptyView;
    const first = applyVersion(view, version(1, 1, [addArgument(1, 1, "Un")]));
    assert.equal(first.kind, "applied");
    assert.deepEqual(first.added, ["Un"]);
    view = first.view;
    assert.equal(applyVersion(view, version(1, 1, [])).kind, "ignored");
    assert.equal(applyVersion(view, version(3, 1, [])).kind, "gap");
    assert.equal(
      applyVersion(
        view,
        version(2, 1, [{ op: "update_point", id: "t1a1p9", text: "x", span }]),
      ).kind,
      "gap",
      "an edit the reducer refuses means this copy differs from the server",
    );
    const changed = applyVersion(
      view,
      version(2, 1, [
        { op: "update_argument", id: "t1a1", label: "Un, précisé", span },
      ]),
    );
    assert.deepEqual(changed.added, [], "a reworded argument is not new");
    view = changed.view;
    // A new turn moves the finished one to the earlier turns.
    const next = applyVersion(
      view,
      version(3, 2, [addArgument(2, 1, "Two")], "B", "en"),
    );
    assert.equal(next.view.current.turnNumber, 2);
    assert.equal(next.view.current.language, "en");
    assert.deepEqual(
      next.view.turns.map((t) => [t.turnNumber, t.arguments[0].label]),
      [[1, "Un, précisé"]],
    );
    assert.equal(
      applyVersion(next.view, version(4, 1, [])).kind,
      "gap",
      "an earlier turn cannot come back",
    );
  });

  it("catches up from a run of versions or replaces itself with a snapshot", () => {
    const run = applyCatchUp(emptyView, {
      kind: "edits",
      debateId: "d",
      from: 0,
      version: 3,
      versions: [
        version(1, 1, [addArgument(1, 1, "Un")]),
        version(2, 1, [addArgument(1, 2, "Deux")]),
        version(4, 1, [addArgument(1, 3, "Gap")]),
      ],
    });
    assert.equal(run.view.version, 2, "a gap inside the run stops it");
    assert.deepEqual(run.added, ["Un", "Deux"]);
    const snapshot = applyCatchUp(run.view, {
      kind: "snapshot",
      debateId: "d",
      version: 9,
      current: null,
      turns: [],
      flags: [{ turnNumber: 1, itemId: "t1a1", side: "A" }],
    });
    assert.equal(snapshot.view.version, 9);
    assert.ok(snapshot.view.flags.has("t1a1"));
    assert.equal(
      fromSnapshot({
        kind: "snapshot",
        debateId: "d",
        version: 0,
        current: null,
        turns: [],
        flags: [],
      }).flags.size,
      0,
    );
  });

  it("accepts only this debate's well-formed LiveKit messages", () => {
    const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
    const message = {
      v: 1,
      type: "edits",
      debateId: "d",
      version: 1,
      turnNumber: 1,
      side: "A",
      language: "fr",
      edits: [],
    };
    assert.deepEqual(parseOutlineMessage(encode(message), "d"), {
      version: 1,
      turnNumber: 1,
      side: "A",
      language: "fr",
      edits: [],
    });
    for (const bad of [
      { ...message, debateId: "other" },
      { ...message, v: 2 },
      { ...message, side: "C" },
      { ...message, language: "de" },
      { ...message, edits: "x" },
      { ...message, version: 1.5 },
    ])
      assert.equal(parseOutlineMessage(encode(bad), "d"), null);
    assert.equal(parseOutlineMessage(new TextEncoder().encode("{"), "d"), null);
  });
});

describe("public outline API", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  function app({ isPublic = true } = {}) {
    const calls = [];
    const outlines = {
      async isPublic() {
        return isPublic;
      },
      async snapshot(debateId) {
        calls.push(["snapshot", debateId]);
        return {
          kind: "snapshot",
          debateId,
          version: 4,
          finals: 0,
          current: null,
          turns: [],
          flags: [],
        };
      },
      async since(debateId, after) {
        calls.push(["since", debateId, after]);
        return {
          kind: "edits",
          debateId,
          from: after,
          version: 4,
          versions: [],
        };
      },
      async flag(input) {
        calls.push(["flag", input]);
        return input.itemId === "t1a1" ? { side: "A" } : null;
      },
    };
    const server = express();
    server.use(express.json());
    server.use(createOutlineRouter(outlines));
    server.use(
      createOutlineFlagRouter(outlines, (req, _res, next) => {
        req.user = { id: "7" };
        next();
      }),
    );
    return { server, calls };
  }
  const path = `/api/public/debates/${id}/outline`;

  it("serves a snapshot or the versions after one, with an ETag", async () => {
    const { server, calls } = app();
    const snapshot = await request(server).get(path);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.kind, "snapshot");
    assert.equal(snapshot.headers.etag, '"o4.0-snapshot"');
    assert.equal(snapshot.headers["cache-control"], "no-cache");
    const since = await request(server).get(`${path}?after=2`);
    assert.equal(since.body.kind, "edits");
    assert.deepEqual(calls.at(-1), ["since", id, 2]);
    const unchanged = await request(server)
      .get(`${path}?after=2`)
      .set("If-None-Match", '"o4-edits"');
    assert.equal(unchanged.status, 304);
  });

  it("refuses malformed requests and unpublished debates", async () => {
    const { server } = app();
    for (const bad of [
      "/api/public/debates/nope/outline",
      `${path}?after=-1`,
      `${path}?after=01`,
      `${path}?after=x`,
    ])
      assert.equal((await request(server).get(bad)).status, 404, bad);
    const hidden = app({ isPublic: false });
    assert.equal((await request(hidden.server).get(path)).status, 404);
  });

  it("records a debater's flag on their own item only", async () => {
    const { server, calls } = app();
    const flags = `/api/debates/${id}/outline/flags`;
    const created = await request(server)
      .post(flags)
      .send({ turnNumber: 1, itemId: "t1a1", note: "  Pas dit ça  " });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { flagged: true, side: "A" });
    assert.equal(calls.at(-1)[1].note, "Pas dit ça");
    assert.equal(calls.at(-1)[1].userId, "7");
    assert.equal(
      (
        await request(server)
          .post(flags)
          .send({ turnNumber: 1, itemId: "t1a2" })
      ).status,
      404,
    );
    for (const body of [
      {},
      { turnNumber: 0, itemId: "t1a1" },
      { turnNumber: 1, itemId: "t1" },
      { turnNumber: 1, itemId: "t1a1", note: "" },
      { turnNumber: 1, itemId: "t1a1", note: "x".repeat(281) },
      { turnNumber: 1, itemId: "t1a1", extra: true },
    ])
      assert.equal((await request(server).post(flags).send(body)).status, 400);
    assert.equal(
      (await request(server).post(`/api/debates/bad/outline/flags`).send({}))
        .status,
      400,
    );
  });
});
