import Anthropic from "@anthropic-ai/sdk";
import {
  parseCleanupArguments,
  type CleanupArgument,
} from "../../outline/cleanup.ts";
import { OUTLINE_LIMITS, type TurnOutline } from "../../outline/reducer.ts";
import type { MapEntry } from "./outline-loop.ts";

// Decision 0012: the window cleanup. The founder chose Claude Sonnet 5.5 for
// it. After a turn ends it rewrites the turn's live outline from the whole
// turn's transcript and maps it onto the debate's earlier arguments. It runs
// once per turn, off the live path: adaptive thinking at low effort (Claude
// Sonnet 5.5 rejects disabled thinking), a strict JSON schema, a 20 s timeout
// and one retry. A policy decline is retried server-side on the default
// fallback model (`fallbacks: "default"`); a refusal that remains is skipped,
// and the frozen outline stays final.

export const CLEANUP_MODEL = "claude-sonnet-5-5";
export const CLEANUP_TIMEOUT_MS = 20_000;
export const CLEANUP_MAX_TOKENS = 4000;
export const CLEANUP_BETA = "server-side-fallback-2026-07-01";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
export const CLEANUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["arguments"],
  properties: {
    arguments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "points", "rebuts", "continues"],
        properties: {
          id: nullableString,
          label: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          rebuts: nullableString,
          continues: nullableString,
        },
      },
    },
  },
} as const;

export const CLEANUP_PROMPT = `You write the final outline of one debater's finished speaking turn in a public debate. While the debater spoke, a faster model kept a live outline. You now have the whole turn's transcript and that live outline, and you return the turn's clean final outline. Viewers read it after the turn, and it is used to show how the audience reacted to each argument, so it must be faithful, neutral and precise.

Rules:
- Be faithful and neutral. Record what the speaker claimed and the reasons they gave. Never judge whether a claim is true, strong or persuasive, and never add facts, examples or conclusions the speaker did not say.
- Keep the live outline's arguments where they are right: reuse an argument's ID when your argument is the same claim, even if you reword it. Use null as the ID only for a claim the live outline missed. Merge live arguments that are really one claim (keep the first one's ID) and drop ones that were filler.
- An argument is a distinct claim. Its points are the reasons, evidence and examples the speaker gave for it, in the order given. Leave out repetition, filler and procedural remarks.
- rebuts: when an argument directly answers an earlier argument from the debate map (either side), give that argument's ID; otherwise null.
- continues: when an argument is the same claim as an earlier argument by the same side in the debate map, give that argument's ID, so they count as one argument across turns; otherwise null.
- Use only IDs from the live outline or the debate map, exactly as given. Never invent an ID.
- Never reproduce slurs, insults or personal attacks. Describe them neutrally ("questions the opponent's credibility") only if they carry an argument; otherwise leave them out.
- Write in the speaker's language, given with the turn. Keep the speaker's own terms where possible.
- Limits: at most ${OUTLINE_LIMITS.arguments} arguments, each with a label of at most ${OUTLINE_LIMITS.label} characters and at most ${OUTLINE_LIMITS.points} points of at most ${OUTLINE_LIMITS.point} characters.

Example (French). Debate map: t1a1 (side B) "Les renouvelables suffisent", t2a1 (side A) "Le nucléaire est pilotable". Turn 4, side A. Live outline: t4a1 "Le nucléaire coûte cher" with point t4a1p1 "Flamanville a dépassé son budget"; t4a2 "Les renouvelables ne suffisent pas l'hiver". Transcript: "On me dit que le nucléaire coûte cher. Oui, Flamanville a dépassé son budget, mais rapporté à quarante ans de production, le coût reste compétitif. Et comme je l'ai dit, le nucléaire produit à la demande, ce que les renouvelables ne font pas l'hiver." Answer:
{"arguments":[{"id":"t4a1","label":"Le coût du nucléaire reste compétitif sur sa durée de vie","points":["Flamanville a dépassé son budget","Le coût rapporté à quarante ans de production reste compétitif"],"rebuts":null,"continues":null},{"id":"t4a2","label":"Le nucléaire produit à la demande, pas les renouvelables l'hiver","points":["Les renouvelables ne couvrent pas la demande l'hiver"],"rebuts":"t1a1","continues":"t2a1"}]}

Example (English). Debate map: t1a1 (side A) "Cities should ban cars downtown". Turn 2, side B. Live outline: t2a1 "A ban hurts small shops" with point t2a1p1 "Deliveries need vehicles". Transcript: "A downtown ban would hurt the small shops that depend on drivers, and frankly my opponent has never run a business. Deliveries need vehicles. A study in Madrid showed sales fell in the first year." Answer:
{"arguments":[{"id":"t2a1","label":"A downtown car ban would hurt small shops","points":["Small shops depend on customers who drive","Deliveries need vehicles","A Madrid study found sales fell in the first year"],"rebuts":"t1a1","continues":null}]}`;

