import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  encoderGrants,
  encoderSequences,
} from "../migrations/1793675904690_add-replay-encoder-role.js";
import {
  verifyEncoderIdentity,
  verifyRuntimeIdentity,
} from "../dist/platform/database.js";
import { verifyDatabaseState } from "../dist/platform/migrations.js";
import { createReplayJobs } from "../dist/features/media/replay-jobs.js";

// Audit finding YA-15: the replay encoder logs in as yaparena_encoder, which
// reaches its queue and the rows a publication touches, and nothing else.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL,
  encoderUrl = process.env.ENCODER_TEST_DATABASE_URL;
const denied = (error) => error.code === "42501";

describe(
  "replay encoder role in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl || !encoderUrl },
  () => {
    let owner, runtime, encoder;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl, encoderUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      assert.equal(new URL(encoderUrl).username, "yaparena_encoder");
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      encoder = new pg.Pool({ ...options, connectionString: encoderUrl });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end(), encoder?.end()]);
    });

    // A published topic with one finished debate whose recording is ready.
    async function finishedDebate(status = "ended", publication = "published") {
      const slug = `encoder-${randomUUID().slice(0, 8)}`;
      const topic = (
        await owner.query(
          `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
          VALUES($1,'Encoder role','Synthetic','For','Against','published') RETURNING id`,
          [slug],
        )
      ).rows[0].id;
      const room = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot)
          SELECT $1,$2,'Synthetic encoder role',$3,$4,version,rules FROM event_rule_versions
          WHERE version='prototype-media-1' RETURNING id`,
          [slug, topic, status, publication],
        )
      ).rows[0].id;
      const sourceKey = `debates/${room}/${randomUUID()}.mp4`;
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,recording_status,egress_id,recording_key)
        VALUES($1,'ended','ready',$2,$3)`,
        [room, randomUUID(), sourceKey],
      );
      return { topic, room, sourceKey };
    }
    const cursor = async (room) =>
      Number(
        (
          await owner.query(
            "SELECT cursor FROM community_rooms WHERE room_id=$1",
            [room],
          )
        ).rows[0].cursor,
      );

    it("passes its own startup check and no other", async () => {
      assert.equal(
        (await encoder.query("SELECT current_user AS name")).rows[0].name,
        "yaparena_encoder",
      );
      await verifyEncoderIdentity(encoder);
      await verifyDatabaseState(
        encoder,
        new URL("../migrations/", import.meta.url),
        verifyEncoderIdentity,
      );
      await assert.rejects(verifyRuntimeIdentity(encoder), /violates/);
      await assert.rejects(verifyEncoderIdentity(runtime), /violates/);
      await assert.rejects(verifyEncoderIdentity(owner), /violates/);
    });

    it("holds exactly the grants in its manifest", async () => {
      const relations = (
        await owner.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
          CASE WHEN c.relkind = 'S' THEN jsonb_build_object(
            'usage', has_sequence_privilege('yaparena_encoder', c.oid, 'USAGE'),
            'select', has_sequence_privilege('yaparena_encoder', c.oid, 'SELECT'),
            'update', has_sequence_privilege('yaparena_encoder', c.oid, 'UPDATE'))
          ELSE jsonb_build_object(
            'select', has_table_privilege('yaparena_encoder', c.oid, 'SELECT'),
            'insert', has_table_privilege('yaparena_encoder', c.oid, 'INSERT'),
            'update', has_table_privilege('yaparena_encoder', c.oid, 'UPDATE'),
            'delete', has_table_privilege('yaparena_encoder', c.oid, 'DELETE'),
            'truncate', has_table_privilege('yaparena_encoder', c.oid, 'TRUNCATE'),
            'references', has_table_privilege('yaparena_encoder', c.oid, 'REFERENCES'),
            'trigger', has_table_privilege('yaparena_encoder', c.oid, 'TRIGGER')) END AS privileges,
          CASE WHEN c.relkind <> 'S' THEN (SELECT jsonb_object_agg(a.attname, jsonb_build_object(
            'select', has_column_privilege('yaparena_encoder', c.oid, a.attnum, 'SELECT'),
            'insert', has_column_privilege('yaparena_encoder', c.oid, a.attnum, 'INSERT'),
            'update', has_column_privilege('yaparena_encoder', c.oid, a.attnum, 'UPDATE'),
            'references', has_column_privilege('yaparena_encoder', c.oid, a.attnum, 'REFERENCES')))
            FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) END AS columns
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('yaparena','yaparena_migrations')
            AND c.relkind IN ('r','p','v','m','f','S')`)
      ).rows;
      assert.ok(relations.length > Object.keys(encoderGrants).length);
      const allows = (list, column) =>
        list === "*" || (Array.isArray(list) && list.includes(column));
      for (const relation of relations) {
        const label = `${relation.schema}.${relation.name}`;
        const migrations =
          relation.schema === "yaparena_migrations" &&
          relation.name === "pgmigrations";
        const spec =
          relation.schema === "yaparena"
            ? Object.hasOwn(encoderGrants, relation.name)
              ? encoderGrants[relation.name]
              : {}
            : migrations
              ? { select: "*" }
              : {};
        if (relation.kind === "S") {
          assert.deepEqual(
            relation.privileges,
            {
              usage:
                relation.schema === "yaparena" &&
                encoderSequences.includes(relation.name),
              select: false,
              update: false,
            },
            label,
          );
          continue;
        }
        assert.deepEqual(
          relation.privileges,
          {
            select: spec.select === "*",
            insert: spec.insert === "*",
            update: false,
            delete: spec.delete === true,
            truncate: false,
            references: false,
            trigger: false,
          },
          label,
        );
        for (const [column, granted] of Object.entries(relation.columns))
          assert.deepEqual(
            granted,
            {
              select: allows(spec.select, column),
              insert: allows(spec.insert, column),
              update: allows(spec.update, column),
              references: false,
            },
            `${label}.${column}`,
          );
      }
      assert.deepEqual(
        (
          await owner.query(`SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
            WHERE p.pronamespace IN ('yaparena'::regnamespace, 'yaparena_migrations'::regnamespace)
              AND has_function_privilege('yaparena_encoder', p.oid, 'EXECUTE')`)
        ).rows,
        [],
      );
    });

    it("cannot touch sessions, identity, coin or community tables", async () => {
      const tables = new Set(
        (
          await owner.query(
            "SELECT relname FROM pg_class WHERE relnamespace='yaparena'::regnamespace AND relkind='r'",
          )
        ).rows.map((row) => row.relname),
      );
      const named = {
        sessions: [
          "sessions",
          "auth_login_transactions",
          "auth_pending_links",
          "media_account_grants",
        ],
        identity: [
          "users",
          "public_profiles",
          "provider_identities",
          "account_roles",
          "account_subjects",
          "account_operations",
          "identity_audit_events",
          "terms_acceptances",
          "auth_controls",
          "media_account_revocations",
        ],
        coins: [...tables].filter((name) => /^(coin|a4)_/.test(name)),
        community: [
          "event_chat_messages",
          "event_chat_controls",
          "event_likes",
          "event_like_changes",
          "community_submission_receipts",
          "community_audit_events",
          "community_restrictions",
          "moderation_cases",
          "moderation_appeals",
          "messages",
          "follows",
          "account_notifications",
        ],
      };
      assert.ok(named.coins.length > 20);
      for (const [category, list] of Object.entries(named))
        for (const table of list) {
          assert.ok(tables.has(table), `${category}: ${table} exists`);
          const column = (
            await owner.query(
              `SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
              AND attnum>0 AND NOT attisdropped AND attidentity<>'a' AND attgenerated='' ORDER BY attnum LIMIT 1`,
              [`yaparena.${table}`],
            )
          ).rows[0].attname;
          for (const sql of [
            `SELECT * FROM yaparena.${table} LIMIT 1`,
            `INSERT INTO yaparena.${table} DEFAULT VALUES`,
            `UPDATE yaparena.${table} SET ${column}=${column}`,
            `DELETE FROM yaparena.${table}`,
            `TRUNCATE yaparena.${table}`,
          ])
            await assert.rejects(encoder.query(sql), denied, sql);
        }
      // Every other table outside its manifest is closed too.
      for (const table of tables)
        if (!Object.hasOwn(encoderGrants, table))
          await assert.rejects(
            encoder.query(`SELECT 1 FROM yaparena.${table} LIMIT 1`),
            denied,
            table,
          );
    });

    it("publishes a verified replay with its history and room signal", async () => {
      const event = await finishedDebate();
      const jobs = createReplayJobs(encoder, [event.room]);
      const before = await cursor(event.room);
      assert.equal(await jobs.reconcile(), 1);
      const job = await jobs.claim();
      assert.equal(job.debateId, event.room);
      assert.equal(await jobs.bindSource(job, '"synthetic-etag"'), true);
      assert.equal(await jobs.heartbeat(job), true);
      assert.equal(await jobs.complete(job, "b".repeat(64)), true);
      assert.deepEqual(await jobs.ready(event.room, event.sourceKey), {
        packageKey: job.packageKey,
        hasCaptions: false,
      });
      assert.equal(
        (
          await owner.query("SELECT status FROM debates WHERE id=$1", [
            event.room,
          ])
        ).rows[0].status,
        "replay",
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT action,from_status,to_status,actor_user_id FROM event_history WHERE debate_id=$1",
            [event.room],
          )
        ).rows,
        [
          {
            action: "automatic_replay",
            from_status: "ended",
            to_status: "replay",
            actor_user_id: null,
          },
        ],
      );
      // The lifecycle triggers ran as the encoder: one summary each.
      assert.equal(await cursor(event.room), before + 2);
      assert.deepEqual(
        (
          await owner.query(
            `SELECT kind,refresh FROM community_room_events
            WHERE room_id=$1 AND cursor>$2 ORDER BY cursor`,
            [event.room, before],
          )
        ).rows,
        [
          { kind: "summary", refresh: null },
          { kind: "summary", refresh: "media" },
        ],
      );
    });

    it("changes no event beyond publishing an ended one", async () => {
      const event = await finishedDebate();
      const draft = await finishedDebate("ended", "draft");
      const jobs = createReplayJobs(encoder, [event.room]);
      await jobs.reconcile();
      const job = await jobs.claim();
      await jobs.bindSource(job, '"synthetic-etag"');
      assert.equal(await jobs.complete(job, "c".repeat(64)), true);
      // The guard applies to the encoder only: an operator still finalizes.
      assert.equal(
        (
          await runtime.query(
            "UPDATE debates SET status='finalized',updated_at=clock_timestamp() WHERE id=$1",
            [event.room],
          )
        ).rowCount,
        1,
      );
      for (const [sql, values] of [
        // Back from finalized, or a touch without a status change.
        ["UPDATE debates SET status='replay' WHERE id=$1", [event.room]],
        ["UPDATE debates SET updated_at=now() WHERE id=$1", [event.room]],
        [
          "UPDATE debates SET publication_state='hidden' WHERE id=$1",
          [event.room],
        ],
        ["UPDATE debates SET proposition='x' WHERE id=$1", [event.room]],
        ["SELECT proposition FROM debates WHERE id=$1", [event.room]],
        ["DELETE FROM debates WHERE id=$1", [event.room]],
        ["UPDATE topics SET id=id WHERE id=$1", [event.topic]],
        ["SELECT title FROM topics WHERE id=$1", [event.topic]],
        [
          "UPDATE debate_media SET debate_id=debate_id WHERE debate_id=$1",
          [event.room],
        ],
        [
          "UPDATE debate_media SET recording_key=recording_key WHERE debate_id=$1",
          [event.room],
        ],
        ["SELECT incident FROM debate_media WHERE debate_id=$1", [event.room]],
        [
          `INSERT INTO event_history(debate_id,action,from_status,to_status)
          VALUES($1,'operator_transition','replay','finalized')`,
          [event.room],
        ],
        [
          `INSERT INTO event_history(debate_id,action,from_status,to_status,actor_user_id)
          VALUES($1,'automatic_replay','ended','replay',1)`,
          [event.room],
        ],
        ["SELECT * FROM event_history WHERE debate_id=$1", [event.room]],
        [
          "UPDATE media_replay_jobs SET source_key=source_key WHERE id=$1",
          [job.id],
        ],
      ])
        await assert.rejects(encoder.query(sql, values), denied, sql);
      // Unpublished events are invisible, so nothing changes there.
      assert.equal(
        (
          await encoder.query("SELECT id FROM debates WHERE id=$1", [
            draft.room,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await encoder.query(
            "UPDATE debates SET status='replay' WHERE id=$1",
            [draft.room],
          )
        ).rowCount,
        0,
      );
      // Retention removes only long-cancelled jobs.
      assert.equal(
        (
          await encoder.query("DELETE FROM media_replay_jobs WHERE id=$1", [
            job.id,
          ])
        ).rowCount,
        0,
      );
    });

    it("advances only replay rooms in the community delivery log", async () => {
      const event = await finishedDebate();
      const other = await finishedDebate();
      await createReplayJobs(encoder, [event.room]).reconcile();
      const next = (await cursor(event.room)) + 1;
      for (const [sql, values] of [
        ["SELECT * FROM community_room_events WHERE room_id=$1", [event.room]],
        ["DELETE FROM community_room_events WHERE room_id=$1", [event.room]],
        [
          "UPDATE community_room_events SET kind=kind WHERE room_id=$1",
          [event.room],
        ],
        [
          "INSERT INTO community_room_events(room_id,cursor,kind) VALUES($1,$2,'message')",
          [event.room, next],
        ],
        [
          "INSERT INTO community_room_events(room_id,cursor,kind) VALUES($1,$2,'reset')",
          [event.room, next],
        ],
        [
          "INSERT INTO community_room_events(room_id,cursor,kind,refresh) VALUES($1,$2,'summary','round')",
          [event.room, next],
        ],
        // A room without a replay job.
        [
          "INSERT INTO community_room_events(room_id,cursor,kind) VALUES($1,$2,'summary')",
          [other.room, (await cursor(other.room)) + 1],
        ],
        ["INSERT INTO community_rooms(room_id) VALUES($1)", [randomUUID()]],
        ["DELETE FROM community_rooms WHERE room_id=$1", [event.room]],
        [
          "UPDATE community_rooms SET retained_after=0 WHERE room_id=$1",
          [event.room],
        ],
        [
          "SELECT retained_after FROM community_rooms WHERE room_id=$1",
          [event.room],
        ],
      ])
        await assert.rejects(encoder.query(sql, values), denied, sql);
      // Other rooms are invisible; the job's room is readable.
      assert.equal(
        (
          await encoder.query(
            "UPDATE community_rooms SET cursor=cursor+1 WHERE room_id=$1",
            [other.room],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await encoder.query(
            "SELECT cursor FROM community_rooms WHERE room_id=$1",
            [other.room],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await encoder.query(
            "SELECT cursor FROM community_rooms WHERE room_id=$1",
            [event.room],
          )
        ).rowCount,
        1,
      );
    });
  },
);
