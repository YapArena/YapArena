import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  percentile,
  summarizeTrial,
  trialWords,
  wordErrors,
} from "../dist/features/transcription/trial.js";

// Decision 0012: the provider trial's scoring (docs/transcription-provider-trial.md).

describe("transcription provider trial scoring", () => {
  it("normalizes words the same way for the reference and each provider", () => {
    assert.deepEqual(
      trialWords("L’énergie nucléaire, c'est « pilotable » — 24h/24 !"),
      ["l'", "énergie", "nucléaire", "c'", "est", "pilotable", "24h", "24"],
    );
    assert.deepEqual(trialWords("  Well-known -- facts... "), [
      "well-known",
      "facts",
    ]);
    assert.deepEqual(trialWords(""), []);
  });

  it("counts substitutions, deletions and insertions", () => {
    assert.deepEqual(
      wordErrors(
        ["le", "nucléaire", "est", "pilotable"],
        ["le", "nucléaire", "et", "très", "pilotable"],
      ),
      {
        words: 4,
        errors: 2,
        substitutions: 1,
        deletions: 0,
        insertions: 1,
        wer: 0.5,
      },
    );
    assert.equal(wordErrors(["a", "b"], []).deletions, 2);
    assert.equal(wordErrors([], ["a"]).wer, null);
    assert.equal(percentile([300, 100, 200, 400], 50), 200);
    assert.equal(percentile([300, 100, 200, 400], 95), 400);
    assert.equal(percentile([], 50), null);
  });

  it("scores each provider and language on the reference turns only", () => {
    const segment = (
      provider,
      role,
      language,
      turnNumber,
      text,
      latencyMs,
      at,
    ) => ({
      provider,
      role,
      language,
      turnNumber,
      spokenStartAt: at,
      text,
      latencyMs,
      audioMs: 30_000,
    });
    const rows = summarizeTrial(
      [
        segment("deepgram", "primary", "fr", 1, "est pilotable", 400, 2),
        segment("deepgram", "primary", "fr", 1, "Le nucléaire", 300, 1),
        segment(
          "elevenlabs",
          "shadow",
          "fr",
          1,
          "le nucléaire et pilotable",
          null,
          1,
        ),
        segment("deepgram", "primary", "en", 2, "costs too much", 500, 3),
        segment("deepgram", "primary", "en", 9, "unscored turn", 900, 4),
      ],
      {
        turns: [
          {
            turnNumber: 1,
            language: "fr",
            text: "Le nucléaire est pilotable.",
          },
          { turnNumber: 2, language: "en", text: "It costs too much." },
        ],
      },
      { deepgram: 0.29, elevenlabs: 0.39 },
    );
    assert.deepEqual(
      rows.map((row) => [row.provider, row.role, row.language, row.wer]),
      [
        ["deepgram", "primary", "en", 0.25],
        ["deepgram", "primary", "fr", 0],
        ["elevenlabs", "shadow", "fr", 0.25],
      ],
    );
    const french = rows[1];
    assert.equal(french.latencyP50Ms, 300);
    assert.equal(french.latencyP95Ms, 400);
    assert.equal(french.audioMinutes, 1);
    assert.equal(french.estimatedCost, 0.29 / 60);
    assert.equal(rows[2].latencyP50Ms, null, "shadow latency may be missing");
  });
});
