// Measures Yap Coins submit latency under load (PR 2, audit item 6) against
// a disposable local PostgreSQL database. For each viewer count N, N signed-in
// viewers answer in one live turn window, each at a random moment in its last
// 10 seconds, while the worker settles a 120-hour reveal of REVEAL_ROUNDS
// rounds holding REVEAL_ORDERS orders each. The submits share one pool the
// size of a web instance's; the worker has its own, as in production.
//
//   npm run build
//   COIN_LOAD_OWNER_URL=postgresql://yaparena_owner:…@127.0.0.1:PORT/DB \
//   COIN_LOAD_RUNTIME_URL=postgresql://yaparena_runtime:…@127.0.0.1:PORT/DB \
//   node scripts/measure-coin-load.ts 50 200 500
//
// Optional: COIN_LOAD_REVEAL_ROUNDS (default 20; 0 measures the submits
// alone), COIN_LOAD_REVEAL_ORDERS (default 1001, a full round),
// COIN_LOAD_BURST_SECONDS (default 10) and COIN_LOAD_POOL (default 10). It
// creates synthetic accounts, debates and valueless treasury seeds, so use a
// migrated database you will delete; it refuses any host but loopback.
// Results are local measurements, not hosted capacity evidence.
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createCoinDebateSandbox,
  SETTLEMENT_BATCH,
} from "../dist/features/account-wallet/debate-sandbox.js";
import {
  createCoinSandboxOperatorRepository,
  createCoinSandboxRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";

function loopback(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname))
    throw new Error(`${name} must point at a local disposable database`);
  return value;
}
function count(name: string, fallback: number, maximum: number, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
const viewerCounts = (
  process.argv.length > 2 ? process.argv.slice(2) : ["50", "200", "500"]
).map((value) => {
  const viewers = Number(value);
  if (!Number.isInteger(viewers) || viewers < 1 || viewers > 1000)
    throw new Error("viewer counts must be integers from 1 to 1000");
  return viewers;
});
// 0 measures the submits alone.
const revealRounds = count("COIN_LOAD_REVEAL_ROUNDS", 20, 100, 0);
const revealOrders = count("COIN_LOAD_REVEAL_ORDERS", 1001, 1001);
const poolSize = count("COIN_LOAD_POOL", 10, 100);
// How long before the cutoff the answers start arriving. The default is the
// last 10 seconds; 45 spreads them over most of a minute, when a reveal
// settles at full pace.
const burstSeconds = count("COIN_LOAD_BURST_SECONDS", 10, 50);
const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
const owner = new pg.Pool({
  ...options,
  connectionString: loopback("COIN_LOAD_OWNER_URL"),
  max: 8,
});
const runtimeUrl = loopback("COIN_LOAD_RUNTIME_URL");
const web = new pg.Pool({
  ...options,
  connectionString: runtimeUrl,
  max: poolSize,
});
const workerPool = new pg.Pool({
  ...options,
  connectionString: runtimeUrl,
  max: 2,
});
const setupPool = new pg.Pool({
  ...options,
  connectionString: runtimeUrl,
  max: 10,
});
const sandbox = createCoinSandboxRepository(setupPool, { rail: "simulation" });
const operator = createCoinSandboxOperatorRepository(owner, {
  rail: "simulation",
});
// The setup places reveal orders through the same API, without turn windows.
const setup = createCoinDebateSandbox(setupPool, "simulation");
const debates = createCoinDebateSandbox(web, "simulation", {
  turnWindows: true,
});
const worker = createCoinDebateSandbox(workerPool, "simulation", {
  turnWindows: true,
  logger: { error: (_details, message) => console.error(message) },
});

interface Viewer {
  userId: string;
  sessionTokenHash: string;
}
const elapsed = (start: number) => Math.round(performance.now() - start);
// Runs work over items with at most `limit` in flight.
async function each<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index]!, index);
      }
    }),
  );
}
async function accounts(total: number) {
  const users = (
    await owner.query<{ id: string; auth_generation: string }>(
      "INSERT INTO users SELECT FROM generate_series(1,$1) RETURNING id,auth_generation",
      [total],
    )
  ).rows;
  const sessions = createSessionRepository(setupPool);
  const viewers: Viewer[] = [];
  await each(users, 10, async (user) => {
    const token = createSessionToken();
    await sessions.create(
      user.id,
      token.tokenHash,
      new Date(Date.now() + 6 * 3600_000),
      { authGeneration: user.auth_generation },
    );
    const viewer = { userId: user.id, sessionTokenHash: token.tokenHash };
    await sandbox.initialize(viewer);
    viewers.push(viewer);
  });
  return viewers;
}
async function topic() {
  return (
    await owner.query<{ id: string }>(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Load trial','Synthetic load fixture','Support','Oppose','published') RETURNING id",
      [`coin-load-${randomUUID()}`],
    )
  ).rows[0]!.id;
}
async function debate(topicId: string, status: string) {
  return (
    await owner.query<{ id: string }>(
      `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,
        rules_snapshot,live_started_at,is_demo)
      VALUES($1,$2,'Should this load trial pass?',$3,'published','preview-1',
        '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":3600}',
        clock_timestamp(),true) RETURNING id`,
      [`coin-load-${randomUUID()}`, topicId, status],
    )
  ).rows[0]!.id;
}
const order = (quantity: number) => {
  const side = Math.random() < 0.5 ? ("YES" as const) : ("NO" as const);
  const read = 20 + Math.floor(Math.random() * 60);
  return { side, limit: (read / 100).toFixed(2), quantity };
};
// REVEAL_ROUNDS five-day manual rounds, each on its own debate, filled with
// REVEAL_ORDERS orders while open, then made due: cutoff passed and the
// debate ended 120 hours ago.
async function reveal(topicId: string, viewers: readonly Viewer[]) {
  const started = performance.now();
  const rounds: string[] = [];
  if (!revealRounds) return rounds;
  for (let index = 0; index < revealRounds; index++) {
    const debateId = await debate(topicId, "live");
    const round = await setup.create(viewers[0]!, debateId, randomUUID());
    rounds.push(round.id);
    await each(viewers.slice(0, revealOrders), 10, async (viewer) => {
      await setup.submit(viewer, round.id, randomUUID(), order(1));
    });
  }
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
    );
    await client.query(
      "UPDATE coin_debate_rounds SET opens_at=clock_timestamp()-INTERVAL '2 minutes',closes_at=clock_timestamp()-INTERVAL '1 minute' WHERE id=ANY($1::uuid[])",
      [rounds],
    );
    await client.query(
      "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
    );
    await client.query(
      "UPDATE debates SET status='ended',live_started_at=clock_timestamp()-INTERVAL '122 hours',live_ended_at=clock_timestamp()-INTERVAL '121 hours' WHERE id IN (SELECT debate_id FROM coin_debate_rounds WHERE id=ANY($1::uuid[]))",
      [rounds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(
    `  reveal ready: ${revealRounds} rounds x ${revealOrders} orders in ${(elapsed(started) / 1000).toFixed(0)} s`,
  );
  return rounds;
}
// A live debate whose turn ends `seconds` from now, with its window open.
async function liveWindow(topicId: string, seconds: number) {
  const debateId = await debate(topicId, "live");
  await owner.query(
    `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
      remaining_ms,active_ms,last_resumed_at,recording_status)
    VALUES($1,'running','A',1,clock_timestamp()+make_interval(secs=>$2),$3,0,clock_timestamp(),'recording')`,
    [debateId, seconds, seconds * 1000],
  );
  await worker.openTurnWindows(1, [debateId]);
  const row = (
    await owner.query<{ id: string; closes_at: Date }>(
      "SELECT id,closes_at FROM coin_debate_rounds WHERE debate_id=$1",
      [debateId],
    )
  ).rows[0]!;
  return { debateId, windowId: row.id, closesAt: row.closes_at.getTime() };
}
const percentile = (sorted: readonly number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
    : 0;

async function trial(viewerCount: number, viewers: readonly Viewer[]) {
  console.log(`N = ${viewerCount}`);
  const topicId = await topic();
  const rounds = await reveal(topicId, viewers);
  const window = await liveWindow(topicId, burstSeconds + 15);
  // The worker's loop: one tick a second, never overlapping.
  let working = true;
  const settledAt: number[] = [];
  const burstStart = window.closesAt - burstSeconds * 1000;
  const workerLoop = (async () => {
    while (working) {
      const tick = performance.now();
      if (Date.now() >= burstStart) {
        await worker.tick().catch((error: unknown) => {
          console.error(
            `  worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        const settled = (
          await owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM coin_debate_rounds WHERE id=ANY($1::uuid[]) AND state='settled'",
            [rounds],
          )
        ).rows[0]!.n;
        settledAt.push(settled);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 1000 - (performance.now() - tick))),
      );
    }
  })();
  const latencies: number[] = [];
  const outcomes = new Map<string, number>();
  const participants = viewers.slice(0, viewerCount);
  await Promise.all(
    participants.map(async (viewer) => {
      const at = burstStart + Math.random() * (burstSeconds * 1000 - 200);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, at - Date.now())),
      );
      const started = performance.now();
      const outcome = await debates
        .submit(
          viewer,
          window.windowId,
          randomUUID(),
          order(1 + Math.floor(Math.random() * 10)),
        )
        .then(
          () => "placed",
          (error: unknown) =>
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : error instanceof Error
                ? error.message
                : "failed",
        );
      latencies.push(elapsed(started));
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    }),
  );
  // Let the reveal finish, up to three minutes after the burst, so the next
  // trial starts without a backlog.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && (settledAt.at(-1) ?? 0) < rounds.length)
    await new Promise((resolve) => setTimeout(resolve, 500));
  working = false;
  await workerLoop;
  const sorted = [...latencies].sort((a, b) => a - b);
  const duringBurst = settledAt.slice(0, burstSeconds).at(-1) ?? 0;
  console.log(
    `  submits: ${latencies.length}; ${[...outcomes]
      .map(([outcome, total]) => `${outcome} ${total}`)
      .join(", ")}`,
  );
  console.log(
    `  latency ms: p50 ${percentile(sorted, 0.5)}, p95 ${percentile(sorted, 0.95)}, max ${sorted.at(-1) ?? 0}`,
  );
  console.log(
    `  reveal: ${duringBurst}/${rounds.length} rounds revealed during the answers, ${settledAt.at(-1) ?? 0}/${rounds.length} after ${settledAt.length} worker ticks (seconds)`,
  );
  return {
    viewers: viewerCount,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    outcomes: Object.fromEntries(outcomes),
    revealSettledDuringBurst: duringBurst,
    revealSettled: settledAt.at(-1) ?? 0,
  };
}

try {
  console.log(
    `Pool ${poolSize}; answers over the last ${burstSeconds} s; reveal ${revealRounds} x ${revealOrders} orders; settlement batches of ${SETTLEMENT_BATCH.rounds} rounds / ${SETTLEMENT_BATCH.orders} orders (${SETTLEMENT_BATCH.quietOrders} in a window's last ${SETTLEMENT_BATCH.quietSeconds} s)`,
  );
  const started = performance.now();
  const viewers = await accounts(Math.max(revealOrders, ...viewerCounts));
  const seed = viewers[0]!;
  for (const purpose of ["center", "promotional"] as const)
    await operator.seedSandboxTreasury({
      userId: seed.userId,
      purpose,
      amount: "1000000000000",
      idempotencyKey: randomUUID(),
    });
  console.log(
    `  ${viewers.length} accounts with welcome grants in ${(elapsed(started) / 1000).toFixed(0)} s`,
  );
  const results = [];
  for (const viewerCount of viewerCounts)
    results.push(await trial(viewerCount, viewers));
  console.log(JSON.stringify(results));
} finally {
  await Promise.all([
    owner.end(),
    web.end(),
    workerPool.end(),
    setupPool.end(),
  ]);
}
