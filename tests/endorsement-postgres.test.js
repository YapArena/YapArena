import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { foldAnswers } from "../dist/features/endorsement/model.js";
import { createEndorsementRecorder } from "../dist/features/endorsement/recorder.js";
import {
  createEndorsementRepository,
  topicAnswers,
} from "../dist/features/endorsement/repository.js";

// Decision 0015: the counting rules in SQL and the stored points. Every case
// uses its own topic and scopes the recorder to it, because other PostgreSQL
// suites share the database in parallel. Rounds and orders are written with
// owner SQL: the coin loop's settlement is covered by its own suites and is
// not changed here.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const hex = () => randomBytes(32).toString("hex");

describe(
  "last-answer endorsement points",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, recorder, reader;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      recorder = createEndorsementRecorder(runtime, "simulation");
      reader = createEndorsementRepository(runtime, "simulation");
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    async function topic({ published = true } = {}) {
      const title = `Should endorsement fixture ${randomUUID()} count?`;
      const id = (
        await owner.query(
          `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
          VALUES($1,$2,'Synthetic endorsement fixture','Yes side','No side',$3) RETURNING id`,
          [
            `endorsement-${randomUUID()}`,
            title,
            published ? "published" : "draft",
          ],
        )
      ).rows[0].id;
      return { id, title };
    }
    async function debate(
      subject,
      {
        proposition = subject.title,
        reveal = "per_round",
        demo = false,
        published = true,
      } = {},
    ) {
      const id = (
        await owner.query(
          `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,
            rules_snapshot,is_demo,live_started_at,live_ended_at)
          VALUES($1,$2,$3,'scheduled',$4,'preview-1','{}',$5,
            clock_timestamp()-INTERVAL '1 hour',clock_timestamp()) RETURNING id`,
          [
            subject.id,
            `endorsement-${randomUUID()}`,
            proposition,
            published ? "published" : "draft",
            demo,
          ],
        )
      ).rows[0].id;
      if (reveal === "per_round")
        await owner.query(
          "INSERT INTO coin_debate_reveal_modes(debate_id,mode,reason) VALUES($1,'per_round','Founder-created test debate')",
          [id],
        );
      return id;
    }
    async function account() {
      return (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
    }
    // An open window (turn) or manual round (turn null) taking orders.
    async function round(
      debateId,
      turn,
      { rail = "simulation", capacity = 1001 } = {},
    ) {
      const creator = turn === null ? await account() : null;
      return (
        await owner.query(
          `INSERT INTO coin_debate_rounds(id,debate_id,creator_id,turn_number,turn_side,proposition,
            rail,reference,terms,seed,seed_commitment,opens_at,closes_at)
          VALUES($1,$2,$3,$4,$5,'Fixture question',$6,$7,$8,$9,$10,
            clock_timestamp()-INTERVAL '1 minute',clock_timestamp()+INTERVAL '1 hour')
          RETURNING id`,
          [
            randomUUID(),
            debateId,
            creator,
            turn,
            turn === null ? null : turn % 2 ? "A" : "B",
            rail,
            hex(),
            JSON.stringify({ capacity }),
            hex(),
            hex(),
          ],
        )
      ).rows[0].id;
    }
    async function order(roundId, userId, side, createdAt = null) {
      const requestId = randomUUID();
      await owner.query(
        `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status)
        VALUES($1,$2,'stake',$3,$4,'{}'::jsonb,'settled')`,
        [requestId, userId, hex(), hex()],
      );
      await owner.query(
        `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,
          funding,center_reservation,promotional_reservation,created_at)
        VALUES($1,$2,$3,$4,'0.5',1,'{}'::jsonb,1,0,COALESCE($5::timestamptz,clock_timestamp()))`,
        [roundId, userId, requestId, side, createdAt],
      );
    }
    // Settling is a privileged fixture action in a disposable database: the
    // guard would wait for the cutoff (and the 120-hour close of a five-day
    // debate).
    async function finish(
      roundId,
      { state = "settled", result = {}, revealedAt = null } = {},
    ) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        // The room signal fires now, so no trigger event is pending when the
        // guard is switched back on.
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query(
          "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
        );
        await client.query(
          `UPDATE coin_debate_rounds SET closes_at=greatest(opens_at+INTERVAL '1 second',
            clock_timestamp()-INTERVAL '1 second'),state=$2,result=$3::jsonb,
            revealed_at=COALESCE($4::timestamptz,clock_timestamp()) WHERE id=$1`,
          [
            roundId,
            state,
            JSON.stringify(
              state === "void" ? { voidReason: "fixture", ...result } : result,
            ),
            revealedAt,
          ],
        );
        await client.query(
          "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    async function points(topicId) {
      return (
        await owner.query(
          `SELECT p.*,p.xmin::text AS xmin FROM endorsement_points p
          WHERE p.topic_id=$1 ORDER BY p.id`,
          [topicId],
        )
      ).rows;
    }
    // §4.1's reference: each account's last answer with DISTINCT ON.
    async function distinctOn(topicId) {
      return (
        await owner.query(
          `WITH counted AS (
            SELECT o.user_id,o.side,o.created_at,r.revealed_at,r.turn_number,r.id AS round_id
            FROM debates d JOIN topics t ON t.id=d.topic_id
            JOIN coin_debate_rounds r ON r.debate_id=d.id AND r.turn_number IS NOT NULL
            JOIN coin_debate_orders o ON o.round_id=r.id
            WHERE d.topic_id=$1 AND t.publication_state='published'
              AND d.publication_state='published' AND NOT d.is_demo AND d.proposition=t.title
              AND r.rail='simulation' AND r.state='settled' AND r.revealed_at<=clock_timestamp()
              AND NOT EXISTS (SELECT 1 FROM coin_debate_rounds e
                WHERE e.debate_id=r.debate_id AND e.rail=r.rail AND e.turn_number IS NOT NULL
                  AND e.state='open' AND (r.reveal_mode='five_day' OR e.turn_number<r.turn_number))),
          kept AS (SELECT DISTINCT ON (user_id) user_id,side FROM counted
            ORDER BY user_id,created_at DESC,revealed_at DESC,turn_number DESC,round_id DESC)
          SELECT count(*) FILTER (WHERE side='YES')::int AS yes,count(*)::int AS accounts FROM kept`,
          [topicId],
        )
      ).rows[0];
    }
    // §4.3's reference: the switching statistics with window functions.
    async function windowSwitching(topicId) {
      const row = (
        await owner.query(
          `WITH counted AS (
            SELECT o.user_id,o.side,o.created_at,r.revealed_at,r.turn_number,r.id AS round_id,
              r.debate_id
            FROM debates d JOIN topics t ON t.id=d.topic_id
            JOIN coin_debate_rounds r ON r.debate_id=d.id AND r.turn_number IS NOT NULL
            JOIN coin_debate_orders o ON o.round_id=r.id
            WHERE d.topic_id=$1 AND d.proposition=t.title AND r.state='settled'),
          a AS (SELECT *,lag(side) OVER w AS prev_side,lag(debate_id) OVER w AS prev_debate,
              first_value(side) OVER w AS first_side,
              last_value(side) OVER (PARTITION BY user_id ORDER BY created_at,revealed_at,
                turn_number,round_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
                AS last_side,
              count(*) OVER (PARTITION BY user_id) AS n
            FROM counted
            WINDOW w AS (PARTITION BY user_id ORDER BY created_at,revealed_at,turn_number,round_id))
          SELECT
            count(DISTINCT user_id) FILTER (WHERE n>=2)::int AS "multiAnswerAccounts",
            count(DISTINCT user_id) FILTER (WHERE prev_side IS NOT NULL AND side<>prev_side)::int
              AS switchers,
            count(DISTINCT user_id) FILTER (WHERE prev_side IS NOT NULL AND side<>prev_side
              AND first_side<>last_side)::int AS stayed,
            count(DISTINCT user_id) FILTER (WHERE prev_side IS NOT NULL AND side<>prev_side
              AND first_side=last_side)::int AS "cameBack",
            count(*) FILTER (WHERE prev_side IS NOT NULL AND debate_id=prev_debate)::int
              AS pairs_within,
            count(*) FILTER (WHERE prev_side IS NOT NULL AND debate_id<>prev_debate)::int
              AS pairs_between,
            count(*) FILTER (WHERE side<>prev_side AND debate_id=prev_debate)::int
              AS switches_within,
            count(*) FILTER (WHERE side<>prev_side AND debate_id<>prev_debate)::int
              AS switches_between,
            count(*) FILTER (WHERE side<>prev_side AND side='YES')::int AS "toYes",
            count(*) FILTER (WHERE side<>prev_side AND side='NO')::int AS "toNo"
          FROM a`,
          [topicId],
        )
      ).rows[0];
      return {
        multiAnswerAccounts: row.multiAnswerAccounts,
        switchers: row.switchers,
        stayed: row.stayed,
        cameBack: row.cameBack,
        pairs: { within: row.pairs_within, between: row.pairs_between },
        switches: {
          within: row.switches_within,
          between: row.switches_between,
        },
        toYes: row.toYes,
        toNo: row.toNo,
      };
    }
    const record = (subject) => recorder.record(20, [subject.id]);

    it("follows each per-round reveal and reads back the topic page", async () => {
      const subject = await topic();
      const debateId = await debate(subject);
      const [alice, bob, chloe] = [
        await account(),
        await account(),
        await account(),
      ];
      const first = await round(debateId, 1);
      await order(first, alice, "YES");
      await order(first, bob, "YES");
      await order(first, chloe, "NO");
      assert.deepEqual(await record(subject), { events: 0, points: 0 });
      assert.equal(
        await reader.debateEndorsement(runtime, debateId),
        null,
        "nothing is counted before a reveal",
      );
      await finish(first);
      const second = await round(debateId, 2);
      await order(second, alice, "NO");
      assert.deepEqual(await record(subject), { events: 1, points: 1 });
      await finish(second);
      const third = await round(debateId, 3);
      await order(third, bob, "NO");
      await order(third, chloe, "YES");
      await finish(third);
      assert.deepEqual(await record(subject), { events: 1, points: 2 });
      const stored = await points(subject.id);
      assert.deepEqual(
        stored.map((p) => [p.turn_number, p.topic_yes, p.topic_accounts]),
        [
          [1, 2, 3],
          [2, 1, 3],
          [3, 1, 3],
        ],
      );
      assert.equal(stored[2].debate_yes, 1);
      assert.equal(stored[2].switching.switchers, 3);
      assert.equal(stored[2].method, "last-answer-v1");
      assert.deepEqual(await distinctOn(subject.id), { yes: 1, accounts: 3 });

      const page = await reader.topic(subject.id);
      assert.equal(page.figure.yes, 1);
      assert.equal(page.figure.accounts, 3);
      assert.equal(page.figure.debatesCounted, 1);
      assert.equal(page.figure.lastDebate.title, subject.title);
      assert.match(page.figure.lastDebate.liveEndedAt, /Z$/);
      assert.deepEqual(
        page.history.map((point) => [point.turnNumber, point.yes]),
        [
          [1, 2],
          [2, 1],
          [3, 1],
        ],
      );
      assert.deepEqual(page.debates, [
        {
          debateId,
          throughTurn: 3,
          yes: 1,
          accounts: 3,
          switching: stored[2].debate_switching,
        },
      ]);
      const bar = await reader.debateEndorsement(runtime, debateId);
      assert.deepEqual(
        [bar.throughTurn, bar.yes, bar.accounts, bar.previous],
        [3, 1, 3, { throughTurn: 2, yes: 1, accounts: 3 }],
      );
      assert.deepEqual(bar.switched, { toYes: 1, toNo: 2, cameBack: 0 });
      assert.deepEqual(await record(subject), { events: 0, points: 0 });
    });

    it("reveals a five-day debate all at once, in turn order, in one transaction", async () => {
      const subject = await topic();
      const debateId = await debate(subject, { reveal: "five_day" });
      const users = [await account(), await account()];
      const windows = [];
      for (const turn of [1, 2, 3]) {
        const id = await round(debateId, turn);
        windows.push(id);
        await order(id, users[turn % 2], turn === 2 ? "NO" : "YES");
      }
      await finish(windows[0]);
      await finish(windows[1]);
      // The last window is still taking replay orders until the close.
      assert.deepEqual(await record(subject), { events: 0, points: 0 });
      assert.equal(await reader.debateEndorsement(runtime, debateId), null);
      assert.equal((await reader.topic(subject.id)).figure, null);
      await finish(windows[2]);
      assert.deepEqual(await record(subject), { events: 1, points: 3 });
      const stored = await points(subject.id);
      assert.deepEqual(
        stored.map((p) => p.turn_number),
        [1, 2, 3],
      );
      assert.equal(new Set(stored.map((p) => p.xmin)).size, 1);
      assert.deepEqual(
        stored.map((p) => [p.topic_yes, p.topic_accounts]),
        [
          [1, 1],
          [1, 2],
          [1, 2],
        ],
      );
      const bar = await reader.debateEndorsement(runtime, debateId);
      assert.equal(bar.throughTurn, 3);
    });

    it("holds later turns back while an earlier one is set aside", async () => {
      const subject = await topic();
      const debateId = await debate(subject);
      const user = await account();
      const first = await round(debateId, 1);
      await order(first, user, "YES");
      const second = await round(debateId, 2);
      await order(second, user, "NO");
      await finish(second);
      assert.deepEqual(await record(subject), { events: 0, points: 0 });
      assert.equal(await reader.debateEndorsement(runtime, debateId), null);
      await finish(first);
      assert.deepEqual(await record(subject), { events: 1, points: 2 });
      assert.deepEqual(
        (await points(subject.id)).map((p) => [p.turn_number, p.topic_yes]),
        [
          [1, 1],
          [2, 0],
        ],
      );
    });

    it("excludes void, manual, unrevealed, other-rail, demo, unpublished and other-question rounds", async () => {
      const subject = await topic();
      const counted = await debate(subject);
      const user = await account();
      const answer = async (debateId, turn, options, finishing = {}) => {
        const id = await round(debateId, turn, options);
        await order(id, user, "YES");
        await finish(id, finishing);
        return id;
      };
      await answer(counted, 1, {}, { state: "void" });
      await answer(counted, null);
      const kept = await round(counted, 2);
      await order(kept, user, "NO");
      await finish(kept);
      await answer(
        counted,
        3,
        {},
        {
          revealedAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      );
      await answer(counted, 4, { rail: "base-sepolia" });
      const demo = await debate(subject, { demo: true });
      await answer(demo, 1);
      const draft = await debate(subject, { published: false });
      await answer(draft, 1);
      const typed = await debate(subject, {
        proposition: "A question typed before the lock",
      });
      await answer(typed, 1);
      const hidden = await topic({ published: false });
      await answer(await debate(hidden), 1);

      assert.deepEqual(await record(subject), { events: 1, points: 1 });
      assert.deepEqual(await record(hidden), { events: 0, points: 0 });
      const [point] = await points(subject.id);
      assert.deepEqual(
        [point.turn_number, point.topic_yes, point.topic_accounts],
        [2, 0, 1],
      );
      // A demo debate's page still shows its own bar; another question shows none.
      assert.equal((await reader.debateEndorsement(runtime, demo)).yes, 1);
      assert.equal(await reader.debateEndorsement(runtime, typed), null);
      assert.equal(
        (await reader.debateEndorsement(runtime, counted)).throughTurn,
        2,
      );
    });

    it("counts over-capacity orders", async () => {
      const subject = await topic();
      const debateId = await debate(subject);
      const [early, late] = [await account(), await account()];
      const id = await round(debateId, 1, { capacity: 1 });
      await order(id, early, "NO");
      const fixture = await owner.connect();
      try {
        await fixture.query("BEGIN");
        await fixture.query(
          "ALTER TABLE coin_debate_orders DISABLE TRIGGER coin_debate_capacity",
        );
        const requestId = randomUUID();
        await fixture.query(
          `INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status)
          VALUES($1,$2,'stake',$3,$4,'{}'::jsonb,'settled')`,
          [requestId, late, hex(), hex()],
        );
        await fixture.query(
          `INSERT INTO coin_debate_orders(round_id,user_id,request_id,side,limit_value,quantity,
            funding,center_reservation,promotional_reservation)
          VALUES($1,$2,$3,'YES','0.5',1,'{}'::jsonb,1,0)`,
          [id, late, requestId],
        );
        await fixture.query(
          "ALTER TABLE coin_debate_orders ENABLE TRIGGER coin_debate_capacity",
        );
        await fixture.query("COMMIT");
      } catch (error) {
        await fixture.query("ROLLBACK");
        throw error;
      } finally {
        fixture.release();
      }
      await finish(id, { result: { overCapacity: [String(late)] } });
      await record(subject);
      const [point] = await points(subject.id);
      assert.deepEqual([point.topic_yes, point.topic_accounts], [1, 2]);
    });

    it("records each round once when recorders run at the same time", async () => {
      const subject = await topic();
      const debateId = await debate(subject);
      for (const turn of [1, 2, 3]) {
        const id = await round(debateId, turn);
        await order(id, await account(), "YES");
        await finish(id);
      }
      const others = Array.from({ length: 4 }, () =>
        createEndorsementRecorder(runtime, "simulation"),
      );
      const results = await Promise.all(
        others.map((other) => other.record(20, [subject.id])),
      );
      assert.equal(
        results.reduce((total, result) => total + result.points, 0),
        3,
      );
      assert.deepEqual(
        (await points(subject.id)).map((p) => [
          p.turn_number,
          p.topic_accounts,
        ]),
        [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
      );
    });

    it("keeps a hidden debate's points and counts the next point without it", async () => {
      const subject = await topic();
      const [first, second] = [await debate(subject), await debate(subject)];
      const [a, b] = [await account(), await account()];
      const one = await round(first, 1);
      await order(one, a, "YES");
      await finish(one);
      await record(subject);
      await owner.query(
        "UPDATE debates SET publication_state='hidden' WHERE id=$1",
        [first],
      );
      const two = await round(second, 1);
      await order(two, b, "NO");
      await finish(two);
      await record(subject);
      const stored = await points(subject.id);
      assert.deepEqual(
        stored.map((p) => [p.topic_yes, p.topic_accounts]),
        [
          [1, 1],
          [0, 1],
        ],
      );
      const page = await reader.topic(subject.id);
      assert.equal(page.history[0].debate, null);
      assert.ok(page.history[1].debate);
      assert.equal(page.figure.debatesCounted, 1);
      assert.deepEqual(
        page.debates.map((result) => result.debateId),
        [second],
      );
    });

    it("matches the DISTINCT ON and window-function references", async () => {
      const subject = await topic();
      const debates = [await debate(subject), await debate(subject)];
      const users = Array.from({ length: 6 }, () => account());
      const ids = await Promise.all(users);
      const base = Date.now() - 600_000;
      let tick = 0;
      // The first account answers every round at the same order time, so its
      // last answer comes from the tie-break chain (reveal time, then turn).
      const at = (u) =>
        new Date(base + (u === 0 ? 0 : ++tick) * 1000).toISOString();
      for (const [index, debateId] of debates.entries())
        for (const turn of [1, 2, 3]) {
          const id = await round(debateId, turn);
          for (const [u, user] of ids.entries())
            if ((u + turn + index) % 3 !== 0)
              await order(
                id,
                user,
                (u * turn + index) % 2 ? "YES" : "NO",
                at(u),
              );
          await finish(id);
        }
      await record(subject);
      const stored = await points(subject.id);
      const latest = stored.at(-1);
      assert.deepEqual(await distinctOn(subject.id), {
        yes: latest.topic_yes,
        accounts: latest.topic_accounts,
      });
      const answers = await topicAnswers(runtime, subject.id, "simulation");
      const fold = foldAnswers(answers);
      assert.equal(fold.yes, latest.topic_yes);
      assert.deepEqual(fold.switching, latest.switching);
      assert.deepEqual(await windowSwitching(subject.id), latest.switching);
      assert.ok(latest.switching.switchers > 0);
    });

    it("refuses changes to points and grants the runtime select and insert only", async () => {
      const subject = await topic();
      const debateId = await debate(subject);
      const id = await round(debateId, 1);
      await order(id, await account(), "YES");
      await finish(id);
      await record(subject);
      const [point] = await points(subject.id);
      await assert.rejects(
        owner.query("UPDATE endorsement_points SET topic_yes=0 WHERE id=$1", [
          point.id,
        ]),
      );
      await assert.rejects(
        owner.query("DELETE FROM endorsement_points WHERE id=$1", [point.id]),
      );
      await assert.rejects(
        runtime.query("UPDATE endorsement_points SET topic_yes=0 WHERE id=$1", [
          point.id,
        ]),
        (error) => error.code === "42501",
      );
      await assert.rejects(
        runtime.query("DELETE FROM endorsement_points WHERE id=$1", [point.id]),
        (error) => error.code === "42501",
      );
      await assert.rejects(
        owner.query(
          `INSERT INTO endorsement_points(round_id,topic_id,debate_id,turn_number,revealed_at,
            topic_yes,topic_accounts,debate_yes,debate_accounts,switching,debate_switching)
          VALUES($1,$2,$3,1,clock_timestamp(),2,1,0,0,'{}','{}')`,
          [await round(debateId, 2), subject.id, debateId],
        ),
        (error) => error.code === "23514",
      );
      const privileges = (
        await owner.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema='yaparena' AND table_name='endorsement_points'
            AND grantee='yaparena_runtime' ORDER BY privilege_type`,
        )
      ).rows.map((row) => row.privilege_type);
      assert.deepEqual(privileges, ["INSERT", "SELECT"]);
      const browser = (
        await owner.query(
          `SELECT count(*)::int AS n FROM information_schema.role_table_grants
          WHERE table_schema='yaparena' AND table_name='endorsement_points'
            AND grantee IN ('anon','authenticated','service_role','PUBLIC')`,
        )
      ).rows[0].n;
      assert.equal(browser, 0);
    });
  },
);
