import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { exitOnCrash } from "../dist/platform/process-crash.js";

const secret = "synthetic-crash-credential";
const exec = promisify(execFile);

function fakeProcess() {
  const target = new EventEmitter();
  target.exits = [];
  target.exit = (code) => target.exits.push(code);
  return target;
}

function fakeLogger() {
  const entries = [];
  return {
    entries,
    fatal: (fields, message) =>
      entries.push({ level: "fatal", fields, message }),
    error: (fields, message) =>
      entries.push({ level: "error", fields, message }),
  };
}

const settled = () => new Promise(setImmediate);

describe("process crash handling", () => {
  for (const [event, origin] of [
    ["uncaughtException", "uncaughtException"],
    ["unhandledRejection", "unhandledRejection"],
  ])
    it(`logs an ${event}, stops once and exits with status 1`, async () => {
      const target = fakeProcess();
      const logger = fakeLogger();
      let stops = 0;
      exitOnCrash({
        logger,
        target,
        stop: async () => {
          stops++;
        },
      });
      const error = new Error(secret);
      if (event === "uncaughtException") target.emit(event, error, origin);
      else target.emit(event, error, Promise.resolve());
      assert.equal(target.exitCode, 1);
      await settled();
      assert.equal(stops, 1);
      assert.deepEqual(target.exits, [1]);
      assert.deepEqual(logger.entries, [
        {
          level: "fatal",
          fields: { error, origin },
          message: "process crashed",
        },
      ]);
    });

  it("logs a second crash without starting a second stop", async () => {
    const target = fakeProcess();
    const logger = fakeLogger();
    let stops = 0;
    let finish;
    exitOnCrash({
      logger,
      target,
      stop: () => {
        stops++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    target.emit("uncaughtException", new Error("first"), "uncaughtException");
    target.emit("unhandledRejection", new Error("second"), Promise.resolve());
    await settled();
    assert.equal(stops, 1);
    assert.deepEqual(target.exits, []);
    assert.equal(logger.entries.length, 2);
    finish();
    await settled();
    assert.deepEqual(target.exits, [1]);
  });

  it("logs a failed stop and still exits", async () => {
    const target = fakeProcess();
    const logger = fakeLogger();
    const failure = new Error("stop failed");
    exitOnCrash({
      logger,
      target,
      stop: () => {
        throw failure;
      },
    });
    target.emit("uncaughtException", new Error("crash"), "uncaughtException");
    await settled();
    assert.deepEqual(logger.entries[1], {
      level: "error",
      fields: { error: failure },
      message: "shutdown after crash failed",
    });
    assert.deepEqual(target.exits, [1]);
  });

  it("exits at the deadline when the stop never finishes", async () => {
    const target = fakeProcess();
    exitOnCrash({
      logger: fakeLogger(),
      target,
      deadlineMs: 5,
      stop: () => new Promise(() => {}),
    });
    target.emit("uncaughtException", new Error("crash"), "uncaughtException");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(target.exits, [1]);
  });

  // Real processes with the real logger: the crash reaches stdout as one safe
  // record, and Node's default handler never prints the raw error to stderr.
  for (const [kind, crash] of [
    ["an unhandled rejection", `void Promise.reject(new Error(secret));`],
    [
      "an uncaught exception",
      `setTimeout(() => { throw new Error(secret); });`,
    ],
    ["a failed top-level await", `await Promise.reject(new Error(secret));`],
  ])
    it(`exits with status 1 and a credential-safe record after ${kind}`, async () => {
      const script = `
        import { createLogger } from ${JSON.stringify(new URL("../dist/platform/logger.js", import.meta.url).href)};
        import { exitOnCrash } from ${JSON.stringify(new URL("../dist/platform/process-crash.js", import.meta.url).href)};
        const secret = ${JSON.stringify(secret)};
        const logger = createLogger();
        exitOnCrash({ logger, stop: async () => logger.info("stopped") });
        setInterval(() => {}, 1000);
        ${crash}
      `;
      const failure = await exec(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { timeout: 10_000 },
      ).then(
        () => assert.fail("the crashed process must exit with an error"),
        (error) => error,
      );
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout.includes(secret), false);
      assert.equal(failure.stderr.includes(secret), false);
      const records = failure.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      // pino writes the crash record asynchronously and this stop is instant,
      // so the exit flush can write "stopped" before that write lands.
      assert.deepEqual(records.map(({ msg }) => msg).sort(), [
        "process crashed",
        "stopped",
      ]);
      const crashed = records.find(({ msg }) => msg === "process crashed");
      assert.equal(crashed.level, 60);
      assert.match(
        crashed.origin,
        /^(?:uncaughtException|unhandledRejection)$/,
      );
      assert.equal(crashed.error.redacted, true);
      assert.equal(crashed.error.type, "Error");
    });
});
