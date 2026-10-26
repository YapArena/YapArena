import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as serverReducer from "../dist/features/outline/reducer.js";
import * as agentReducer from "../dist-transcriber/features/outline/reducer.js";
import {
  containsBlockedTerm,
  moderationWords,
} from "../dist/features/outline/moderation.js";

const span = (startMs, endMs) => ({ startMs, endMs });
const proposal = (op, fields = {}) => ({
  op,
  argument: null,
  point: null,
  key: null,
  text: null,
  target: null,
  ...fields,
});
const none = new Set();

// The server and the transcriber agent compile their own copy of the reducer.
for (const [build, reducer] of [
  ["server", serverReducer],
  ["transcriber agent", agentReducer],
]) {
  const {
    OUTLINE_LIMITS,
    OutlineEditError,
    applyEdits,
    clampText,
    emptyTurn,
    isTurnOutline,
    outlineBytes,
    outlineIds,
    resolveEdits,
  } = reducer;
  describe(`outline reducer (${build} build)`, () => {
    it("assigns IDs, resolves keys and attaches the summarized span", () => {
      const turn = emptyTurn(3, "A", "fr");
      const { edits, rejected, outline } = resolveEdits(
        turn,
        [
          proposal("add_argument", {
            key: "new1",
            text: "  Le nucléaire est   pilotable ",
          }),
          proposal("add_point", {
            argument: "new1",
            text: "Production stable",
          }),
          proposal("add_point", { argument: "new1", text: "Pas de CO2" }),
        ],
        { span: span(1200, 4800), known: none },
      );
      assert.equal(rejected, 0);
      assert.deepEqual(edits, [
        {
          op: "add_argument",
          id: "t3a1",
          label: "Le nucléaire est pilotable",
          span: span(1200, 4800),
        },
        {
          op: "add_point",
          argument: "t3a1",
          id: "t3a1p1",
          text: "Production stable",
          span: span(1200, 4800),
        },
        {
          op: "add_point",
          argument: "t3a1",
          id: "t3a1p2",
          text: "Pas de CO2",
          span: span(1200, 4800),
        },
      ]);
      assert.deepEqual(applyEdits(turn, edits), outline, "clients agree");
      assert.equal(turn.arguments.length, 0, "the input never changes");
      assert.ok(isTurnOutline(outline));
    });

    it("updates, removes and links within limits and never reuses an ID", () => {
      let outline = resolveEdits(
        emptyTurn(2, "B", "en"),
        [
          proposal("add_argument", { key: "a", text: "Nuclear is too slow" }),
          proposal("add_point", {
            argument: "a",
            text: "Plants take 15 years",
          }),
        ],
        { span: span(0, 2000), known: none },
      ).outline;
      const next = resolveEdits(
        outline,
        [
          proposal("update_argument", {
            argument: "t2a1",
            text: "Nuclear is too slow to build",
          }),
          proposal("update_point", {
            point: "t2a1p1",
            text: "New plants take 15 years",
          }),
          proposal("remove_point", { point: "t2a1p1" }),
          proposal("add_point", { argument: "t2a1", text: "Costs overrun" }),
          proposal("link_rebuttal", { argument: "t2a1", target: "t1a1" }),
        ],
        { span: span(2500, 6000), known: new Set(["t1a1"]) },
      );
      assert.equal(next.rejected, 0);
      outline = next.outline;
      const [argument] = outline.arguments;
      assert.equal(argument.label, "Nuclear is too slow to build");
      assert.deepEqual(argument.span, span(0, 6000), "spans only grow");
      assert.deepEqual(
        argument.points.map((p) => [p.id, p.text]),
        [["t2a1p2", "Costs overrun"]],
        "a removed point's ID is not reused",
      );
      assert.equal(argument.rebuts, "t1a1");
      assert.deepEqual(outlineIds(outline), ["t2a1"]);
    });

    it("drops what cannot apply and keeps the rest", () => {
      const accept = (text) => !text.includes("forbidden");
      const proposed = [
        proposal("add_argument", { key: "x", text: "" }),
        proposal("add_point", { argument: "x", text: "orphan" }),
        proposal("update_argument", { argument: "t1a9", text: "unknown" }),
        proposal("remove_point", {}),
        proposal("link_rebuttal", { argument: "t1a1", target: "t0a1" }),
        proposal("add_argument", { text: "a forbidden word" }),
        proposal("bogus", {}),
        proposal("add_argument", { text: "Kept" }),
        proposal("add_argument", { text: "Beyond eight edits" }),
      ];
      const { edits, rejected } = resolveEdits(
        emptyTurn(1, "A", "en"),
        proposed,
        {
          span: span(0, 1),
          known: none,
          accept,
        },
      );
      assert.equal(rejected, 7);
      assert.deepEqual(
        edits.map((e) => e.op),
        ["add_argument"],
        "only the eighth proposal applies; the ninth is over the edit limit",
      );
      assert.equal(edits[0].label, "Kept");
    });

    it("enforces argument and point limits and clamps long text", () => {
      const many = Array.from({ length: 6 }, (_, i) =>
        proposal("add_argument", { text: `Argument ${i}` }),
      );
      const capped = resolveEdits(emptyTurn(1, "A", "en"), many, {
        span: span(0, 1),
        known: none,
      });
      assert.equal(capped.outline.arguments.length, OUTLINE_LIMITS.arguments);
      assert.equal(capped.rejected, 2);
      const points = resolveEdits(
        capped.outline,
        Array.from({ length: 8 }, () =>
          proposal("add_point", { argument: "t1a1", text: "point" }),
        ),
        { span: span(0, 1), known: none },
      );
      assert.equal(
        points.outline.arguments[0].points.length,
        OUTLINE_LIMITS.points,
      );
      const long = "word ".repeat(40);
      const label = clampText(long, OUTLINE_LIMITS.label);
      assert.ok(label.length <= OUTLINE_LIMITS.label);
      assert.ok(label.endsWith("…"));
      assert.equal(clampText("x".repeat(200), 10), `${"x".repeat(9)}…`);
      assert.equal(clampText("  short  ", 10), "short");
    });

    it("refuses invalid canonical edits so clients resynchronize", () => {
      const outline = applyEdits(emptyTurn(4, "A", "fr"), [
        { op: "add_argument", id: "t4a1", label: "Un", span: span(0, 1) },
      ]);
      for (const edit of [
        {
          op: "add_argument",
          id: "t4a1",
          label: "Duplicate",
          span: span(0, 1),
        },
        {
          op: "add_argument",
          id: "t5a2",
          label: "Other turn",
          span: span(0, 1),
        },
        {
          op: "add_argument",
          id: "t4a2",
          label: " untrimmed",
          span: span(0, 1),
        },
        { op: "add_argument", id: "t4a2", label: "Bad span", span: span(5, 1) },
        { op: "update_argument", id: "t4a9", label: "x", span: span(0, 1) },
        {
          op: "add_point",
          argument: "t4a1",
          id: "t4a2p1",
          text: "x",
          span: span(0, 1),
        },
        { op: "update_point", id: "t4a1p1", text: "x", span: span(0, 1) },
        { op: "remove_point", id: "t4a1p1" },
        { op: "link_rebuttal", id: "t4a1", target: "t4a1" },
        { op: "explode", id: "t4a1" },
      ])
        assert.throws(() => applyEdits(outline, [edit]), OutlineEditError);
      assert.throws(
        () =>
          applyEdits(
            outline,
            Array.from({ length: 9 }, () => ({ op: "remove_point", id: "x" })),
          ),
        /too many edits/,
      );
    });

    it("recognizes stored outlines and measures their size", () => {
      assert.equal(isTurnOutline(null), false);
      assert.equal(isTurnOutline({ turnNumber: 1, side: "C" }), false);
      assert.equal(
        isTurnOutline({
          turnNumber: 1,
          side: "A",
          language: "en",
          arguments: [
            {
              id: "t1a1",
              label: "ok",
              span: span(0, 1),
              points: [],
              rebuts: "bad",
            },
          ],
        }),
        false,
      );
      const outline = emptyTurn(1, "B", "en");
      assert.equal(outlineBytes(outline), JSON.stringify(outline).length);
    });
  });
}

describe("outline moderation", () => {
  it("blocks French and English slurs and insults in disguise", () => {
    for (const text of [
      "What a MORON",
      "c'est un connard",
      "espèce d'enculé",
      "fils de pute",
      "ta gueule",
      "m0r0n",
      "fuuuuck that",
      "Idiot!",
    ])
      assert.equal(containsBlockedTerm(text), true, text);
  });

  it("leaves ordinary argument text alone", () => {
    for (const text of [
      "The pros and cons of nuclear power",
      "Le nucléaire est une énergie pilotable",
      "Coal plants pollute",
      "Il faut une réponse coordonnée",
      "Moroccan exports grew",
      "Cool roofs reduce heat",
    ])
      assert.equal(containsBlockedTerm(text), false, text);
    assert.deepEqual(moderationWords("Énergie, l'été !"), [
      "energie",
      "l",
      "ete",
    ]);
    assert.deepEqual(moderationWords("b!tch"), ["bitch"]);
  });
});
