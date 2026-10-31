import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  createDatabase,
  defaultStatementTimeoutMs,
} from "../dist/platform/database.js";
import { createJobHeartbeat } from "../dist/platform/job-heartbeat.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  runTransaction,
  withTransaction,
} from "../dist/platform/transaction.js";

const logger = createLogger({ enabled: false });
const url = "postgresql://yaparena_runtime@localhost:5432/yaparena";

describe("database pool limits", () => {
  it("gives web and jobs pools a 15-second statement timeout and no client timeout", async () => {
    const pool = createDatabase(url, logger);
    assert.equal(defaultStatementTimeoutMs, 15_000);
    assert.equal(
      pool.options.options,
      "-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=15000",
    );
    assert.equal(pool.options.query_timeout, undefined);
    assert.equal(pool.options.connectionTimeoutMillis, 5_000);
    await pool.end();
  });

  it("keeps the replay worker's tighter limits", async () => {
    const pool = createDatabase(url, logger, undefined, {
      max: 2,
      timeoutMs: 1500,
    });
    assert.match(pool.options.options, / -c statement_timeout=1500$/);
    assert.equal(pool.options.query_timeout, 1500);
    assert.equal(pool.options.connectionTimeoutMillis, 1500);
    await pool.end();
    const custom = createDatabase(url, logger, undefined, {
      statementTimeoutMs: 200,
    });
    assert.match(custom.options.options, / -c statement_timeout=200$/);
    await custom.end();
  });
});

// The A4/wallet PostgreSQL identities CI supplies; locally see AGENTS.md.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "database timeouts and the jobs heartbeat on PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, short;
    before(() => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const parsed = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
        assert.match(
          parsed.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      owner = new pg.Pool({
        connectionString: ownerUrl,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      runtime = createDatabase(runtimeUrl, logger);
      short = createDatabase(runtimeUrl, logger, undefined, {
        statementTimeoutMs: 200,
      });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end(), short?.end()]);
    });

    const shown = async (client) =>
      (await client.query("SHOW statement_timeout")).rows[0].statement_timeout;

    it("lets each per-transaction timeout win over the default, then restores it", async () => {
      const client = await runtime.connect();
      try {
        assert.equal(await shown(client), "15s");
        // A4 30 s, jobs 5 s, community 3 s, replay 1.5 s.
        for (const [statementTimeoutMs, expected] of [
          [30000, "30s"],
          [5000, "5s"],
          [3000, "3s"],
          [1500, "1500ms"],
        ]) {
          assert.equal(
            await runTransaction(client, shown, { statementTimeoutMs }),
            expected,
          );
          assert.equal(await shown(client), "15s");
        }
      } finally {
        client.release();
      }
    });

    it("cancels a statement past the default unless its transaction allows longer", async () => {
      await assert.rejects(short.query("SELECT pg_sleep(0.5)"), {
        code: "57014",
      });
      await withTransaction(
        short,
        (client) => client.query("SELECT pg_sleep(0.5)"),
        { statementTimeoutMs: 5000 },
      );
    });

    it("stores the heartbeat as the runtime identity and ages it by the database clock", async () => {
      const heartbeat = createJobHeartbeat(runtime);
      await owner.query("DELETE FROM job_heartbeats");
      assert.equal(await heartbeat.age(), null);
      await heartbeat.beat();
      const fresh = await heartbeat.age();
      assert.ok(fresh >= 0 && fresh < 5);
      await owner.query(
        "UPDATE job_heartbeats SET beat_at = clock_timestamp() - INTERVAL '5 minutes'",
      );
      assert.ok((await heartbeat.age()) > 299);
      await heartbeat.beat();
      assert.ok((await heartbeat.age()) < 5);
      // Runtime may only stamp the one row; it cannot delete it.
      await assert.rejects(runtime.query("DELETE FROM job_heartbeats"), {
        code: "42501",
      });
      await assert.rejects(
        runtime.query(
          "INSERT INTO job_heartbeats (name, beat_at) VALUES ('other', now())",
        ),
        { code: "23514" },
      );
    });
  },
);
