import { inference, stt } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import type { AudioFrame } from "@livekit/rtc-node";
import type { DebaterLanguage, TranscriptionProvider } from "../protocol.ts";
import type {
  SpeechChannel,
  SpeechEngine,
  SpeechUpdate,
} from "./transcriber.ts";

// Decision 0012: the provider switch. Deepgram Nova-3 runs through LiveKit
// Inference (billed by LiveKit, authenticated with the project's injected
// key); ElevenLabs Scribe v2 Realtime runs through its plugin with our own
// key. Both receive 16 kHz mono frames and the speaker's own language.

/** How long a finishing channel waits for its last final transcript. */
export const FINISH_TIMEOUT_MS = 4000;

type Log = (message: string, detail?: Record<string, unknown>) => void;

// Adapts a LiveKit speech stream to the transcriber's channel. `finish`
// follows each provider's documented end of input: Inference finalizes on
// endInput; the ElevenLabs plugin commits on flush and must then be closed.
function channel(
  stream: stt.SpeechStream,
  provider: TranscriptionProvider,
  log: Log,
): SpeechChannel<AudioFrame> {
  let finalSeen: (() => void) | undefined;
  let closed = false;
  async function* updates(): AsyncGenerator<SpeechUpdate> {
    for await (const event of stream) {
      const best = event.alternatives?.[0];
      if (event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT && best)
        yield { kind: "interim", text: best.text };
      else if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT && best) {
        yield {
          kind: "final",
          text: best.text,
          startTime: best.startTime,
          endTime: best.endTime,
          words: (best.words ?? []).map((word) => ({
            text: word.text,
            startTime: word.startTime,
            endTime: word.endTime,
            confidence: word.confidence,
          })),
        };
        finalSeen?.();
      }
    }
  }
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      stream.close();
    } catch (error) {
      log("speech stream close failed", { provider, error });
    }
  };
  return {
    updates: updates(),
    push(frame) {
      if (!closed) stream.pushFrame(frame);
    },
    close,
    async finish() {
      if (closed) return;
      const settled = new Promise<void>((resolve) => {
        finalSeen = resolve;
        setTimeout(resolve, FINISH_TIMEOUT_MS).unref();
      });
      try {
        if (provider === "elevenlabs") stream.flush();
        else stream.endInput();
      } catch (error) {
        log("speech stream finish failed", { provider, error });
      }
      await settled;
      close();
    },
  };
}

export function createSpeechEngine(
  provider: TranscriptionProvider,
  { elevenLabsKey, log }: { elevenLabsKey: string | undefined; log: Log },
): SpeechEngine<AudioFrame> {
  // A bare EventEmitter 'error' without a listener would crash the job.
  const onError = (error: unknown) =>
    log("speech provider error", { provider, error });
  let stream: (language: DebaterLanguage) => stt.SpeechStream;
  if (provider === "deepgram") {
    // LiveKit Inference opens its connection with the engine's language and
    // ignores the stream's (@livekit/agents 1.9.3); without one, Deepgram
    // transcribes French as English. So each language has its own engine.
    const deepgram = (language: DebaterLanguage) => {
      const engine = new inference.STT<"deepgram/nova-3">({
        model: "deepgram/nova-3",
        language,
        modelOptions: {
          interim_results: true,
          punctuate: true,
          smart_format: true,
          filler_words: false,
        },
      });
      engine.on("error", onError);
      return engine;
    };
    const engines: Record<DebaterLanguage, ReturnType<typeof deepgram>> = {
      fr: deepgram("fr"),
      en: deepgram("en"),
    };
    stream = (language) => engines[language].stream({ language });
  } else {
    // The ElevenLabs plugin connects with the stream's language.
    const engine = new elevenlabs.STT({
      model: "scribe_v2_realtime",
      apiKey: elevenLabsKey,
      includeTimestamps: true,
      serverVad: {},
      sampleRate: 16000,
    });
    engine.on("error", onError);
    stream = (language) => engine.stream({ language });
  }
  return {
    provider,
    open(language: DebaterLanguage) {
      return channel(stream(language), provider, log);
    },
  };
}
