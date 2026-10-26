import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// No .env or caller-supplied database URL is read. The existing isolation
// harness owns its own volume-free cluster and generates all credentials.
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const integrationOnly = process.argv.includes("--integration-only");
const mode = process.env.DATABASE_TEST_MODE ?? "docker";
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "CI"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`;
env.NODE_ENV = "test";
// A fixed locale keeps command output predictable and prevents macOS locale
// initialization from making the native PostgreSQL postmaster multithreaded.
env.LC_ALL = "C";
env.LANG = "C";
const directory = process.env.BROWSER_ARTIFACT_DIR
  ? resolve(process.env.BROWSER_ARTIFACT_DIR)
  : await mkdtemp(join(tmpdir(), "yaparena-browser-release-"));
await mkdir(directory, { recursive: true });
const steps: { name: string; status: string }[] = [];
let active: ChildProcess | undefined;
let interrupted = false;
function interrupt(signal: NodeJS.Signals) {
  interrupted = true;
  process.exitCode = 130;
  active?.kill(signal);
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function preflight() {
  assert.match(
    process.version,
    /^v24\./,
    "Use Node.js 24 (see README requirements)",
  );
  assert.ok(
    process.argv.slice(2).every((arg) => arg === "--integration-only"),
    "Only --integration-only is supported",
  );
  assert.ok(
    !integrationOnly || process.env.CI === "true",
    "--integration-only is reserved for CI, where the parallel quality / check job runs the full quality gate and account-security suites; run npm run verify:browser locally",
  );
  assert.ok(
    ["host", "docker"].includes(mode),
    "DATABASE_TEST_MODE must be docker (default) or host",
  );
  await access(join(root, "node_modules/typescript/bin/tsc"));
  const candidates = process.env.BROWSER_CHROME_PATH
    ? [process.env.BROWSER_CHROME_PATH]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      env.BROWSER_CHROME_PATH = candidate;
      break;
    } catch {
      /* Try the next installed Chromium binary. */
    }
  }
  assert.ok(
    env.BROWSER_CHROME_PATH,
    "Install Chrome/Chromium or set BROWSER_CHROME_PATH to its executable",
  );
  try {
    await exec("ffmpeg", ["-version"], { env });
  } catch {
    throw new Error(
      "Install FFmpeg and make ffmpeg available on PATH for synthetic replay previews",
    );
  }
  if (mode === "host") {
    assert.notEqual(
      process.getuid?.(),
      0,
      "Host initdb cannot run as root; use DATABASE_TEST_MODE=docker",
    );
    for (const command of ["pg_config", "initdb", "pg_ctl"]) {
      try {
        assert.match(
          (await exec(command, ["--version"], { env })).stdout,
          /PostgreSQL\)? (17|18)\./,
        );
      } catch {
        throw new Error(
          `Host mode requires PostgreSQL 17/18 ${command} on PATH; otherwise start Docker and use the default mode`,
        );
      }
    }
  } else {
    try {
      await exec("docker", ["version", "--format", "{{.Server.Version}}"], {
        env,
      });
    } catch {
      throw new Error(
        "Start a local Docker daemon, or install PostgreSQL 17/18 and use DATABASE_TEST_MODE=host",
      );
    }
  }
  env.DATABASE_TEST_MODE = mode;
  if (process.env.DATABASE_TEST_IMAGE)
    env.DATABASE_TEST_IMAGE = process.env.DATABASE_TEST_IMAGE;
  env.A4_BROWSER_REPETITIONS = process.env.A4_BROWSER_REPETITIONS ?? "2";
  assert.match(
    env.A4_BROWSER_REPETITIONS,
    /^[1-5]$/,
    "A4_BROWSER_REPETITIONS must be 1–5; default 2 independently creates both fixtures twice",
  );
}

async function run(
  name: string,
  command: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  assert.equal(interrupted, false, "verification interrupted");
  console.log(`Browser release gate: ${name}`);
  const step = { name, status: "running" };
  steps.push(step);
  // These children use synthetic data only. Do not print command arguments or
  // environment values. Isolation failures already withhold generated secrets.
  const code = await new Promise<number | null>((resolveCode, reject) => {
    active = spawn(command, args, {
      cwd: root,
      env: { ...env, ...extra },
      stdio: "inherit",
    });
    active.once("error", () =>
      reject(new Error(`${name}: could not start the local verifier`)),
    );
    active.once("close", (code) => resolveCode(code));
  });
  active = undefined;
  step.status = code === 0 ? "passed" : "failed";
  assert.equal(
    code,
    0,
    `${name} failed; inspect the assertion and synthetic artifacts`,
  );
}

try {
  console.log(`Synthetic browser artifacts: ${directory}`);
  await preflight();
  await run("build", "npm", ["run", "build"]);
  await run(
    "fresh/upgrade database isolation, A4 PostgreSQL and account/arena/shared-data browsers",
    process.execPath,
    ["scripts/verify-database-isolation.ts"],
    {
      A4_VERIFY: "true",
      // In CI, quality / check already runs the account-security suites and
      // treasury scenarios on fresh and upgrade databases; skip them here.
      ACCOUNT_SECURITY_VERIFY: integrationOnly ? "false" : "true",
      A4_BROWSER: "true",
      A4_QUALITY: integrationOnly ? "false" : "true",
      BROWSER_ARTIFACT_DIR: join(directory, "a4"),
    },
  );
  await run(
    "homepage navigation, interactions, responsive layout and accessibility",
    process.execPath,
    ["scripts/verify-homepage-browser.ts"],
    { HOMEPAGE_ARTIFACT_DIR: join(directory, "homepage") },
  );
  await run(
    "Live/replay preview playback and handoff",
    process.execPath,
    ["scripts/verify-hero-browser.ts"],
    { LIVE_ARTIFACT_DIR: join(directory, "live") },
  );
  await run(
    "Live AI outline panel with synthetic LiveKit messages",
    process.execPath,
    ["scripts/verify-outline-browser.ts"],
  );
  assert.equal(interrupted, false, "verification interrupted");
  console.log(`Browser release gate PASS. Synthetic evidence: ${directory}`);
} catch (error) {
  console.error(`Browser release gate FAILED: ${(error as Error).message}`);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(
      {
        status: process.exitCode ? "failed" : "passed",
        postgres: ["host", "docker"].includes(mode) ? mode : "invalid",
        quality: integrationOnly
          ? "full quality gate and account-security suites in the parallel quality / check job"
          : "full runtime-backed npm run check",
        steps,
        scope:
          "Disposable local PostgreSQL and synthetic browser/media fixtures; no hosted or physical-device acceptance",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
