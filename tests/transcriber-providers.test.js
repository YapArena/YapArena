import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import {
  ELEVENLABS_SILENCE_SECS,
  createSpeechEngine,
} from "../dist-transcriber/features/transcription/agent/providers.js";

// Decision 0012: each speaker's audio reaches the provider with the speaker's
// language. A local server stands in for LiveKit Inference and ElevenLabs: it
// records each connection's URL and the session message that opens each
// Deepgram stream.

const urls = [];
const sessions = [];
const waiters = [];
const sockets = new Set();
const server = createServer();

// The first frame from the client, unmasked. Client frames are always masked.
function firstFrame(data) {
  if (data.length < 2) return null;
  let length = data[1] & 0x7f,
    offset = 2;
  if (length === 126) {
    if (data.length < 4) return null;
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) return null;
    length = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  if (data.length < offset + 4 + length) return null;
  const mask = data.subarray(offset, offset + 4);
  const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return payload.toString("utf8");
}

server.on("upgrade", (request, socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  urls.push(request.url);
  for (const waiter of waiters.splice(0)) waiter();
  const accept = createHash("sha1")
    .update(
      `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let received = Buffer.alloc(0),
    recorded = false;
  socket.on("data", (chunk) => {
    if (recorded) return;
    received = Buffer.concat([received, chunk]);
    const text = firstFrame(received);
    if (text === null) return;
    recorded = true;
    sessions.push(JSON.parse(text));
    for (const waiter of waiters.splice(0)) waiter();
  });
});

async function received(list, count, what) {
  const deadline = Date.now() + 5000;
  while (list.length < count) {
    assert.ok(Date.now() < deadline, `expected ${count} ${what}`);
    await new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 100);
    });
  }
  return list;
}

describe("speech providers", () => {
  before(async () => {
    initializeLogger({ pretty: false, level: "silent" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.LIVEKIT_INFERENCE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret";
  });
  after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it("opens each Deepgram stream in the speaker's language", async () => {
    const errors = [];
    const engine = createSpeechEngine("deepgram", {
      elevenLabsKey: undefined,
      log: (message, detail) => errors.push({ message, detail }),
    });
    const french = engine.open("fr");
    const english = engine.open("en");
    try {
      const opened = await received(sessions, 2, "sessions");
      assert.deepEqual(
        opened
          .map((session) => [
            session.type,
            session.model,
            session.settings.language,
          ])
          .sort(),
        [
          ["session.create", "deepgram/nova-3", "en"],
          ["session.create", "deepgram/nova-3", "fr"],
        ],
      );
      assert.equal(opened[0].settings.extra.smart_format, true);
      assert.deepEqual(errors, []);
    } finally {
      french.close();
      english.close();
    }
  });

  it("opens each ElevenLabs stream in the speaker's language, committing after short pauses", async () => {
    const errors = [];
    const engine = createSpeechEngine("elevenlabs", {
      elevenLabsKey: "test-key",
      elevenLabsUrl: `http://127.0.0.1:${server.address().port}/v1`,
      log: (message, detail) => errors.push({ message, detail }),
    });
    const before = urls.length,
      sent = sessions.length;
    const french = engine.open("fr");
    try {
      await received(urls, before + 1, "connections");
      // One second of silence: its first chunk proves the connection is open.
      french.push(new AudioFrame(new Int16Array(16000), 16000, 1, 16000));
      await received(sessions, sent + 1, "audio messages");
      assert.equal(sessions.at(-1).message_type, "input_audio_chunk");
      const url = new URL(urls[before], "http://127.0.0.1");
      assert.equal(url.pathname, "/v1/speech-to-text/realtime");
      assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
      assert.equal(url.searchParams.get("language_code"), "fr");
      assert.equal(url.searchParams.get("commit_strategy"), "vad");
      assert.equal(ELEVENLABS_SILENCE_SECS, 0.5);
      assert.equal(url.searchParams.get("vad_silence_threshold_secs"), "0.5");
      assert.equal(url.searchParams.get("include_timestamps"), "true");
      assert.deepEqual(errors, []);
    } finally {
      french.close();
    }
  });
});
