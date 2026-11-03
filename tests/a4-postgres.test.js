import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import request from "../scripts/test-http-request.ts";
import {
  createA4Repository,
  runConfig,
} from "../dist/features/a4/repository.js";
import {
  createPublicBotRepository,
  simulationArguments,
  syntheticRound,
} from "../dist/features/a4/public-bots.js";
import {
  account,
  post,
  transfer,
  reconcile,
} from "../dist/features/a4/ledger.js";
import { createDatabase } from "../dist/platform/database.js";
import { createLogger } from "../dist/platform/logger.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
import { createApp } from "../dist/app.js";
import { createMessageRepository } from "../dist/features/messages/repository.js";
const enabled = !!process.env.A4_TEST_DATABASE_URL;
if (enabled) {
  const runtime = new URL(process.env.A4_TEST_DATABASE_URL),
    owner = new URL(process.env.A4_TEST_OWNER_URL);
  for (const url of [runtime, owner]) {
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname),
      "A4 tests require a local disposable database",
    );
    assert.match(
      url.pathname,
      /^\/(?:revocation_test|yaparena_a4_test)[a-z0-9_]*$/,
    );
  }
  assert.equal(runtime.host, owner.host);
  assert.equal(runtime.pathname, owner.pathname);
  assert.equal(runtime.username, "yaparena_runtime");
  assert.equal(owner.username, "yaparena_owner");
}
const logger = createLogger({ enabled: false });
let pool, owner, a4, sessions, debateId, topicId;
const key = () => randomUUID();
async function actor() {
  const u = (
    await pool.query(
      `INSERT INTO users DEFAULT VALUES
       RETURNING id,auth_generation AS "authGeneration"`,
    )
  ).rows[0];
  const token = createSessionToken();
  await sessions.create(u.id, token.tokenHash, new Date(Date.now() + 3600000), {
    authGeneration: u.authGeneration,
  });
  return {
    userId: u.id,
    tokenHash: token.tokenHash,
    cookie: `session=${token.token}`,
  };
}
async function run(a, config = {}, mode = "mixed", extra = {}) {
  const result = await a4.create(a, key(), {
    debateId,
    mode,
    config: { population: 10, roundSeconds: 60, ...config },
    ...extra,
  });
  return a4.view(a, result.id);
}
async function roundState(a, id) {
  return (await a4.view(a, id)).rounds[0];
}
async function finish(id) {
  await owner.query(
    "UPDATE a4_rounds SET closes_at=clock_timestamp()-INTERVAL '1 second',opens_at=clock_timestamp()-INTERVAL '2 seconds' WHERE session_id=$1 AND state IN ('scheduled','open')",
    [id],
  );
  await owner.query(
    "UPDATE a4_sessions SET reveal_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [id],
  );
  for (let i = 0; i < 35; i++) {
    await a4.tick();
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM a4_rounds WHERE session_id=$1 AND state NOT IN ('settled','void')",
      [id],
    );
    if (r.rows[0].n === 0) return;
  }
  throw new Error("round did not finish");
}
async function terminal(a, id) {
  await a4.control(a, key(), id, "archive");
}
// Decision 0010 froze ordinary YAP play, so a human run can only exist as
// history from before the freeze. Owner SQL writes one the way the engine
// left it; its ledger rows are not needed by the reads under test. Open
// rounds close a day away so the shared A4 clock never processes them.
async function retiredHumanRun(creator, { label, orders = [], open = false }) {
  const session = randomUUID(),
    round = randomUUID();
  await owner.query(
    `INSERT INTO a4_sessions(id,creator_id,debate_id,asset,mode,state,config,seed,reveal_at,proposition,topic_id)
    VALUES($1,$2,$3,'YAP','human',$4,$5,'retired-run-seed',clock_timestamp()+$6::interval,'Should this synthetic proposition be endorsed?',$7)`,
    [
      session,
      creator.userId,
      debateId,
      open ? "running" : "complete",
      JSON.stringify(runConfig({ argumentLabel: label }, true)),
      open ? "1 day" : "-1 hour",
      topicId,
    ],
  );
  await owner.query(
    `INSERT INTO a4_rounds(id,session_id,asset,period,state,opens_at,closes_at,seed,seed_commitment,snapshot,pricing,revealed_at)
    VALUES($1,$2,'YAP',1,$3,clock_timestamp()-interval '2 hours',clock_timestamp()+$4::interval,'retired-round-seed','retired-commitment',$5,$6,$7)`,
    [
      round,
      session,
      open ? "open" : "settled",
      open ? "1 day" : "-1 hour",
      open ? null : JSON.stringify([]),
      open
        ? null
        : JSON.stringify({
            a: { n: "0", d: "1" },
            b: { n: "1", d: "1" },
            share: { n: "1", d: "2" },
            price: { n: "1", d: "2" },
            branch: "targeted",
            reason: null,
          }),
      open ? null : new Date(Date.now() - 1800000),
    ],
  );
  for (const order of orders)
    await owner.query(
      `INSERT INTO a4_submissions(round_id,asset,participant,user_id,kind,side,limit_value,quantity,request_key,outcome)
      VALUES($1,'YAP',$2,$3,'human',$4,$5,1,$6,$7)`,
      [
        round,
        `user:${order.actor.userId}`,
        order.actor.userId,
        order.side,
        order.limit,
        key(),
        // The engine stores each outcome with its participant.
        JSON.stringify({
          participant: `user:${order.actor.userId}`,
          executed: true,
          accepted: true,
          status: "pending",
          premium: order.premium,
        }),
      ],
    );
  return { session, round };
}
function app(repo = a4) {
  return createApp({
    a4: repo,
    sessions,
    messages: createMessageRepository(pool),
    logger,
    environment: "test",
    apiRateLimit: 100000,
  });
}
const command = (app, a, path, body, k = key()) =>
  request(app)
    .post(`/api/a4/${path}`)
    .set("Cookie", a.cookie)
    .set("Idempotency-Key", k)
    .send(body);
