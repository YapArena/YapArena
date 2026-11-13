import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEndorsementRecorder } from "../dist/features/endorsement/recorder.js";
import {
  createEndorsementRepository,
  debateEndorsement,
} from "../dist/features/endorsement/repository.js";

// Decision 0015: the recorder and reads without a database. The PostgreSQL
// suite (endorsement-postgres.test.js) checks the SQL itself.
function answer(userId, side, roundId, turnNumber, second, debateId = "d1") {
  return {
    userId,
    side,
    createdAt: `2026-11-13T12:00:${String(second).padStart(2, "0")}.000000Z`,
    revealedAt: "2026-11-13T13:00:00.000000Z",
    debateId,
    turnNumber,
    roundId,
  };
}

function pool({ events = [], pending = {}, answers = {}, fail = new Set() }) {
  const inserts = [];
  const statements = [];
  const answer = (sql, parameters = []) => {
    statements.push(sql);
    if (sql.includes("GROUP BY d.topic_id"))
      return { rows: events, rowCount: events.length };
    if (sql.includes("pg_advisory_xact_lock")) {
      if (fail.has(parameters[0])) throw new Error(`${parameters[0]} busy`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT r.id::text AS id")) {
      const rows = (pending[parameters[1]] ?? []).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('AS "userId"')) {
      const rows = answers[parameters[0]] ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO endorsement_points")) {
      inserts.push(parameters);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    inserts,
    statements,
    async query(sql, parameters) {
      return answer(sql, parameters);
    },
    async connect() {
      return {
        async query(sql, parameters) {
          return answer(sql, parameters);
        },
        on() {},
        removeListener() {},
        release() {},
      };
    },
  };
}

describe("endorsement recorder", () => {
  it("does nothing without reveal events", async () => {
    const database = pool({});
    const recorder = createEndorsementRecorder(database, "simulation");
    assert.deepEqual(await recorder.record(), { events: 0, points: 0 });
    assert.equal(database.statements.length, 1);
  });

  it("appends an event's rounds in turn order, each folding what came before", async () => {
    const database = pool({
      events: [{ topicId: "t1", debateId: "d1" }],
      pending: { d1: ["r2", "r3"] },
      answers: {
        t1: [
          // Recorded earlier, in another debate of the topic.
          answer("a", "YES", "r0", 1, 1, "d0"),
          answer("b", "NO", "r2", 2, 2),
          answer("a", "NO", "r2", 2, 3),
          answer("b", "YES", "r3", 3, 4),
        ],
      },
    });
    const recorder = createEndorsementRecorder(database, "simulation");
    assert.deepEqual(await recorder.record(20, ["t1"]), {
      events: 1,
      points: 2,
    });
    const [second, third] = database.inserts;
    assert.deepEqual(second.slice(0, 6), ["r2", "t1", 0, 2, 0, 2]);
    assert.deepEqual(third.slice(0, 6), ["r3", "t1", 1, 2, 1, 2]);
    const switching = JSON.parse(third[6]);
    assert.equal(switching.switches.between, 1);
    assert.equal(switching.switches.within, 1);
    assert.equal(JSON.parse(third[7]).switches.within, 1);
    assert.equal(third[8], "last-answer-v1");
    assert.ok(
      database.statements.some((sql) =>
        sql.includes("SET LOCAL statement_timeout"),
      ),
    );
  });

  it("skips an event another writer already recorded", async () => {
    const database = pool({
      events: [{ topicId: "t1", debateId: "d1" }],
    });
    const recorder = createEndorsementRecorder(database, "simulation");
    assert.deepEqual(await recorder.record(), { events: 1, points: 0 });
    assert.equal(database.inserts.length, 0);
  });

  it("runs every event and reports one failure as itself", async () => {
    const database = pool({
      events: [
        { topicId: "busy", debateId: "d1" },
        { topicId: "t2", debateId: "d2" },
      ],
      pending: { d2: ["r9"] },
      answers: { t2: [answer("a", "YES", "r9", 1, 1, "d2")] },
      fail: new Set(["busy"]),
    });
    const recorder = createEndorsementRecorder(database, "simulation");
    await assert.rejects(recorder.record(), /busy busy/);
    assert.equal(database.inserts.length, 1);
  });

  it("aggregates several failing events", async () => {
    const database = pool({
      events: [
        { topicId: "x", debateId: "d1" },
        { topicId: "y", debateId: "d2" },
      ],
      fail: new Set(["x", "y"]),
    });
    await assert.rejects(
      createEndorsementRecorder(database, "simulation").record(),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        return true;
      },
    );
  });
});

describe("endorsement reads", () => {
  const switching = { multiAnswerAccounts: 0 };
  function reader(rows) {
    const calls = [];
    return {
      calls,
      async query(sql, parameters) {
        calls.push([sql, parameters]);
        for (const [marker, value] of rows)
          if (sql.includes(marker)) return { rows: value };
        return { rows: [] };
      },
    };
  }

  it("composes the topic page and hides links to debates no longer public", async () => {
    const database = reader([
      [
        "LIMIT 1",
        [
          {
            yes: 3,
            accounts: 5,
            switching,
            revealedAt: "2026-11-13T13:00:00.000000Z",
            slug: null,
            title: "Hidden",
            liveEndedAt: null,
            debatesCounted: 2,
          },
        ],
      ],
      [
        "ORDER BY h.id",
        [
          {
            id: "1",
            revealedAt: "2026-11-13T13:00:00.000000Z",
            turnNumber: 1,
            slug: "shown-debate",
            title: "Shown",
            yes: 1,
            accounts: 2,
          },
          {
            id: "2",
            revealedAt: "2026-11-13T13:00:01.000000Z",
            turnNumber: 2,
            slug: null,
            title: "Hidden",
            yes: 3,
            accounts: 5,
          },
        ],
      ],
      [
        "DISTINCT ON",
        [{ debateId: "d1", throughTurn: 2, yes: 1, accounts: 2, switching }],
      ],
    ]);
    const repository = createEndorsementRepository(database, "simulation");
    const page = await repository.topic("t1");
    assert.equal(page.figure.lastDebate, null);
    assert.equal(page.figure.debatesCounted, 2);
    assert.deepEqual(page.history[0].debate, {
      slug: "shown-debate",
      title: "Shown",
    });
    assert.equal(page.history[1].debate, null);
    assert.equal(page.debates[0].throughTurn, 2);
    assert.deepEqual(
      database.calls.find(([sql]) => sql.includes("ORDER BY h.id"))[1],
      ["t1", 2000],
    );
  });

  it("reports the last debate with its live end", async () => {
    const database = reader([
      [
        "LIMIT 1",
        [
          {
            yes: 1,
            accounts: 1,
            switching,
            revealedAt: "2026-11-13T13:00:00.000000Z",
            slug: "a-debate",
            title: "Q",
            liveEndedAt: "2026-11-12T13:00:00.000000Z",
            debatesCounted: 1,
          },
        ],
      ],
    ]);
    const repository = createEndorsementRepository(database, "simulation");
    assert.deepEqual((await repository.topicFigure("t1")).lastDebate, {
      slug: "a-debate",
      title: "Q",
      liveEndedAt: "2026-11-12T13:00:00.000000Z",
    });
    assert.equal(
      await createEndorsementRepository(reader([]), "simulation").topicFigure(
        "t1",
      ),
      null,
    );
  });

  it("computes the debate bar on read, on the caller's client and rail", async () => {
    const client = reader([
      [
        'AS "userId"',
        [answer("a", "YES", "r1", 1, 1), answer("b", "NO", "r1", 1, 2)],
      ],
    ]);
    const repository = createEndorsementRepository(reader([]), "simulation");
    const figure = await repository.debateEndorsement(client, "d1");
    assert.equal(figure.throughTurn, 1);
    assert.equal(figure.yes, 1);
    assert.equal(figure.accounts, 2);
    assert.deepEqual(client.calls[0][1], ["d1", "simulation"]);
    assert.equal(await debateEndorsement(reader([]), "d1", "simulation"), null);
  });
});
