import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const origin = new URL(base);
if (!["http:", "https:"].includes(origin.protocol))
  throw new Error("SMOKE_BASE_URL must be an HTTP URL");

async function check(path: string, expectedStatus: number, includes: string) {
  const started = performance.now();
  const response = await fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  const body = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${path}: ${body.slice(0, 200)}`,
  );
  if (includes)
    assert.ok(body.includes(includes), `${path}: missing ${includes}`);
  return {
    path,
    status: response.status,
    milliseconds: Math.round(performance.now() - started),
  };
}

const results = [];
for (const [path, status, text] of [
  ["/ready", 200, '"ready"'],
  ["/", 200, "Join the arena."],
  ["/home", 200, "YAP ARENA"],
  ["/debates", 200, "Debates"],
  ["/assets/measurement.js", 200, "measurement"],
  ["/api/measurement/consent", 200, '"consented":false'],
  ["/api/measurement/dashboard", 401, "authentication"],
  ["/measurement", 401, ""],
] satisfies [string, number, string][]) {
  results.push(await check(path, status, text));
}
console.log(
  JSON.stringify({ at: new Date().toISOString(), base, results }, null, 2),
);