export interface CleanupRequest {
  proposition: string;
  map: readonly MapEntry[];
  outline: TurnOutline;
  /** The whole turn's final transcript. */
  transcript: string;
}
export type CleanupResult =
  | { kind: "cleanup"; arguments: CleanupArgument[]; model: string }
  | { kind: "skip"; reason: "refusal" | "timeout" | "invalid" | "error" };

function describe(request: CleanupRequest) {
  const map = request.map.length
    ? request.map
        .map(
          (entry) =>
            `- ${entry.id} (turn ${entry.turnNumber}, side ${entry.side}): ${entry.label}`,
        )
        .join("\n")
    : "(no earlier arguments)";
  const live = request.outline.arguments.length
    ? request.outline.arguments
        .map(
          (item) =>
            `${item.id} "${item.label}"${item.rebuts ? ` (rebuts ${item.rebuts})` : ""}\n${item.points
              .map((point) => `  ${point.id} "${point.text}"`)
              .join("\n")}`,
        )
        .join("\n")
    : "(no arguments)";
  const language = request.outline.language === "fr" ? "French" : "English";
  return {
    prefix: `Debate proposition: ${request.proposition}\n\nDebate map (earlier arguments):\n${map}`,
    turn: `Turn ${request.outline.turnNumber}, side ${request.outline.side}. Speaker's language: ${language}. Write in ${language}.\n\nLive outline:\n${live}\n\nWhole turn's transcript:\n${request.transcript || "(no speech)"}`,
  };
}

/** The cleanup's JSON, validated against the argument shape. */
export function parseCleanup(text: string): CleanupArgument[] | null {
  try {
    const value = JSON.parse(text) as { arguments?: unknown };
    return parseCleanupArguments(value.arguments);
  } catch {
    return null;
  }
}

/**
 * Why parseCleanup refused a cleanup, for the log: a reason and counts, never
 * text. The schema can't carry the limits (structured outputs accept no
 * array bound beyond minItems 0 or 1), so the prompt states them.
 */
export function cleanupProblem(text: string | undefined): {
  reason: string;
  arguments?: number;
  mostPoints?: number;
} {
  if (text === undefined) return { reason: "no_text" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "not_json" };
  }
  const items = (value as { arguments?: unknown } | null)?.arguments;
  if (!Array.isArray(items)) return { reason: "no_arguments" };
  const counts = {
    arguments: items.length,
    mostPoints: Math.max(
      0,
      ...items.map((item: unknown) => {
        const points = (item as { points?: unknown } | null)?.points;
        return Array.isArray(points) ? points.length : 0;
      }),
    ),
  };
  if (counts.arguments > OUTLINE_LIMITS.arguments)
    return { reason: "too_many_arguments", ...counts };
  if (counts.mostPoints > OUTLINE_LIMITS.points)
    return { reason: "too_many_points", ...counts };
  return { reason: "invalid_argument", ...counts };
}

export function createWindowCleaner({
  client = new Anthropic(),
  log = () => {},
  now = () => Date.now(),
}: {
  client?: Pick<Anthropic, "beta">;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
} = {}) {
  return async function clean(request: CleanupRequest): Promise<CleanupResult> {
    const started = now();
    const { prefix, turn } = describe(request);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: CLEANUP_MODEL,
          max_tokens: CLEANUP_MAX_TOKENS,
          betas: [CLEANUP_BETA],
          fallbacks: "default",
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: CLEANUP_SCHEMA },
          },
          system: [
            {
              type: "text",
              text: CLEANUP_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prefix,
                  cache_control: { type: "ephemeral" },
                },
                { type: "text", text: turn },
              ],
            },
          ],
        },
        { timeout: CLEANUP_TIMEOUT_MS, maxRetries: 1 },
      );
    } catch (error) {
      const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
      log("window cleanup failed", {
        reason: timedOut ? "timeout" : "error",
        status: error instanceof Anthropic.APIError ? error.status : undefined,
      });
      return { kind: "skip", reason: timedOut ? "timeout" : "error" };
    }
    log("window cleanup call", {
      latencyMs: now() - started,
      model: response.model,
      stopReason: response.stop_reason,
      fallback: response.content.some((block) => block.type === "fallback"),
      inputTokens: response.usage.input_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    });
    if (response.stop_reason === "refusal")
      return { kind: "skip", reason: "refusal" };
    if (response.stop_reason !== "end_turn")
      return { kind: "skip", reason: "invalid" };
    const block = response.content.find((item) => item.type === "text");
    const text = block?.type === "text" ? block.text : undefined;
    const items = text === undefined ? null : parseCleanup(text);
    if (items)
      return { kind: "cleanup", arguments: items, model: response.model };
    log("window cleanup invalid", cleanupProblem(text));
    return { kind: "skip", reason: "invalid" };
  };
}
