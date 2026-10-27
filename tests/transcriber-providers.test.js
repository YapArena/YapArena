import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { initializeLogger } from "@livekit/agents";
import { createSpeechEngine } from "../dist-transcriber/features/transcription/agent/providers.js";

// Decision 0012: each speaker's audio reaches the provider with the speaker's
// language. A local server stands in for LiveKit Inference and records the
// session message that opens each Deepgram stream.

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

async function sessionsReceived(count) {
  const deadline = Date.now() + 5000;
  while (sessions.length < count) {
    assert.ok(Date.now() < deadline, `expected ${count} sessions`);
    await new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 100);
    });
  }
  return sessions;
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
      const opened = await sessionsReceived(2);
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
});
