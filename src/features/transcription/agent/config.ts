import {
  transcriptionProviders,
  type TranscriptionProvider,
} from "../protocol.ts";

// Decision 0012: the transcriber agent's settings. On LiveKit Cloud,
// LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are injected at runtime
// and are never secrets here; everything below is set with
// `lk agent update-secrets`.
export interface AgentConfig {
  agentName: string;
  /** The YapArena origin that receives transcript updates. */
  ingestUrl: URL;
  ingestSecret: string;
  provider: TranscriptionProvider;
  /** Optional second provider on the same audio; stored, never shown. */
  shadowProvider: TranscriptionProvider | null;
  elevenLabsKey: string | undefined;
  /** At most this many interim caption updates a second. */
  captionsPerSecond: number;
  /** The live outline runs only with a Claude API key. */
  anthropicKey: string | undefined;
  /** At least this long between the starts of two outline calls. */
  outlineMinIntervalMs: number;
}

function provider(value: string | undefined, name: string) {
  if (!transcriptionProviders.includes(value as TranscriptionProvider))
    throw new Error(`${name} must be deepgram or elevenlabs`);
  return value as TranscriptionProvider;
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const agentName =
    environment.TRANSCRIBER_AGENT_NAME ?? "yaparena-transcriber";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(agentName))
    throw new Error(
      "TRANSCRIBER_AGENT_NAME must be lowercase letters, digits and dashes",
    );
  let ingestUrl: URL;
  try {
    ingestUrl = new URL(environment.YAPARENA_INGEST_URL ?? "");
  } catch {
    throw new Error("YAPARENA_INGEST_URL must be the YapArena origin");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    ingestUrl.hostname,
  );
  if (
    ingestUrl.origin !== environment.YAPARENA_INGEST_URL?.replace(/\/$/, "") ||
    (ingestUrl.protocol !== "https:" &&
      !(local && ingestUrl.protocol === "http:"))
  )
    throw new Error(
      "YAPARENA_INGEST_URL must be an HTTPS origin (HTTP only for localhost)",
    );
  const ingestSecret = environment.TRANSCRIPTION_INGEST_SECRET ?? "";
  if (Buffer.byteLength(ingestSecret) < 32)
    throw new Error("TRANSCRIPTION_INGEST_SECRET must be at least 32 bytes");
  const primary = provider(
    environment.TRANSCRIPTION_PROVIDER ?? "deepgram",
    "TRANSCRIPTION_PROVIDER",
  );
  const shadow = environment.TRANSCRIPTION_SHADOW_PROVIDER
    ? provider(
        environment.TRANSCRIPTION_SHADOW_PROVIDER,
        "TRANSCRIPTION_SHADOW_PROVIDER",
      )
    : null;
  if (shadow === primary)
    throw new Error(
      "TRANSCRIPTION_SHADOW_PROVIDER must differ from the primary",
    );
  const elevenLabsKey = environment.ELEVEN_API_KEY || undefined;
  if ((primary === "elevenlabs" || shadow === "elevenlabs") && !elevenLabsKey)
    throw new Error("ELEVEN_API_KEY is required for ElevenLabs transcription");
  const captionsPerSecond = Number(
    environment.CAPTION_UPDATES_PER_SECOND ?? "4",
  );
  if (
    !Number.isInteger(captionsPerSecond) ||
    captionsPerSecond < 1 ||
    captionsPerSecond > 10
  )
    throw new Error(
      "CAPTION_UPDATES_PER_SECOND must be an integer from 1 to 10",
    );
  const outlineMinIntervalMs = Number(
    environment.OUTLINE_MIN_INTERVAL_MS ?? "3000",
  );
  if (
    !Number.isInteger(outlineMinIntervalMs) ||
    outlineMinIntervalMs < 1000 ||
    outlineMinIntervalMs > 30_000
  )
    throw new Error(
      "OUTLINE_MIN_INTERVAL_MS must be an integer from 1000 to 30000",
    );
  return {
    agentName,
    ingestUrl,
    ingestSecret,
    provider: primary,
    shadowProvider: shadow,
    elevenLabsKey,
    captionsPerSecond,
    anthropicKey: environment.ANTHROPIC_API_KEY || undefined,
    outlineMinIntervalMs,
  };
}
