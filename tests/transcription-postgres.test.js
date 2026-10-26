import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  DEBATER_CONSENT_VERSION,
  DebaterSettingsRequiredError,
  assertDebaterSettings,
  checkDebaterSettings,
  createDebaterSettings,
} from "../dist/features/transcription/debater-settings.js";
import { createTranscriptionRepository } from "../dist/features/transcription/repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";

// Decision 0012, pull request 2. Fixtures are this suite's own debates; no
// global clock runs here, so other suites sharing the database are unaffected.
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "live transcription storage",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime, settings, transcripts, windows, topicId;
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
      settings = createDebaterSettings(runtime);
      transcripts = createTranscriptionRepository(runtime);
      windows = createCoinDebateSandbox(runtime, "simulation", {
        turnWindows: true,
      });
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Transcripts','Synthetic transcript fixture','Support','Oppose','published') RETURNING id",
          [`transcripts-${randomUUID()}`],
        )
      ).rows[0].id;
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    const user = async () =>
      (await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id"))
        .rows[0].id;
    // A live demo debate (never competing for the featured slot) whose turn 1
    // started a second ago, side A speaking, with two consenting debaters.
    async function liveDebate({
      consent = true,
      turn = 1,
      status = "live",
      demo = true,
    } = {}) {
      const a = await user(),
        b = await user();
      for (const [id, language] of [
        [a, "fr"],
        [b, "en"],
      ])
        await settings.save(id, { language, consent });
      const debateId = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,
            rules_snapshot,live_started_at,is_demo)
          VALUES($1,$2,'Should transcripts be public?',$3,'published','preview-1',
            '{"initial_speaking_time_seconds":60,"maximum_duration_seconds":600}',
            clock_timestamp()-INTERVAL '1 minute',$4) RETURNING id`,
          [`transcripts-${randomUUID()}`, topicId, status, demo],
        )
      ).rows[0].id;
      await owner.query(
        "INSERT INTO event_participants(debate_id,user_id,side) VALUES($1,$2,'A'),($1,$3,'B')",
        [debateId, a, b],
      );
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
          remaining_ms,active_ms,last_resumed_at,recording_status)
        VALUES($1,'running',$2,$3,clock_timestamp()+INTERVAL '59 seconds',60000,0,
          clock_timestamp()-INTERVAL '1 second','recording')`,
        [debateId, turn % 2 ? "A" : "B", turn],
      );
      return { debateId, a, b };
    }
    const nowMs = async () =>
      Number(
        (
          await owner.query(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS n",
          )
        ).rows[0].n,
      );
    async function update(overrides = {}) {
      const now = await nowMs();
      return {
        jobId: "AJ_suite",
        sequence: 0,
        turnNumber: 1,
        sentAt: now,
        segments: [
          {
            provider: "deepgram",
            role: "primary",
            language: "fr",
            side: "A",
            startAt: now - 2000,
            endAt: now - 400,
            text: "Le nucléaire reste indispensable.",
            words: [{ w: "Le", s: 0, e: 150, c: 0.9 }],
            latencyMs: 380,
            audioMs: 1600,
          },
        ],
        ...overrides,
      };
    }
    const segments = async (debateId) =>
      (
        await owner.query(
          `SELECT turn_number,window_id,side,speaker_user_id::text AS speaker,language,provider,role,
            text,words,latency_ms,audio_ms,
            (extract(epoch FROM spoken_end_at)*1000)::bigint AS end_ms
          FROM transcript_segments WHERE debate_id=$1 ORDER BY id`,
          [debateId],
        )
      ).rows;

    it("stores account-level debater settings and checks them for matchmaking", async () => {
      const id = await user();
      assert.deepEqual(await checkDebaterSettings(runtime, id), {
        ready: false,
        missing: ["language", "consent"],
      });
      await assert.rejects(
        assertDebaterSettings(runtime, id),
        (error) =>
          error instanceof DebaterSettingsRequiredError &&
          error.status === 409 &&
          error.missing.length === 2,
      );
      const first = await settings.save(id, { language: "fr", consent: false });
      assert.deepEqual(
        { language: first.language, consented: first.consented },
        { language: "fr", consented: false },
      );
      assert.deepEqual(await checkDebaterSettings(runtime, id), {
        ready: false,
        missing: ["consent"],
      });
      const consented = await settings.save(id, {
        language: "fr",
        consent: true,
      });
      assert.equal(consented.consented, true);
      assert.equal(consented.consentVersion, DEBATER_CONSENT_VERSION);
      assert.ok(consented.consentedAt instanceof Date);
      const again = await settings.save(id, { language: "en", consent: true });
      assert.equal(
        again.consentedAt.getTime(),
        consented.consentedAt.getTime(),
        "renewing the same wording keeps the original consent time",
      );
      assert.equal(await assertDebaterSettings(runtime, id), "en");
      // Consent to older wording no longer counts.
      await owner.query(
        "UPDATE debater_settings SET consent_version='2020-01-01' WHERE user_id=$1",
        [id],
      );
      assert.equal((await settings.get(id)).consented, false);
      const withdrawn = await settings.save(id, {
        language: "en",
        consent: false,
      });
      assert.equal(withdrawn.consentedAt, null);
    });

    it("stores a live turn's segments in its window, once per sequence", async () => {
      const { debateId, a } = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      const window = (
        await owner.query(
          "SELECT id FROM coin_debate_rounds WHERE debate_id=$1",
          [debateId],
        )
      ).rows[0].id;
      const value = await update();
      const results = await Promise.all([
        transcripts.ingest(debateId, value),
        transcripts.ingest(debateId, value),
        transcripts.ingest(debateId, value),
      ]);
      for (const result of results) {
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, {
          accepted: true,
          sequence: 0,
          turnNumber: 1,
          stored: 1,
          inWindow: 1,
        });
      }
      const [row, ...others] = await segments(debateId);
      assert.equal(others.length, 0, "retries store nothing more");
      assert.equal(row.window_id, window);
      assert.equal(row.side, "A");
      assert.equal(row.speaker, a);
      assert.equal(row.language, "fr");
      assert.equal(row.role, "primary");
      assert.deepEqual(row.words, [{ w: "Le", s: 0, e: 150, c: 0.9 }]);
      assert.equal(row.latency_ms, 380);
      await assert.rejects(
        owner.query(
          "UPDATE transcript_segments SET text='x' WHERE debate_id=$1",
          [debateId],
        ),
        /append-only/,
      );
      const session = await transcripts.session(debateId, "AJ_suite");
      assert.equal(session.debateStatus, "live");
      assert.equal(session.media.turnNumber, 1);
      assert.equal(session.media.activeSide, "A");
      assert.equal(session.nextSequence, 1);
      assert.deepEqual(session.speakers, [
        { side: "A", language: "fr", consented: true },
        { side: "B", language: "en", consented: true },
      ]);
      assert.equal(
        (await transcripts.session(debateId, "AJ_other")).nextSequence,
        0,
      );
      assert.equal(await transcripts.session(randomUUID(), "AJ_suite"), null);
    });

    it("marks speech after the window's cutoff as outside any window", async () => {
      const { debateId } = await liveDebate();
      await windows.openTurnWindows(20, [debateId]);
      // The turn was paused and resumed past its window's cutoff.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE coin_debate_rounds DISABLE TRIGGER coin_debate_round_guard",
        );
        await client.query(
          "UPDATE coin_debate_rounds SET opens_at=clock_timestamp()-INTERVAL '30 seconds',closes_at=clock_timestamp()-INTERVAL '1 second' WHERE debate_id=$1",
          [debateId],
        );
        await client.query(
          "ALTER TABLE coin_debate_rounds ENABLE TRIGGER coin_debate_round_guard",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const now = await nowMs();
      const value = await update();
      value.segments.push({
        ...value.segments[0],
        startAt: now - 5000,
        endAt: now - 3000,
      });
      const result = await transcripts.ingest(debateId, value);
      assert.equal(result.body.inWindow, 1);
      const rows = await segments(debateId);
      assert.equal(rows[0].window_id, null, "ended after the cutoff");
      assert.notEqual(rows[1].window_id, null, "ended before the cutoff");
    });

    it("accepts the turn that just ended, and refuses stale or future turns", async () => {
      const { debateId } = await liveDebate({ turn: 2 });
      assert.equal(
        (await transcripts.ingest(debateId, await update({ turnNumber: 1 })))
          .status,
        200,
        "the final flush of the turn that ended a second ago",
      );
      for (const turnNumber of [3, 5])
        assert.deepEqual(
          (
            await transcripts.ingest(
              debateId,
              await update({ turnNumber, sequence: turnNumber }),
            )
          ).body,
          {
            error: "stale turn",
            code: "stale_turn",
            debateStatus: "live",
            turnNumber: 2,
          },
        );
      await owner.query(
        "UPDATE debate_media SET last_resumed_at=clock_timestamp()-INTERVAL '20 seconds' WHERE debate_id=$1",
        [debateId],
      );
      assert.equal(
        (
          await transcripts.ingest(
            debateId,
            await update({ turnNumber: 1, sequence: 9 }),
          )
        ).status,
        409,
        "the grace period is over",
      );
      // After the end, only the last turn's flush, briefly.
      await owner.query(
        "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
        [debateId],
      );
      await owner.query(
        "UPDATE debate_media SET state='ended',active_side=NULL,turn_deadline_at=NULL WHERE debate_id=$1",
        [debateId],
      );
      const flush = await update({ turnNumber: 2, sequence: 10 });
      flush.segments[0].side = "B";
      assert.equal((await transcripts.ingest(debateId, flush)).status, 200);
      assert.equal(
        (await transcripts.ingest(randomUUID(), await update())).status,
        404,
      );
    });

    it("refuses the wrong side and speakers without consent", async () => {
      const { debateId } = await liveDebate();
      const wrong = await update();
      wrong.segments[0].side = "B";
      assert.deepEqual((await transcripts.ingest(debateId, wrong)).body, {
        error: "segment side does not match the turn",
        code: "wrong_side",
        side: "A",
      });
      const silent = await liveDebate({ consent: false });
      const refused = await transcripts.ingest(silent.debateId, await update());
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "consent_required");
      assert.equal((await segments(silent.debateId)).length, 0);
    });

    it("corrects a drifted agent clock and never stores speech after receipt", async () => {
      const { debateId } = await liveDebate();
      const value = await update(),
        drift = 20_000;
      value.sentAt -= drift;
      value.segments[0].startAt -= drift;
      value.segments[0].endAt -= drift;
      await transcripts.ingest(debateId, value);
      const [row] = await segments(debateId);
      const now = await nowMs();
      assert.ok(Math.abs(Number(row.end_ms) - (now - 400)) < 1500);
      const ahead = await update({ sequence: 1 });
      ahead.segments[0].endAt += 500;
      ahead.segments[0].startAt += 500;
      await transcripts.ingest(debateId, ahead);
      const [, late] = await segments(debateId);
      assert.ok(Number(late.end_ms) <= (await nowMs()));
    });

    it("claims one dispatch per debate and retries failures after a backoff", async () => {
      // Ready, not live: a non-demo fixture that never competes for the
      // featured slot. Demo debates get no transcriber.
      const { debateId } = await liveDebate({ status: "ready", demo: false });
      const demo = await liveDebate({ status: "ready" });
      assert.equal(
        (await transcripts.dispatchCandidates(500)).includes(demo.debateId),
        false,
      );
      assert.ok((await transcripts.dispatchCandidates(500)).includes(debateId));
      const claims = await Promise.all([
        transcripts.claimDispatch(debateId),
        transcripts.claimDispatch(debateId),
      ]);
      assert.deepEqual(claims.sort(), [1, null]);
      await transcripts.dispatchSettled(debateId, null);
      assert.equal(await transcripts.claimDispatch(debateId), null, "backoff");
      await owner.query(
        "UPDATE transcription_dispatches SET updated_at=clock_timestamp()-INTERVAL '1 minute' WHERE debate_id=$1",
        [debateId],
      );
      assert.equal(await transcripts.claimDispatch(debateId), 2);
      await transcripts.dispatchSettled(debateId, "AD_suite");
      assert.equal(await transcripts.claimDispatch(debateId), null);
      assert.equal(
        (await transcripts.dispatchCandidates(500)).includes(debateId),
        false,
      );
      const silent = await liveDebate({
        consent: false,
        status: "ready",
        demo: false,
      });
      assert.equal(
        (await transcripts.dispatchCandidates(500)).includes(silent.debateId),
        false,
        "no consenting speaker, no transcriber",
      );
    });

    it("prunes old ingest receipts and shadow segments only", async () => {
      const { debateId } = await liveDebate();
      const value = await update();
      value.segments.push({
        ...value.segments[0],
        role: "shadow",
        provider: "elevenlabs",
      });
      await transcripts.ingest(debateId, value);
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE transcription_updates DISABLE TRIGGER transcription_updates_append_only",
        );
        await client.query(
          "ALTER TABLE transcript_segments DISABLE TRIGGER transcript_segments_append_only",
        );
        await client.query(
          "UPDATE transcription_updates SET accepted_at=clock_timestamp()-INTERVAL '8 days' WHERE debate_id=$1",
          [debateId],
        );
        await client.query(
          "UPDATE transcript_segments SET created_at=clock_timestamp()-INTERVAL '91 days' WHERE debate_id=$1",
          [debateId],
        );
        await client.query(
          "ALTER TABLE transcription_updates ENABLE TRIGGER transcription_updates_append_only",
        );
        await client.query(
          "ALTER TABLE transcript_segments ENABLE TRIGGER transcript_segments_append_only",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const pruned = await transcripts.pruneExpired();
      assert.ok(pruned.receipts >= 1);
      assert.ok(pruned.shadow >= 1);
      assert.deepEqual(
        (await segments(debateId)).map((row) => row.role),
        ["primary"],
      );
    });
  },
);