describe(
  "A4 runtime-role PostgreSQL",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
      const tag = key();
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'A4 test topic','Synthetic A4 fixture topic','Support','Oppose','published') RETURNING id",
          [`a4-${tag}`],
        )
      ).rows[0].id;
      debateId = (
        await owner.query(
          "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) VALUES($1,$2,'Should this synthetic proposition be endorsed?','scheduled','published','preview-1','{}') RETURNING id",
          [`a4-${tag}`, topicId],
        )
      ).rows[0].id;
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });
    it("shares only consented settled mixed/observer aggregates, excludes hidden/future/private data and follows new rounds automatically", async () => {
      const a = await actor(),
        b = await actor(),
        publicBots = createPublicBotRepository(pool);
      const mixed = await run(a, { argumentLabel: "Public cost analysis" }),
        other = await run(b);
      await a4.submit(a, key(), mixed.rounds[0].id, {
        side: "YES",
        limit: "0.5",
        quantity: 1,
        rule: mixed.config.rule,
      });
      await finish(mixed.id);
      await finish(other.id);
      assert.equal((await publicBots.debate(debateId)).items.length, 0);
      await a4.publication(a, true);
      await a4.publication(a, true);
      const first = await publicBots.debate(debateId);
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0].id, mixed.rounds[0].id);
      assert.equal(first.items[0].humans, 1);
      assert.equal(first.items[0].argumentLabel, "Public cost analysis");
      assert.equal(first.items[0].runId, null);
      assert.equal(JSON.stringify(first).includes(a.userId + "@"), false);
      assert.equal("balances" in first, false);
      const observer = await run(a, {}, "observer");
      assert.equal(
        (await publicBots.debate(debateId)).revision,
        first.revision,
      );
      await finish(observer.id);
      const next = await publicBots.debate(debateId);
      assert.equal(next.items.length, 2);
      assert.equal(next.items.at(-1).mode, "observer");
      assert.notEqual(next.revision, first.revision);
      await owner.query(
        "UPDATE a4_sessions SET reveal_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [observer.id],
      );
      assert.equal((await publicBots.debate(debateId)).items.length, 1);
      await owner.query(
        "UPDATE a4_sessions SET reveal_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [observer.id],
      );
      const catalog = simulationArguments("Should transport be free?");
      await owner.query(
        "INSERT INTO a4_synthetic_debates(debate_id,arguments,category) VALUES($1,$2,$3)",
        [debateId, JSON.stringify(catalog.arguments), catalog.category],
      );
      await owner.query(
        "INSERT INTO a4_synthetic_rounds(id,debate_id,seed_key,simulated_at,seed,result) VALUES($1,$2,$3,clock_timestamp()-interval '1 day','seed',$4)",
        [key(), debateId, key(), JSON.stringify(syntheticRound("seed", 1, 20))],
      );
      const seeded = await publicBots.debate(debateId);
      assert.equal(seeded.items.length, 3);
      assert.equal(seeded.arguments.length, 6);
      assert.equal(seeded.items[0].mode, "seed");
      assert.equal(
        (await publicBots.topics([topicId]))[topicId].items.length,
        3,
      );
      await a4.publication(a, false);
      assert.equal((await publicBots.debate(debateId)).items.length, 1);
      await owner.query(
        "UPDATE debates SET publication_state='hidden' WHERE id=$1",
        [debateId],
      );
      assert.equal(await publicBots.debate(debateId), null);
      assert.equal(
        (await publicBots.topics([topicId]))[topicId].items.length,
        0,
      );
      await owner.query(
        "UPDATE debates SET publication_state='published' WHERE id=$1",
        [debateId],
      );
      await request(app()).get("/api/a4/publication").expect(401);
      await command(app(), a, "publication", { published: "yes" }).expect(400);
      await command(app(), a, "publication", { published: true }).expect(200);
      assert.equal((await a4.publication(a)).published, true);
      await a4.publication(a, false);
      await assert.rejects(
        pool.query(
          "INSERT INTO a4_synthetic_debates(debate_id,arguments,category) VALUES($1,'[]','Ideas')",
          [key()],
        ),
        (error) => error.code === "42501",
      );
    });
    it("charts only finalized settlements, separates private creators and excludes observer/pending information", async () => {
      const a = await actor(),
        b = await actor();
      const first = await run(a, {
          population: 10,
          argumentLabel: "Cost analysis",
        }),
        other = await run(b, { population: 10 });
      assert.deepEqual((await a4.timeline(a, debateId, "sandbox")).items, []);
      await a4.control(a, key(), first.id, "step");
      assert.deepEqual((await a4.timeline(a, debateId, "sandbox")).items, []);
      await finish(first.id);
      await finish(other.id);
      const own = await a4.timeline(a, debateId, "sandbox");
      assert.equal(own.items.length, 1);
      assert.equal(own.items[0].runId, first.id);
      assert.equal(own.items[0].bots, 10);
      assert.equal(own.items[0].argumentLabel, "Cost analysis");
      assert.equal(own.items[0].ownLimit, null);
      const actual = (await a4.view(a, first.id)).rounds[0].diagnostics.pricing;
      assert.deepEqual(own.items[0].medianNo, actual.a);
      assert.deepEqual(own.items[0].medianYes, actual.b);
      assert.deepEqual(own.items[0].offer, actual.price);
      assert.equal(own.totals.botCommitments, 10);
      assert.deepEqual((await a4.timeline(a, debateId, "human")).items, []);
      assert.equal(
        (await a4.timeline(b, debateId, "sandbox")).items[0].runId,
        other.id,
      );
      const observer = await run(a, { population: 10 }, "observer");
      await finish(observer.id);
      assert.equal((await a4.timeline(a, debateId, "sandbox")).items.length, 1);
      // Human charts now show retired YAP play history only.
      await retiredHumanRun(a, {
        label: "Pilot studies",
        orders: [
          { actor: a, side: "YES", limit: "1", premium: "500001" },
          { actor: b, side: "NO", limit: "0", premium: "500000" },
        ],
      });
      const settled = await a4.timeline(b, debateId, "human");
      assert.equal(settled.items.length, 1);
      assert.equal(settled.items[0].humans, 2);
      assert.equal(settled.items[0].bots, 0);
      assert.deepEqual(settled.items[0].share, { n: "1", d: "2" });
      assert.equal(settled.items[0].argumentLabel, "Pilot studies");
      assert.equal(settled.items[0].ownLimit, "0");
      assert.equal(
        (await a4.timeline(a, debateId, "human")).items[0].ownLimit,
        "1",
      );
      assert.equal(settled.totals.premium, "1000001");
      for (const item of settled.items)
        for (const secret of [
          "seed",
          "snapshot",
          "user_id",
          "pricing",
          "outcome",
          "payout",
          "net",
        ])
          assert.equal(item[secret], undefined);
      await owner.query(
        "UPDATE topics SET publication_state='draft' WHERE id=$1",
        [topicId],
      );
      try {
        await assert.rejects(
          a4.timeline(a, debateId, "human"),
          /debate not found/,
        );
      } finally {
        await owner.query(
          "UPDATE topics SET publication_state='published' WHERE id=$1",
          [topicId],
        );
      }
    });
    it("uses actual sessions, persistent starter credit, binding review and idempotent receipts", async () => {
      const a = await actor(),
        api = app();
      assert.equal((await request(api).get("/api/a4/wallet")).status, 401);
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            config: { population: 10 },
          })
        ).status,
        201,
      );
      const list = (
        await request(api).get("/api/a4/runs").set("Cookie", a.cookie)
      ).body;
      const id = list.items[0].id,
        v = await a4.view(a, id),
        r = v.rounds[0];
      assert.equal(
        v.balances.find((b) => b.kind === "available").amount,
        "1000000000",
      );
      const b = {
          side: "NO",
          ceiling: "0.78",
          quantity: 10,
          rule: "a4-v1",
          accountId: a.userId,
        },
        k = key();
      const receipt = await command(api, a, `rounds/${r.id}/submit`, b, k);
      assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
      assert.equal(receipt.body.limit, "0.220000");
      assert.deepEqual(
        (await command(api, a, `rounds/${r.id}/submit`, b, k)).body,
        receipt.body,
      );
      assert.equal(
        (
          await command(
            api,
            a,
            `rounds/${r.id}/submit`,
            { ...b, quantity: 11 },
            k,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${r.id}/submit`, {
            ...b,
            accountId: "999999",
          })
        ).status,
        409,
      );
      assert.equal(
        (await command(api, a, `rounds/${r.id}/submit`, b)).status,
        409,
      );
      const recovered = await createA4Repository(pool, "bots").view(a, id);
      assert.equal(recovered.rounds[0].receipt.reserved, "10000000");
      assert.equal(recovered.rounds[0].diagnostics, undefined);
      await finish(id);
      assert.equal((await a4.view(a, id)).state, "complete");
      assert.ok(
        ["settled", "limit_not_met", "no_opposite"].includes(
          (await a4.view(a, id)).rounds[0].receipt.status,
        ),
      );
      const hist = await a4.history(a);
      assert.ok(hist.items.some((i) => i.kind === "settlement"));
      assert.ok(hist.items.every((i) => !("metadata" in i)));
    });
    it("handles 500 bots, separate center funding, observer access and paginated books", async () => {
      const a = await actor(),
        started = performance.now();
      const v = await run(a, { population: 500 }, "observer", {
        seed: "500-bot-replay",
      });
      assert.equal(v.observer, true);
      assert.equal(v.rounds[0].diagnostics.totals.bots, 500);
      assert.equal(v.rounds[0].diagnostics.totals.humans, 0);
      assert.equal(v.rounds[0].diagnostics.book.length, 50);
      assert.equal(v.rounds[0].diagnostics.pagination.hasMore, true);
      await assert.rejects(
        a4.submit(a, key(), v.rounds[0].id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /observer/,
      );
      await assert.rejects(a4.refill(a, key(), v.id), /observer/);
      const other = await actor();
      await assert.rejects(a4.view(other, v.id), /not found/);
      assert.equal(
        (await a4.list(other)).items.some((i) => i.id === v.id),
        false,
      );
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      const d = (await a4.view(a, v.id, 50, 10)).rounds[0].diagnostics;
      assert.equal(d.book.length, 10);
      assert.equal(d.pagination.offset, 50);
      assert.ok(d.totals.executed >= 0);
      await finish(v.id);
      assert.equal((await a4.view(a, v.id)).state, "complete");
      const c = await pool.connect();
      try {
        assert.deepEqual(await reconcile(c, v.id), { reconciled: true });
      } finally {
        c.release();
      }
      console.log(
        JSON.stringify({
          scenario: "500 bots",
          createAndSettleMs: Math.round(performance.now() - started),
          population: 500,
          asset: "YAP",
        }),
      );
    });
    it("keeps two distinct delayed shares, payouts and aggregate diagnostics sealed until T", async () => {
      const a = await actor(),
        v = await run(a, {
          population: 5,
          periods: 2,
          delayed: true,
          feeBps: 500,
        });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 2,
        rule: "a4-v1",
      });
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      let sealed = await a4.view(a, v.id);
      assert.equal(sealed.rounds[0].state, "pending");
      assert.equal(sealed.rounds[0].diagnostics, undefined);
      assert.equal(sealed.rounds[0].receipt.payout, undefined);
      assert.equal(sealed.rounds[0].receipt.net, undefined);
      assert.equal(sealed.researchSeed, undefined);
      const before = sealed.balances.find((b) => b.kind === "available").amount;
      // Restart/second process recovers the same committed price and posts no early payout.
      const originalOffer = sealed.rounds[0].offer;
      await createA4Repository(pool, "bots").tick();
      sealed = await a4.view(a, v.id);
      assert.equal(
        sealed.balances.find((b) => b.kind === "available").amount,
        before,
      );
      assert.deepEqual(sealed.rounds[0].offer, originalOffer);
      assert.equal(
        (await a4.history(a)).items.some((i) => i.kind === "settlement"),
        false,
      );
      await a4.control(a, key(), v.id, "step");
      const counts = await owner.query(
        "SELECT round_id,count(*) FILTER(WHERE side='YES')::int AS yes FROM a4_submissions WHERE round_id=ANY($1::uuid[]) GROUP BY round_id",
        [v.rounds.map((r) => r.id)],
      );
      const previousYes = counts.rows.find(
        (r) => r.round_id === v.rounds[0].id,
      ).yes;
      const nextYes = counts.rows.find(
        (r) => r.round_id === v.rounds[1].id,
      ).yes;
      await a4.submit(a, key(), v.rounds[1].id, {
        side: previousYes === nextYes + 1 ? "NO" : "YES",
        limit: "0.5",
        quantity: 1,
        rule: "a4-v1",
      });
      await finish(v.id);
      const final = await a4.view(a, v.id);
      assert.ok(final.rounds.every((r) => r.revealed));
      const stored = await pool.query(
        "SELECT pricing FROM a4_rounds WHERE session_id=$1 ORDER BY period",
        [v.id],
      );
      assert.notDeepEqual(
        stored.rows[0].pricing.share,
        stored.rows[1].pricing.share,
      );
      assert.equal(
        final.rounds[0].diagnostics.pricing.share.n,
        stored.rows[0].pricing.share.n,
      );
      assert.equal(
        final.rounds[1].diagnostics.pricing.share.n,
        stored.rows[1].pricing.share.n,
      );
    });
    it("serializes same-account commitments across sessions and prevents overspending", async () => {
      const a = await actor();
      const one = await run(a, { population: 2 });
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          a4.submit(a, key(), one.rounds[0].id, {
            side: "YES",
            limit: "1",
            quantity: 100,
            rule: "a4-v1",
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const count = (
        await pool.query(
          "SELECT count(*)::int AS n FROM a4_submissions WHERE round_id=$1 AND user_id=$2",
          [one.rounds[0].id, a.userId],
        )
      ).rows[0].n;
      assert.equal(count, 1);
      const a2 = { ...a, tokenHash: createSessionToken().tokenHash };
      await assert.rejects(
        a4.submit(a2, key(), one.rounds[0].id, {
          side: "NO",
          limit: "0",
          quantity: 1,
          rule: "a4-v1",
        }),
        /session/,
      );
      await finish(one.id);
    });
    it("rechecks cutoff after ledger lock waits, immediately at cutoff and with stale sessions", async () => {
      const a = await actor(),
        v = await run(a, { population: 2 }),
        r = v.rounds[0];
      const blocker = await owner.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`a4-ledger:${v.id}`],
      );
      await owner.query(
        "UPDATE a4_rounds SET closes_at=clock_timestamp()+INTERVAL '0.2 second',opens_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
        [r.id],
      );
      const pending = assert.rejects(
        a4.submit(a, key(), r.id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /cutoff/,
      );
      await delay(300);
      await blocker.query("COMMIT");
      blocker.release();
      await pending;
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM a4_submissions WHERE round_id=$1 AND user_id=$2",
            [r.id, a.userId],
          )
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        a4.submit(a, key(), r.id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /cutoff/,
      );
      await endAllAccountSessions(pool, a.userId);
      await assert.rejects(a4.refill(a, key(), v.id), /session/);
      await finish(v.id);
    });
    it("makes refill and controls idempotent and archives only the selected sandbox", async () => {
      const a = await actor(),
        v = await run(a, { population: 5 }),
        second = await run(a, { population: 2 });
      const k = key();
      const first = await a4.refill(a, k, v.id);
      assert.equal(first.issued, true);
      assert.deepEqual(await a4.refill(a, k, v.id), first);
      assert.equal((await a4.refill(a, key(), v.id)).issued, false);
      assert.equal(
        (await a4.view(a, second.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "1000000000",
      );
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 100,
        rule: "a4-v1",
      });
      await a4.control(a, key(), v.id, "pause");
      await assert.rejects(
        a4.submit(a, key(), v.rounds[0].id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /paused/,
      );
      await a4.control(a, key(), v.id, "speed", 20);
      assert.equal((await a4.view(a, v.id)).speed, 20);
      await a4.control(a, key(), v.id, "run");
      const step = key();
      await a4.control(a, step, v.id, "step");
      const state = await roundState(a, v.id);
      await a4.control(a, step, v.id, "step");
      assert.equal((await roundState(a, v.id)).state, state.state);
      await terminal(a, second.id);
      assert.equal((await a4.view(a, second.id)).state, "archived");
      assert.equal((await a4.view(a, v.id)).state, "running");
      await finish(v.id);
      assert.ok((await a4.list(a, debateId)).items.length >= 2);
    });
    it("settles outstanding exposure after disabling admission and survives duplicate workers", async () => {
      const a = await actor(),
        v = await run(a, { population: 10 });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      await owner.query("UPDATE a4_controls SET enabled=false");
      try {
        await assert.rejects(a4.refill(a, key(), v.id), /disabled/);
        await assert.rejects(
          a4.create(a, key(), { debateId, mode: "mixed" }),
          /disabled/,
        );
        await owner.query(
          "UPDATE a4_rounds SET closes_at=clock_timestamp()-INTERVAL '1 second',opens_at=clock_timestamp()-INTERVAL '2 seconds' WHERE session_id=$1",
          [v.id],
        );
        await owner.query(
          "UPDATE a4_sessions SET reveal_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
          [v.id],
        );
        for (let i = 0; i < 6; i++)
          await Promise.all([
            a4.tick(),
            createA4Repository(pool, "disabled").tick(),
          ]);
        assert.equal((await a4.view(a, v.id)).state, "complete");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`settle:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await owner.query("UPDATE a4_controls SET enabled=true");
      }
    });
    it("enforces runtime grants, balanced journals, asset segregation and projection rollback", async () => {
      for (const sql of [
        "DELETE FROM a4_postings",
        "UPDATE a4_journals SET kind=kind",
        "UPDATE a4_assets SET precision=8",
        "UPDATE a4_controls SET enabled=false",
        "UPDATE a4_rounds SET seed=seed",
        "UPDATE a4_sessions SET config=config",
      ])
        await assert.rejects(pool.query(sql), (e) => e.code === "42501");
      const c = await pool.connect();
      const scope = `test-${key()}`;
      try {
        await c.query("BEGIN");
        await assert.rejects(
          post(c, key(), "bad", [
            { account: account(scope, "x", "available"), amount: 1n },
          ]),
          /unbalanced/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            key(),
            "bad",
            transfer(
              account(scope, "x", "issuer"),
              account(scope, "y", "available", null, "TEST8"),
              1n,
            ),
          ),
          /mixed-asset/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            key(),
            "bad",
            transfer(
              account(scope, "x", "available"),
              account(scope, "y", "available"),
              1n,
            ),
          ),
          (e) => e.code === "23514",
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO a4_journals(reference,scope,asset,kind,metadata) VALUES($1,$2,'YAP','bad','{}')",
          [key(), scope],
        );
        await assert.rejects(c.query("COMMIT"), (e) => e.code === "23514");
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        const ref = key();
        await post(
          c,
          ref,
          "test",
          transfer(
            account(scope, "x", "issuer"),
            account(scope, "y", "available"),
            100n,
          ),
        );
        await c.query("COMMIT");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            ref,
            "test",
            transfer(
              account(scope, "x", "issuer"),
              account(scope, "y", "available"),
              100n,
            ),
          ),
          /already posted/,
        );
        await c.query("ROLLBACK");
        // Grants stop the runtime role; the trigger also stops the owner.
        for (const sql of [
          "UPDATE a4_journals SET kind='edited' WHERE reference=$1",
          "DELETE FROM a4_journals WHERE reference=$1",
          "UPDATE a4_postings SET amount=-amount WHERE reference=$1",
          "DELETE FROM a4_postings WHERE reference=$1",
        ])
          await assert.rejects(
            owner.query(sql, [ref]),
            (e) => e.code === "23514" && /append-only/.test(e.message),
          );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS n FROM a4_postings WHERE reference=$1",
              [ref],
            )
          ).rows[0].n,
          2,
        );
        assert.deepEqual(await reconcile(c, scope), { reconciled: true });
      } finally {
        c.release();
      }
    });
    it("rejects untrusted flags, malformed inputs, unsupported rules and cross-account reads", async () => {
      const a = await actor(),
        b = await actor(),
        v = await run(a, { population: 2 }),
        api = app();
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            observer: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            seed: "known",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            config: { asset: "USD" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(api)
            .get(`/api/a4/runs/${v.id}?observer=true`)
            .set("Cookie", b.cookie)
        ).status,
        404,
      );
      assert.equal(
        (
          await request(api)
            .get(`/api/a4/runs/${v.id}?limit=999`)
            .set("Cookie", a.cookie)
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${v.rounds[0].id}/submit`, {
            side: "YES",
            ceiling: "0.5",
            quantity: 1,
            rule: "a3",
            accountId: a.userId,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${v.rounds[0].id}/submit`, {
            side: "YES",
            ceiling: 0.5,
            quantity: 1,
            rule: "a4-v1",
            accountId: a.userId,
          })
        ).status,
        400,
      );
      assert.equal(
        (await command(api, a, `runs/${v.id}/control`, { action: "elevate" }))
          .status,
        400,
      );
      await terminal(a, v.id);
    });
  },
);

