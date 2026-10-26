import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUserStream } from "../public/lib/user-stream.js";

// A stand-in for the browser's EventSource: tests emit events and errors by hand.
function fakeScope() {
  const opened = [];
  class FakeEventSource {
    CLOSED = 2;
    readyState = 0;
    closed = false;
    listeners = new Map();
    constructor(url) {
      this.url = url;
      opened.push(this);
    }
    addEventListener(kind, listener) {
      const list = this.listeners.get(kind) ?? [];
      list.push(listener);
      this.listeners.set(kind, list);
    }
    emit(kind, data) {
      for (const listener of this.listeners.get(kind) ?? [])
        listener({
          data: typeof data === "string" ? data : JSON.stringify(data),
        });
    }
    fail(readyState) {
      this.readyState = readyState;
      for (const listener of this.listeners.get("error") ?? []) listener({});
    }
    close() {
      this.closed = true;
    }
  }
  return { scope: { EventSource: FakeEventSource }, opened };
}

describe("shared personal stream", () => {
  it("opens one stream for every kind and module on the page", () => {
    const { scope, opened } = fakeScope();
    const stream = createUserStream(scope);
    assert.equal(opened.length, 0, "nothing opens until someone listens");
    const states = [];
    const results = [];
    const other = [];
    stream.on("state", (data) => states.push(data));
    stream.on("results", (data) => results.push(data));
    stream.on("state", (data) => other.push(data));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, "/api/me/stream");
    opened[0].emit("state", { ticket: null });
    opened[0].emit("results", {});
    opened[0].emit("state", "not json");
    assert.deepEqual(states, [{ ticket: null }]);
    assert.deepEqual(other, [{ ticket: null }]);
    assert.deepEqual(results, [{}]);
  });

  it("closes when the last listener leaves and listens once per kind", () => {
    const { scope, opened } = fakeScope();
    const stream = createUserStream(scope);
    const seen = [];
    const stop = stream.on("state", (data) => seen.push(data));
    stop();
    assert.equal(opened[0].closed, true);
    const again = stream.on("state", (data) => seen.push(data));
    assert.equal(opened.length, 2);
    const second = stream.on("state", () => {});
    second();
    again();
    stream.on("state", (data) => seen.push(data));
    opened[2].emit("state", 1);
    assert.deepEqual(seen, [1], "a re-added kind is not delivered twice");
  });

  it("tells modules once when the stream fails for good, and reconnects after reset", () => {
    const { scope, opened } = fakeScope();
    const stream = createUserStream(scope);
    let told = 0;
    stream.onUnavailable(() => (told += 1));
    stream.on("state", () => {});
    opened[0].fail(0);
    assert.equal(stream.available, true, "a retrying stream stays available");
    opened[0].fail(2);
    assert.equal(stream.available, false);
    assert.equal(told, 1);
    stream.on("results", () => {});
    assert.equal(opened.length, 1, "a failed stream does not reopen by itself");
    stream.reset();
    assert.equal(stream.available, true);
    assert.equal(opened.length, 2);
    opened[0].fail(2);
    assert.equal(told, 1, "an old stream's error is ignored");
  });

  it("is unavailable without EventSource", () => {
    const stream = createUserStream({});
    let told = 0;
    stream.onUnavailable(() => (told += 1));
    stream.on("state", () => {});
    assert.equal(stream.available, false);
    stream.reset();
    assert.equal(stream.available, false);
    assert.equal(told, 0);
  });
});
