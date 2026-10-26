import Anthropic from "@anthropic-ai/sdk";
import {
  OUTLINE_LIMITS,
  proposedOps,
  type ProposedEdit,
} from "../../outline/reducer.ts";
import type { CallResult, OutlineRequest } from "./outline-loop.ts";

// Decision 0012: the live outline's model call. The founder chose Claude
// Haiku 5.5 for live updates. For the lowest latency: thinking off (accepted
// at low effort), effort low, a strict JSON schema, a small max_tokens, no SDK
// retries and a 4 s abort (a late answer is skipped, never queued). Claude
// Haiku 5.5 has no server-side refusal fallback; a refusal is skipped.
//
// Prompt caching: the stable instructions (with French and English examples,
// well over Claude Haiku 5.5's 512-token minimum) come first, then the debate
// prefix (proposition and debate-wide argument map), then the volatile part.

export const LIVE_MODEL = "claude-haiku-5-5";
export const LIVE_TIMEOUT_MS = 4000;
export const LIVE_MAX_TOKENS = 800;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
export const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["edits"],
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "argument", "point", "key", "text", "target"],
        properties: {
          op: { type: "string", enum: [...proposedOps] },
          argument: nullableString,
          point: nullableString,
          key: nullableString,
          text: nullableString,
          target: nullableString,
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `You maintain a live outline of what one debater is arguing during their speaking turn in a public debate. Viewers read the outline while the debater speaks, so it must be faithful, neutral and stable.

Each update gives you the current outline of this turn, the text the speaker has just said that is not yet in the outline, and a little earlier context. Return only the edits that the new text requires.

Rules:
- Be faithful and neutral. Record what the speaker claims and the reasons they give. Never judge whether a claim is true, strong or persuasive, and never add facts, examples or conclusions the speaker did not say.
- Make minimal edits. If the new text is filler, repetition, a greeting, a procedural remark or an unfinished sentence, return no edits.
- Keep each argument's identity. Change an argument's label only when the speaker changes or sharpens what the claim means, not to improve the wording.
- Start a new argument only for a distinct claim, a different conclusion. A new reason, statistic or example for an existing claim is a point under that argument.
- Points are the reasons, evidence and examples that support their argument.
- When the speaker directly answers an argument from the debate map (from either side), link it with link_rebuttal, using the map's ID as target.
- Never reproduce slurs, insults or personal attacks. Describe them neutrally ("questions the opponent's credibility") only if they carry an argument; otherwise leave them out.
- Write labels and points in the speaker's language, given with each update. Keep the speaker's own terms where possible.
- Limits: a label has at most ${OUTLINE_LIMITS.label} characters, a point at most ${OUTLINE_LIMITS.point}. A turn has at most ${OUTLINE_LIMITS.arguments} arguments and each argument at most ${OUTLINE_LIMITS.points} points. Return at most ${OUTLINE_LIMITS.edits} edits.

Edits (fields an edit does not use are null):
- add_argument: text = the claim as a short label; key = a temporary name such as "new1" that later edits in the same answer can use as "argument".
- update_argument: argument = an existing argument ID; text = the new label.
- add_point: argument = an existing argument ID or a key from this answer; text = the point.
- update_point: point = an existing point ID; text = the new wording.
- remove_point: point = an existing point ID the speaker took back or that duplicates another point.
- link_rebuttal: argument = an argument ID or key of this turn; target = the ID of the argument it answers.
Use existing IDs exactly as given. Never invent an ID.

Example 1 (English). Current outline: no arguments. New text: "Look, the first thing to understand is that nuclear plants run around the clock. Wind and solar don't. Germany shut its reactors and burned more coal." Edits:
{"edits":[{"op":"add_argument","argument":null,"point":null,"key":"new1","text":"Nuclear provides reliable round-the-clock power","target":null},{"op":"add_point","argument":"new1","point":null,"key":null,"text":"Wind and solar are intermittent","target":null},{"op":"add_point","argument":"new1","point":null,"key":null,"text":"Germany closed reactors and burned more coal","target":null}]}

Example 2 (English). Current outline: t3a1 "Nuclear provides reliable round-the-clock power" with point t3a1p1 "Wind and solar are intermittent". New text: "And honestly, my opponent clearly hasn't read anything on this, um, so yeah." Edits:
{"edits":[]}

Example 3 (French). Current outline: t2a1 "Le nucléaire coûte trop cher" with point t2a1p1 "Flamanville a dépassé son budget". Debate map: t1a2 (other side) "Les renouvelables sont moins chères". New text: "Et ce n'est pas seulement le coût : les chantiers prennent quinze ans, alors que l'urgence climatique c'est maintenant. On me dit que les renouvelables sont moins chères ; justement, elles se construisent en deux ans." Edits:
{"edits":[{"op":"update_argument","argument":"t2a1","point":null,"key":null,"text":"Le nucléaire est trop cher et trop lent face à l'urgence","target":null},{"op":"add_point","argument":"t2a1","point":null,"key":null,"text":"Les chantiers prennent quinze ans","target":null},{"op":"add_argument","argument":null,"point":null,"key":"new1","text":"Les renouvelables se déploient plus vite","target":null},{"op":"add_point","argument":"new1","point":null,"key":null,"text":"Un parc se construit en deux ans","target":null},{"op":"link_rebuttal","argument":"new1","point":null,"key":null,"text":null,"target":"t1a2"}]}

Example 4 (French). Current outline: t4a1 "Il faut taxer les vols courts" with points t4a1p1 "Le train existe sur ces trajets" and t4a1p2 "Les vols courts polluent beaucoup". New text: "Enfin, pour être précis, je parle des trajets de moins de trois heures en train." Edits:
{"edits":[{"op":"update_point","argument":null,"point":"t4a1p1","key":null,"text":"Le train existe en moins de trois heures sur ces trajets","target":null}]}`;

function debatePrefix(request: OutlineRequest) {
  const map = request.map.length
    ? request.map
        .map(
          (entry) =>
            `- ${entry.id} (turn ${entry.turnNumber}, side ${entry.side}): ${entry.label}`,
        )
        .join("\n")
    : "(no earlier arguments)";
  return `Debate proposition: ${request.proposition}\n\nDebate map (earlier arguments you may target with link_rebuttal):\n${map}`;
}

function volatile(request: OutlineRequest) {
  const outline = request.outline.arguments.length
    ? request.outline.arguments
        .map(
          (item) =>
            `${item.id} "${item.label}"${item.rebuts ? ` (rebuts ${item.rebuts})` : ""}\n${item.points
              .map((point) => `  ${point.id} "${point.text}"`)
              .join("\n")}`,
        )
        .join("\n")
    : "(no arguments yet)";
  const language = request.language === "fr" ? "French" : "English";
  return `Speaker's language: ${language}. Write labels and points in ${language}.\n\nCurrent outline of turn ${request.outline.turnNumber} (side ${request.outline.side}):\n${outline}\n\nEarlier context (already reflected in the outline):\n${request.context || "(none)"}\n\nNew text to reflect:\n${request.newText}`;
}

/** Validates the model's JSON against the edit shape. */
export function parseEdits(text: string): ProposedEdit[] | null {
  try {
    const value = JSON.parse(text) as { edits?: unknown };
    if (!Array.isArray(value.edits)) return null;
    const edits: ProposedEdit[] = [];
    for (const edit of value.edits.slice(0, OUTLINE_LIMITS.edits)) {
      if (!edit || typeof edit !== "object") return null;
      const item = edit as Record<string, unknown>;
      if (!proposedOps.includes(item.op as ProposedEdit["op"])) return null;
      const field = (name: string) =>
        typeof item[name] === "string" ? (item[name] as string) : null;
      edits.push({
        op: item.op as ProposedEdit["op"],
        argument: field("argument"),
        point: field("point"),
        key: field("key"),
        text: field("text"),
        target: field("target"),
      });
    }
    return edits;
  } catch {
    return null;
  }
}

export function createLiveOutliner({
  client = new Anthropic(),
  log = () => {},
  now = () => Date.now(),
}: {
  client?: Pick<Anthropic, "messages">;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
} = {}) {
  return async function propose(request: OutlineRequest): Promise<CallResult> {
    const started = now();
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: LIVE_MODEL,
          max_tokens: LIVE_MAX_TOKENS,
          thinking: { type: "disabled" },
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: EDIT_SCHEMA },
          },
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: debatePrefix(request),
                  cache_control: { type: "ephemeral" },
                },
                { type: "text", text: volatile(request) },
              ],
            },
          ],
        },
        { timeout: LIVE_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (error) {
      const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
      log("live outline call failed", {
        reason: timedOut ? "timeout" : "error",
        status: error instanceof Anthropic.APIError ? error.status : undefined,
      });
      return { kind: "skip", reason: timedOut ? "timeout" : "error" };
    }
    log("live outline call", {
      latencyMs: now() - started,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    });
    if (response.stop_reason === "refusal")
      return { kind: "skip", reason: "refusal" };
    if (response.stop_reason !== "end_turn")
      return { kind: "skip", reason: "invalid" };
    const text = response.content.find((block) => block.type === "text");
    const edits = text?.type === "text" ? parseEdits(text.text) : null;
    return edits
      ? { kind: "edits", edits, model: LIVE_MODEL }
      : { kind: "skip", reason: "invalid" };
  };
}