// These cases use owner-only failure fixtures; product mutations run as runtime.
describe(
  "A4 durable failure and backing cases",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });
    it("rolls back failures before/after draw persistence and recovers without new draws or payouts", async () => {
      const a = await actor(),
        v = await run(a, { population: 10 });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      await a4.control(a, key(), v.id, "step");
      const constraint = `a4_fault_${key().replaceAll("-", "")}`;
      try {
        await owner.query(
          `ALTER TABLE a4_audit ADD CONSTRAINT ${constraint} CHECK(action<>'round.price' OR session_id<>'${v.id}'::uuid) NOT VALID`,
        );
        const request = key();
        await assert.rejects(a4.control(a, request, v.id, "step"), /invariant/);
        assert.equal((await roundState(a, v.id)).state, "locked");
        await owner.query(`ALTER TABLE a4_audit DROP CONSTRAINT ${constraint}`);
        await a4.control(a, request, v.id, "step");
        const draw = (await roundState(a, v.id)).offer;
        await owner.query(
          `ALTER TABLE a4_audit ADD CONSTRAINT ${constraint} CHECK(action<>'round.execute' OR session_id<>'${v.id}'::uuid) NOT VALID`,
        );
        await assert.rejects(a4.control(a, key(), v.id, "step"), /invariant/);
        assert.equal((await roundState(a, v.id)).state, "priced");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`execute:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          0,
        );
        await owner.query(`ALTER TABLE a4_audit DROP CONSTRAINT ${constraint}`);
        await createA4Repository(pool, "bots").tick();
        assert.deepEqual((await roundState(a, v.id)).offer, draw);
        await finish(v.id);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`settle:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await owner.query(
          `ALTER TABLE a4_audit DROP CONSTRAINT IF EXISTS ${constraint}`,
        );
      }
    });
    it("records a genuine center loss, separate from play issuance and fees", async () => {
      const a = await actor(),
        v = await run(
          a,
          { population: 100, preset: "reference", epsilon: 0 },
          "observer",
          { seed: "loss-4" },
        );
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      await finish(v.id);
      const d = (await a4.view(a, v.id)).rounds[0].diagnostics;
      assert.equal(d.pricing.share.n, "3");
      assert.equal(d.pricing.share.d, "50");
      assert.ok(BigInt(d.centerTrading) < 0n);
      assert.equal(d.centerFees, "0");
      const issuance = (
        await pool.query(
          "SELECT count(*)::int AS n FROM a4_journals WHERE scope=$1 AND kind='play_center_issuance'",
          [v.id],
        )
      ).rows[0].n;
      assert.equal(issuance, 1);
    });
    it("does not strand a pending payout when paused future windows expire", async () => {
      const a = await actor(),
        v = await run(a, { population: 4, periods: 2, delayed: true });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      await a4.control(a, key(), v.id, "pause");
      await finish(v.id);
      const final = await a4.view(a, v.id);
      assert.equal(final.rounds[0].state, "settled");
      assert.equal(final.rounds[1].state, "void");
      assert.equal(final.rounds[1].revealed, true);
    });
    it("retires ordinary YAP play and keeps its runs and balances readable", async () => {
      const a = await actor(),
        api = app();
      const retiredError = (error) =>
        error.status === 410 && /Yap Coins play is retired/.test(error.message);
      await assert.rejects(
        a4.create(a, key(), { debateId, mode: "human" }),
        retiredError,
      );
      await assert.rejects(a4.refill(a, key()), retiredError);
      const open = await retiredHumanRun(a, { label: "Left open", open: true });
      await assert.rejects(
        a4.submit(a, key(), open.round, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        retiredError,
      );
      await assert.rejects(a4.refill(a, key(), open.session), retiredError);
      await assert.rejects(
        a4.control(a, key(), open.session, "step"),
        /bot control unavailable/,
      );
      const view = await a4.view(a, open.session);
      assert.equal(view.mode, "human");
      assert.equal(view.rounds[0].state, "open");
      assert.deepEqual(view.balances, []);
      assert.ok(
        (await a4.list(a, debateId)).items.some((i) => i.id === open.session),
      );
      const wallet = await a4.wallet(a);
      assert.deepEqual(wallet.balances, []);
      assert.equal(wallet.mode, "bots");
      for (const [path, body] of [
        ["runs", { debateId, mode: "human" }],
        ["refill", {}],
        ["refill", { runId: open.session }],
      ]) {
        const response = await command(api, a, path, body);
        assert.equal(response.status, 410, path);
        assert.match(response.body.error, /retired/);
      }
      // Human-only mode had nothing left to enable.
      assert.equal(createA4Repository(pool, "yap-coins").mode, "disabled");
      await assert.rejects(
        createA4Repository(pool, "yap-coins").create(a, key(), {
          debateId,
          mode: "mixed",
        }),
        /disabled/,
      );
      // Bot runs keep their own play balances.
      const bots = await run(a, { population: 2 });
      assert.equal(
        bots.balances.find((b) => b.kind === "available").amount,
        "1000000000",
      );
      assert.equal((await a4.refill(a, key(), bots.id)).issued, true);
      await terminal(a, bots.id);
    });
    it("never shows another person's account id in a revealed human run", async () => {
      const a = await actor(),
        b = await actor(),
        c = await actor(),
        api = app();
      const { session } = await retiredHumanRun(a, {
        label: "Anonymous book",
        orders: [
          { actor: a, side: "YES", limit: "1", premium: "500001" },
          { actor: b, side: "NO", limit: "0", premium: "500000" },
        ],
      });
      // The stored outcomes still name each person; only the view drops it.
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM a4_submissions o JOIN a4_rounds r ON r.id=o.round_id WHERE r.session_id=$1 AND o.outcome->>'participant' LIKE 'user:%'",
            [session],
          )
        ).rows[0].n,
        2,
      );
      const response = await request(api)
        .get(`/api/a4/runs/${session}`)
        .set("Cookie", c.cookie);
      assert.equal(response.status, 200);
      for (const view of [await a4.view(c, session), response.body]) {
        assert.equal(JSON.stringify(view).includes('"user:'), false);
        const { book } = view.rounds[0].diagnostics;
        assert.deepEqual(
          book.map((row) => row.label),
          ["Participant 1", "Participant 2"],
        );
        assert.deepEqual(book.map((row) => row.outcome.premium).sort(), [
          "500000",
          "500001",
        ]);
        for (const row of book) {
          assert.equal(Object.hasOwn(row.outcome, "participant"), false);
          assert.equal(row.outcome.status, "settled");
        }
      }
    });
    it("applies configured play grants without reissuing prior business references", async () => {
      const a = await actor(),
        custom = createA4Repository(pool, "bots", {
          starterCoins: 250,
          refillCoins: 50,
          botCoins: 105,
        });
      const v = await custom.create(a, key(), {
        debateId,
        mode: "mixed",
        config: { population: 2 },
      });
      assert.equal(
        (await custom.view(a, v.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "250000000",
      );
      const refill = await custom.refill(a, key(), v.id);
      assert.equal(refill.amount, "50000000");
      assert.equal(
        (await custom.view(a, v.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "300000000",
      );
      assert.equal((await a4.refill(a, key(), v.id)).issued, false);
      assert.equal(
        (await a4.view(a, v.id)).balances.find((b) => b.kind === "available")
          .amount,
        "300000000",
      );
      assert.throws(
        () =>
          createA4Repository(pool, "bots", {
            starterCoins: 1,
            refillCoins: 1,
            botCoins: 104,
          }),
        /funding policy/,
      );
      await custom.control(a, key(), v.id, "archive");
    });
    it("handles runtime backend termination during execution and recovers the persisted draw", async () => {
      const a = await actor(),
        v = await run(a, { population: 5 });
      for (let i = 0; i < 2; i++) await a4.control(a, key(), v.id, "step");
      const draw = (await a4.view(a, v.id)).rounds[0].offer;
      let terminated = false;
      const crashing = createA4Repository(
        {
          query: pool.query.bind(pool),
          async connect() {
            const client = await pool.connect(),
              query = client.query.bind(client);
            client.query = (sql, ...args) => {
              if (
                !terminated &&
                typeof sql === "string" &&
                sql.startsWith("UPDATE a4_submissions s SET outcome")
              ) {
                terminated = true;
                return query("SELECT pg_terminate_backend(pg_backend_pid())");
              }
              return query(sql, ...args);
            };
            return client;
          },
        },
        "bots",
      );
      await assert.rejects(
        crashing.control(a, key(), v.id, "step"),
        (error) =>
          ["57P01", "ECONNRESET", "EPIPE"].includes(error.code) ||
          /connection terminated/i.test(error.message),
      );
      assert.equal(terminated, true);
      assert.equal((await a4.view(a, v.id)).rounds[0].state, "priced");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
            [`execute:${v.rounds[0].id}`],
          )
        ).rows[0].n,
        0,
      );
      await finish(v.id);
      assert.deepEqual((await a4.view(a, v.id)).rounds[0].offer, draw);
    });
  },
);

// Decision 0010: the freeze migration recorded every retired YAP play
// ('global') balance, then made that part of the ledger read-only. On an
// upgraded database these rows are the history seeded before the freeze.
describe(
  "A4 retired YAP play ledger and reconciliation",
  { skip: !enabled, concurrency: false },
  () => {
    const frozen = (error) =>
      error.code === "23514" && /YAP play is retired/.test(error.message);
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });
    it("keeps every retired play balance equal to its closing record and its postings", async () => {
      const rows = (
        await owner.query(
          `SELECT COALESCE(a.id,c.account_id) AS id,a.amount::text AS amount,c.amount::text AS closed,
            (SELECT COALESCE(sum(p.amount),0) FROM a4_postings p WHERE p.account_id=COALESCE(a.id,c.account_id))::text AS posted
          FROM a4_accounts a FULL JOIN a4_play_closing_balances c ON c.account_id=a.id
          WHERE a.scope='global' OR c.account_id IS NOT NULL ORDER BY 1`,
        )
      ).rows;
      for (const row of rows) {
        assert.equal(row.closed, row.amount, `closing record of ${row.id}`);
        assert.equal(row.posted, row.amount, `postings of ${row.id}`);
      }
      assert.deepEqual(
        (await owner.query("SELECT * FROM a4_ledger_discrepancies()")).rows,
        [],
      );
      console.log(
        JSON.stringify({
          scenario: "retired YAP play reconciliation",
          closedAccounts: rows.length,
          discrepancies: 0,
        }),
      );
    });
    it("refuses every write to the retired play ledger for the runtime and the owner", async () => {
      const a = await actor();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            key(),
            "play_issuance",
            transfer(
              account("global", "play-issuer", "issuer"),
              account("global", `user:${a.userId}`, "available", a.userId),
              1n,
            ),
          ),
          frozen,
        );
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      await assert.rejects(
        owner.query(
          "INSERT INTO a4_journals(reference,scope,asset,kind,metadata) VALUES($1,'global','YAP','fixture','{}')",
          [key()],
        ),
        frozen,
      );
      await assert.rejects(
        owner.query(
          "INSERT INTO a4_accounts(id,scope,asset,kind) VALUES($1,'global','YAP','available')",
          [`global:YAP:fixture-${key()}:available`],
        ),
        frozen,
      );
      const bots = await run(a, { population: 2 });
      const botAccount = (
        await owner.query(
          "SELECT id FROM a4_accounts WHERE scope=$1 ORDER BY id LIMIT 1",
          [bots.id],
        )
      ).rows[0].id;
      await assert.rejects(
        owner.query("UPDATE a4_accounts SET scope='global' WHERE id=$1", [
          botAccount,
        ]),
        frozen,
      );
      // Existing play accounts cannot change or disappear. The fixture row is
      // written with the insert guard off inside a transaction that rolls back.
      const fixture = await owner.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query(
          "ALTER TABLE a4_accounts DISABLE TRIGGER a4_play_account_insert",
        );
        const id = `global:YAP:fixture-${key()}:available`;
        await fixture.query(
          "INSERT INTO a4_accounts(id,scope,asset,kind) VALUES($1,'global','YAP','available')",
          [id],
        );
        await fixture.query(
          "ALTER TABLE a4_accounts ENABLE TRIGGER a4_play_account_insert",
        );
        for (const sql of [
          "UPDATE a4_accounts SET amount=amount+1 WHERE id=$1",
          "UPDATE a4_accounts SET scope='elsewhere' WHERE id=$1",
          "DELETE FROM a4_accounts WHERE id=$1",
        ]) {
          await fixture.query("SAVEPOINT probe");
          await assert.rejects(fixture.query(sql, [id]), frozen);
          await fixture.query("ROLLBACK TO SAVEPOINT probe");
        }
        for (const sql of [
          "TRUNCATE a4_postings",
          "TRUNCATE a4_journals,a4_postings",
        ]) {
          await fixture.query("SAVEPOINT probe");
          await assert.rejects(fixture.query(sql), frozen);
          await fixture.query("ROLLBACK TO SAVEPOINT probe");
        }
        await fixture.query("SAVEPOINT probe");
        await assert.rejects(
          fixture.query("TRUNCATE a4_play_closing_balances"),
          (error) =>
            error.code === "23514" && /append-only/.test(error.message),
        );
        await fixture.query("ROLLBACK TO SAVEPOINT probe");
        await fixture.query("ROLLBACK");
      } finally {
        fixture.release();
      }
      // Bot scopes keep writing: archiving voids the open round with a refund.
      await terminal(a, bots.id);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
            [`void:${bots.rounds[0].id}`],
          )
        ).rows[0].n,
        1,
      );
    });
    it("blocks closing a ledger scope while a round or committed value is open", async () => {
      // The check the freeze migration ran on 'global', applied to a bot run.
      const a = await actor(),
        v = await run(a, { population: 2 });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      const problems = async (client = owner) =>
        [
          ...new Set(
            (
              await client.query(
                "SELECT problem FROM a4_ledger_closing_blockers($1)",
                [v.id],
              )
            ).rows.map((r) => r.problem),
          ),
        ].sort();
      assert.deepEqual(await problems(), [
        "round is not settled or void",
        "value is still committed",
      ]);
      await finish(v.id);
      assert.deepEqual(await problems(), []);
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "UPDATE a4_accounts SET amount=amount+1 WHERE scope=$1 AND kind='available' AND user_id=$2",
          [v.id, a.userId],
        );
        await c.query(
          "INSERT INTO a4_journals(reference,scope,asset,kind,metadata) VALUES($1,$2,'YAP','fixture','{}')",
          [key(), v.id],
        );
        assert.deepEqual(await problems(c), [
          "balance differs from its postings",
          "journal is empty or unbalanced",
          "scope does not sum to zero",
        ]);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      const closing = (
        await owner.query(
          `SELECT a.amount::text AS amount,COALESCE(sum(p.amount),0)::text AS posted
          FROM a4_accounts a LEFT JOIN a4_postings p ON p.account_id=a.id
          WHERE a.scope=$1 GROUP BY a.id,a.amount`,
          [v.id],
        )
      ).rows;
      assert.ok(closing.length > 0);
      assert.ok(closing.every((r) => r.amount === r.posted));
    });
  },
);
