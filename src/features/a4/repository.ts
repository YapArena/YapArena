import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  lockAccount,
  assertActiveSession,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
import {
  databaseFailure,
  type TransactionOptions,
  withTransaction,
} from "../../platform/transaction.ts";
import {
  A4Error,
  RULE,
  YAP,
  decimal,
  digest,
  executeRound,
  priceRound,
  randomWord,
  reservation,
  secureSeed,
  validateOrder,
  validateTerms,
  type Order,
  type Outcome,
  type Pricing,
  type Terms,
} from "./engine.ts";
import {
  account,
  balance,
  post,
  reconcile,
  transfer,
  type Posting,
} from "./ledger.ts";
import { generateBots } from "./bots.ts";
import { requirePlayAsset } from "./funding.ts";
import { readTimeline } from "./timeline.ts";

export type PlayFundingPolicy = {
  starterCoins: number;
  refillCoins: number;
  botCoins: number;
};
export type A4Mode = "disabled" | "yap-coins" | "bots";
export type Actor = { userId: string; tokenHash: string };
export type RunConfig = Terms & {
  argumentLabel?: string;
  population: number;
  preset: "heterogeneous" | "reference";
  quantity: number;
  periods: number;
  delayed: boolean;
  roundSeconds: number;
};
type Session = {
  id: string;
  creator_id: string;
  debate_id: string;
  proposition: string;
  topic_id: string;
  asset: string;
  mode: "human" | "mixed" | "observer";
  state: "running" | "paused" | "complete" | "archived";
  config: RunConfig;
  seed: string;
  reveal_at: Date;
  speed: number;
};
type Round = {
  id: string;
  session_id: string;
  asset: string;
  period: number;
  state:
    "scheduled" | "open" | "locked" | "priced" | "pending" | "settled" | "void";
  opens_at: Date;
  closes_at: Date;
  seed: string;
  seed_commitment: string;
  snapshot: Order[] | null;
  snapshot_hash: string | null;
  pricing: Pricing | null;
  revealed_at: Date | null;
  locked_at: Date | null;
};
type StoredSubmission = {
  participant: string;
  user_id: string | null;
  kind: Order["kind"];
  side: Order["side"];
  limit_value: string;
  quantity: number;
  request_key: string;
  outcome: Outcome | null;
};
const toOrder = (r: StoredSubmission): Order => ({
  participant: r.participant,
  kind: r.kind,
  side: r.side,
  limit: r.limit_value,
  quantity: r.quantity,
});
// A revealed book row's outcome as any viewer sees it. It names its fields
// so the participant it belongs to, for a person their account id, never
// leaves the server.
const bookOutcome = (o: Outcome, state: Round["state"]) => ({
  accepted: o.accepted,
  executed: o.executed,
  status: state === "settled" && o.executed ? "settled" : o.status,
  premium: o.premium,
  fee: o.fee,
  payout: o.payout,
  net: o.net,
  reservation: o.reservation,
  released: o.released,
  premiumExact: o.premiumExact,
  feeExact: o.feeExact,
  payoutExact: o.payoutExact,
  premiumDust: o.premiumDust,
  payoutDust: o.payoutDust,
});
const scopeOf = (s: Session) => (s.mode === "human" ? "global" : s.id);
const available = (s: Session, participant: string, userId: string | null) =>
  account(scopeOf(s), participant, "available", userId, s.asset);
const center = (s: Session) =>
  account(scopeOf(s), `center:${s.id}`, "center", null, s.asset);
const vault = (s: Session, r: Round) =>
  account(scopeOf(s), `round:${r.id}`, "collateral", null, s.asset);
const fees = (s: Session, r: Round, pending = true) =>
  account(
    scopeOf(s),
    `round:${r.id}`,
    pending ? "fees_pending" : "fees",
    null,
    s.asset,
  );
const reserved = (s: Session, r: Round, o: Order, userId: string | null) =>
  account(
    scopeOf(s),
    `round:${r.id}:${o.participant}`,
    "reserved",
    userId,
    s.asset,
  );

export function runConfig(
  input: Partial<RunConfig> = {},
  human = false,
): RunConfig {
  const config: RunConfig = {
    rule: RULE,
    epsilon: 50000,
    feeBps: 0,
    maxQuantity: 100,
    capacity: 1001,
    population: human ? 0 : 500,
    preset: "heterogeneous",
    quantity: 1,
    periods: 1,
    delayed: false,
    roundSeconds: human ? 300 : 60,
    ...input,
  };
  if (config.argumentLabel !== undefined) {
    if (
      typeof config.argumentLabel !== "string" ||
      !config.argumentLabel.trim() ||
      config.argumentLabel.trim().length > 80 ||
      /\p{Cc}/u.test(config.argumentLabel)
    )
      throw new A4Error(
        "argument label must be 1–80 characters on one line",
        400,
      );
    config.argumentLabel = config.argumentLabel.trim();
  }
  validateTerms(config);
  if (
    !Number.isInteger(config.population) ||
    config.population < (human ? 0 : 1) ||
    config.population > (human ? 0 : 1000) ||
    !["heterogeneous", "reference"].includes(config.preset) ||
    !Number.isInteger(config.quantity) ||
    config.quantity < 1 ||
    config.quantity > config.maxQuantity ||
    !Number.isInteger(config.periods) ||
    config.periods < 1 ||
    config.periods > 10 ||
    typeof config.delayed !== "boolean" ||
    !Number.isInteger(config.roundSeconds) ||
    config.roundSeconds < 10 ||
    config.roundSeconds > 3600 ||
    config.population >= config.capacity
  )
    throw new A4Error("invalid round configuration", 400);
  if (!config.delayed && config.periods !== 1)
    throw new A4Error("multiple periods require delayed settlement", 400);
  return config;
}
// Every A4 transaction is bounded and reports constraint and contention
// failures as A4 errors; a busy request is safe to retry with its key.
const a4Transaction = {
  statementTimeoutMs: 30000,
  lockTimeoutMs: 5000,
  guardConnection: true,
  mapError(error: unknown) {
    switch (databaseFailure(error)) {
      case "check_violation":
        return new A4Error("funds or accounting invariant failed");
      case "unique_violation":
        return new A4Error("conflicting or duplicate commitment");
      case "busy":
        return new A4Error(
          "temporarily busy; retry with the same request key",
          503,
        );
      default:
        return error;
    }
  },
} as const satisfies TransactionOptions;

// Decision 0010: ordinary YAP play (human runs and the account-wide balance,
// ledger scope 'global') is retired and its ledger frozen. Bot runs keep
// writing their own scopes; past YAP runs and balances stay readable.
const retired = () =>
  new A4Error(
    "Yap Coins play is retired; past runs and balances stay readable",
    410,
  );

export function createA4Repository(
  database: Pool,
  configuredMode: A4Mode = "disabled",
  fundingPolicy: PlayFundingPolicy = {
    starterCoins: 1000,
    refillCoins: 1000,
    botCoins: 1000,
  },
) {
  // "yap-coins" allowed human runs only, so it now enables nothing.
  const mode: A4Mode = configuredMode === "bots" ? "bots" : "disabled";
  for (const [name, amount] of Object.entries(fundingPolicy))
    if (
      !Number.isInteger(amount) ||
      amount < (name === "botCoins" ? 105 : 1) ||
      amount > 1000000
    )
      throw new A4Error("invalid play funding policy", 400);
  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    actor?: Actor,
  ) {
    return withTransaction(
      database,
      async (client) => {
        if (actor) {
          if (!(await lockAccount(client, actor.userId)))
            throw new SessionUnavailableError("account unavailable");
          await assertActiveSession(client, actor.userId, actor.tokenHash);
        }
        return work(client);
      },
      a4Transaction,
    );
  }
  async function enabled(client: PoolClient) {
    const result = await client.query<{
      enabled: boolean;
      bots_enabled: boolean;
    }>("SELECT enabled,bots_enabled FROM a4_controls WHERE id=true FOR SHARE");
    if (
      mode !== "bots" ||
      !result.rows[0]?.enabled ||
      !result.rows[0].bots_enabled
    )
      throw new A4Error("Yap Coins participation is disabled", 503);
    requirePlayAsset(YAP.id, "play");
  }
  async function getSession(client: PoolClient, id: string, userId?: string) {
    const result = await client.query<Session>(
      "SELECT * FROM a4_sessions WHERE id=$1 FOR UPDATE",
      [id],
    );
    const s = result.rows[0];
    if (!s || (userId && s.mode !== "human" && s.creator_id !== userId))
      throw new A4Error("run not found", 404);
    if (userId && s.mode === "human" && s.creator_id !== userId) {
      const allowed = await client.query(
        "SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published' UNION ALL SELECT 1 FROM a4_submissions o JOIN a4_rounds r ON r.id=o.round_id WHERE r.session_id=$2 AND o.user_id=$3 LIMIT 1",
        [s.debate_id, s.id, userId],
      );
      if (!allowed.rowCount) throw new A4Error("run not found", 404);
    }
    return s;
  }
  async function audit(
    client: PoolClient,
    sessionId: string | null,
    actorId: string | null,
    action: string,
    metadata: Record<string, unknown> = {},
  ) {
    await client.query(
      "INSERT INTO a4_audit(id,session_id,actor_id,action,metadata) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), sessionId, actorId, action, JSON.stringify(metadata)],
    );
  }
  async function idempotent<T>(
    client: PoolClient,
    actor: Actor,
    key: string,
    operation: string,
    payload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(key))
      throw new A4Error(
        "request key must contain 8–80 letters, numbers, underscores or hyphens",
        400,
      );
    const hash = digest(payload);
    const previous = await client.query<{
      operation: string;
      payload_hash: string;
      response: T;
    }>(
      "SELECT operation,payload_hash,response FROM a4_requests WHERE user_id=$1 AND request_key=$2",
      [actor.userId, key],
    );
    if (previous.rows[0]) {
      if (
        previous.rows[0].operation !== operation ||
        previous.rows[0].payload_hash !== hash
      )
        throw new A4Error("request key conflicts with previous terms");
      return previous.rows[0].response;
    }
    const result = await work();
    await client.query(
      "INSERT INTO a4_requests(user_id,request_key,operation,payload_hash,response) VALUES($1,$2,$3,$4,$5)",
      [actor.userId, key, operation, hash, JSON.stringify(result)],
    );
    return result;
  }
  async function issue(
    client: PoolClient,
    scope: string,
    participant: string,
    userId: string | null,
    reference: string,
    coins: bigint,
  ) {
    const exists = await client.query(
      "SELECT reference FROM a4_journals WHERE reference=$1",
      [reference],
    );
    if (exists.rowCount) return false;
    await post(
      client,
      reference,
      "play_issuance",
      transfer(
        account(scope, "play-issuer", "issuer"),
        account(scope, participant, "available", userId),
        coins * BigInt(YAP.face),
      ),
      { policy: "nonredeemable_play_credit" },
    );
    return true;
  }
  async function admit(
    client: PoolClient,
    s: Session,
    r: Round,
    orders: { order: Order; userId: string | null; key: string }[],
  ) {
    const current = await client.query<{ count: string }>(
      "SELECT count(*)::text FROM a4_submissions WHERE round_id=$1",
      [r.id],
    );
    if (Number(current.rows[0]!.count) + orders.length > s.config.capacity)
      throw new A4Error("round capacity reached");
    const postings: Posting[] = [];
    for (const { order, userId } of orders) {
      validateOrder(order, s.config);
      postings.push(
        ...transfer(
          available(s, order.participant, userId),
          reserved(s, r, order, userId),
          reservation(order.quantity, BigInt(YAP.face), s.config.feeBps),
        ),
      );
      postings.push(
        ...transfer(
          center(s),
          vault(s, r),
          BigInt(order.quantity) * BigInt(YAP.face),
        ),
      );
    }
    if (postings.length)
      await post(
        client,
        `reserve:${r.id}:${orders[0]!.order.participant}`,
        "reservation",
        postings,
        { roundId: r.id },
      );
    const cutoff = await client.query<{ valid: boolean }>(
      "SELECT clock_timestamp()<closes_at AS valid FROM a4_rounds WHERE id=$1",
      [r.id],
    );
    if (!cutoff.rows[0]?.valid) throw new A4Error("round is past cutoff");
    const rows = orders.map(({ order, userId, key }) => ({
      participant: order.participant,
      userId,
      kind: order.kind,
      side: order.side,
      limit: order.limit,
      quantity: order.quantity,
      key,
    }));
    if (rows.length) {
      const inserted = await client.query(
        `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp()<closes_at AS valid FROM a4_rounds WHERE id=$1)
        INSERT INTO a4_submissions(round_id,asset,participant,user_id,kind,side,limit_value,quantity,request_key)
      SELECT $1,$2,participant,"userId"::bigint,kind,side,limit_value,quantity,key FROM jsonb_to_recordset($3) AS r(participant text,"userId" text,kind text,side text,limit_value text,quantity integer,key text) WHERE (SELECT valid FROM cutoff)`,
        [
          r.id,
          s.asset,
          JSON.stringify(
            rows.map((row) => ({ ...row, limit_value: row.limit })),
          ),
        ],
      );
      if (inserted.rowCount !== rows.length)
        throw new A4Error("round is past cutoff");
    }
  }
  async function openRound(client: PoolClient, s: Session, r: Round) {
    const cutoff = await client.query<{ valid: boolean }>(
      "SELECT clock_timestamp()<closes_at AS valid FROM a4_rounds WHERE id=$1",
      [r.id],
    );
    if (cutoff.rows[0]?.valid) {
      const bots = generateBots(
        s.seed,
        r.period,
        s.config.population,
        s.config.preset,
        s.config.quantity,
        s.config.feeBps,
      );
      const grants = bots.flatMap((o) =>
        transfer(
          account(scopeOf(s), "play-issuer", "issuer"),
          available(s, o.participant, null),
          BigInt(YAP.face) * BigInt(fundingPolicy.botCoins),
        ),
      );
      await post(client, `bot-issuance:${r.id}`, "play_bot_issuance", grants, {
        population: bots.length,
      });
      await admit(
        client,
        s,
        r,
        bots.map((order) => ({
          order,
          userId: null,
          key: `bot-${r.period}-${order.participant}`,
        })),
      );
    }
    await client.query("UPDATE a4_rounds SET state='open' WHERE id=$1", [r.id]);
    r.state = "open";
    await audit(client, s.id, null, "round.open", { roundId: r.id });
  }
  async function transition(
    client: PoolClient,
    s: Session,
    r: Round,
    force: boolean,
  ) {
    const clock = (
      await client.query<{ started: boolean; pastCutoff: boolean }>(
        'SELECT clock_timestamp()>=opens_at AS started,clock_timestamp()>=closes_at AS "pastCutoff" FROM a4_rounds WHERE id=$1',
        [r.id],
      )
    ).rows[0]!;
    if (r.state === "scheduled") {
      // Retired YAP play opens no new human round. Rounds already open still
      // lock and settle, so the freeze migration can apply once they finish.
      if (s.mode === "human") {
        await voidOpen(client, s, r, "yap_play_retired");
        return;
      }
      const control = await client.query<{
        enabled: boolean;
        bots_enabled: boolean;
      }>("SELECT enabled,bots_enabled FROM a4_controls WHERE id=true");
      if (
        mode !== "bots" ||
        !control.rows[0]?.enabled ||
        !control.rows[0].bots_enabled
      ) {
        await voidOpen(client, s, r, "admission_disabled");
        return;
      }
      if (s.state !== "running" && clock.pastCutoff && !force) {
        await voidOpen(client, s, r, "paused_window_expired");
        return;
      }
      if ((s.state === "running" && clock.started) || force)
        await openRound(client, s, r);
      return;
    }
    if (r.state === "open") {
      if (!clock.pastCutoff && !force) return;
      const rows = await client.query<StoredSubmission>(
        "SELECT * FROM a4_submissions WHERE round_id=$1 ORDER BY participant",
        [r.id],
      );
      const snapshot = rows.rows.map(toOrder);
      await client.query(
        "UPDATE a4_rounds SET state='locked',snapshot=$2,snapshot_hash=$3,locked_at=clock_timestamp() WHERE id=$1",
        [
          r.id,
          JSON.stringify(snapshot),
          digest({
            rule: RULE,
            config: s.config,
            roundId: r.id,
            commitment: r.seed_commitment,
            orders: snapshot,
          }),
        ],
      );
      await audit(client, s.id, null, "round.lock", { roundId: r.id });
      return;
    }
    if (r.state === "locked") {
      if (
        r.snapshot_hash !==
        digest({
          rule: RULE,
          config: s.config,
          roundId: r.id,
          commitment: r.seed_commitment,
          orders: r.snapshot,
        })
      )
        throw new A4Error("locked snapshot integrity failure", 503);
      const pricing = priceRound(
        r.snapshot!,
        s.config,
        randomWord(r.seed, "branch"),
        randomWord(r.seed, "price"),
      );
      await client.query(
        "UPDATE a4_rounds SET state='priced',pricing=$2 WHERE id=$1",
        [r.id, JSON.stringify(pricing)],
      );
      await audit(client, s.id, null, "round.price", { roundId: r.id });
      return;
    }
    if (r.state === "priced") {
      const outcomes = executeRound(
        r.snapshot!,
        s.config,
        r.pricing!,
        BigInt(YAP.face),
      );
      const rows = await client.query<StoredSubmission>(
        "SELECT * FROM a4_submissions WHERE round_id=$1 ORDER BY participant",
        [r.id],
      );
      const postings: Posting[] = [];
      for (const [i, o] of outcomes.entries()) {
        const order = r.snapshot![i]!,
          userId = rows.rows[i]!.user_id;
        const reserve = reserved(s, r, order, userId);
        postings.push(
          ...transfer(
            reserve,
            available(s, order.participant, userId),
            BigInt(o.released),
          ),
        );
        postings.push(...transfer(reserve, vault(s, r), BigInt(o.premium)));
        postings.push(...transfer(reserve, fees(s, r), BigInt(o.fee)));
      }
      if (postings.length)
        await post(client, `execute:${r.id}`, "execution", postings, {
          roundId: r.id,
        });
      if (outcomes.length)
        await client.query(
          `UPDATE a4_submissions s SET outcome=r.outcome FROM jsonb_to_recordset($2) AS r(participant text,outcome jsonb) WHERE s.round_id=$1 AND s.participant=r.participant`,
          [
            r.id,
            JSON.stringify(
              outcomes.map((o) => ({ participant: o.participant, outcome: o })),
            ),
          ],
        );
      await client.query("UPDATE a4_rounds SET state='pending' WHERE id=$1", [
        r.id,
      ]);
      await audit(client, s.id, null, "round.execute", { roundId: r.id });
    }
  }
  async function settle(client: PoolClient, s: Session) {
    const pending = await client.query<Round>(
      "SELECT * FROM a4_rounds WHERE session_id=$1 ORDER BY period FOR UPDATE",
      [s.id],
    );
    const eligible = (
      await client.query<{ eligible: boolean }>(
        "SELECT clock_timestamp()>=reveal_at AS eligible FROM a4_sessions WHERE id=$1",
        [s.id],
      )
    ).rows[0]!.eligible;
    if (
      pending.rows.some(
        (r) => !["pending", "settled", "void"].includes(r.state),
      ) ||
      !eligible
    )
      return;
    for (const r of pending.rows.filter((r) => r.state === "pending")) {
      const submissions = await client.query<StoredSubmission>(
        "SELECT * FROM a4_submissions WHERE round_id=$1 ORDER BY participant",
        [r.id],
      );
      const postings: Posting[] = [];
      let total = 0n;
      for (const o of submissions.rows) {
        const payout = BigInt(o.outcome!.payout);
        total += payout;
        postings.push(
          ...transfer(
            vault(s, r),
            available(s, o.participant, o.user_id),
            payout,
          ),
        );
      }
      const backing = await balance(client, vault(s, r));
      if (total > backing)
        throw new A4Error("center backing invariant failed", 503);
      postings.push(...transfer(vault(s, r), center(s), backing - total));
      postings.push(
        ...transfer(
          fees(s, r),
          fees(s, r, false),
          await balance(client, fees(s, r)),
        ),
      );
      await post(client, `settle:${r.id}`, "settlement", postings, {
        roundId: r.id,
        roundShare: r.pricing!.share,
        rounding: "premium/fee ceil; payout floor; exact dust in receipt",
      });
      await client.query(
        "UPDATE a4_rounds SET state='settled',revealed_at=clock_timestamp() WHERE id=$1",
        [r.id],
      );
      await audit(client, s.id, null, "round.settle", { roundId: r.id });
    }
    await client.query(
      "UPDATE a4_rounds SET revealed_at=clock_timestamp() WHERE session_id=$1 AND state='void' AND revealed_at IS NULL",
      [s.id],
    );
    await reconcile(client, scopeOf(s));
    if (s.state !== "archived")
      await client.query(
        "UPDATE a4_sessions SET state='complete' WHERE id=$1",
        [s.id],
      );
  }
  async function processRound(sessionId: string, force = false) {
    return transaction(async (client) => {
      const s = await getSession(client, sessionId);
      const result = await client.query<Round>(
        "SELECT * FROM a4_rounds WHERE session_id=$1 AND state NOT IN ('pending','settled','void') ORDER BY period LIMIT 1 FOR UPDATE",
        [s.id],
      );
      if (result.rows[0]) {
        await transition(client, s, result.rows[0], force);
      }
      await settle(client, s);
    });
  }
  return Object.freeze({
    mode,
    async publication(actor: Actor, publish?: boolean) {
      return transaction(async (client) => {
        if (publish === true)
          await client.query(
            "INSERT INTO a4_public_publishers(user_id) VALUES($1) ON CONFLICT DO NOTHING",
            [actor.userId],
          );
        if (publish === false)
          await client.query(
            "DELETE FROM a4_public_publishers WHERE user_id=$1",
            [actor.userId],
          );
        const result = await client.query(
          "SELECT 1 FROM a4_public_publishers WHERE user_id=$1",
          [actor.userId],
        );
        if (publish !== undefined)
          await audit(client, null, actor.userId, "discovery.publication", {
            published: publish,
          });
        return { published: Boolean(result.rowCount) };
      }, actor);
    },
    async create(
      actor: Actor,
      key: string,
      input: {
        debateId: string;
        mode: Session["mode"];
        config?: Partial<RunConfig>;
        seed?: string;
        speed?: number;
      },
    ) {
      if (input.mode === "human") throw retired();
      const config = runConfig(input.config);
      if (
        !["mixed", "observer"].includes(input.mode) ||
        ![1, 5, 20].includes(input.speed ?? 1) ||
        (input.seed !== undefined &&
          (input.mode !== "observer" ||
            typeof input.seed !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(input.seed)))
      )
        throw new A4Error("invalid run mode or seed", 400);
      return transaction(
        (client) =>
          idempotent(
            client,
            actor,
            key,
            "create",
            { ...input, config },
            async () => {
              await enabled(client);
              const visible = await client.query<{
                proposition: string;
                topic_id: string;
              }>(
                "SELECT d.proposition,d.topic_id FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'",
                [input.debateId],
              );
              if (!visible.rowCount) throw new A4Error("debate not found", 404);
              const active = await client.query(
                "SELECT id FROM a4_sessions WHERE creator_id=$1 AND state IN ('running','paused')",
                [actor.userId],
              );
              if (active.rowCount! >= 3)
                throw new A4Error(
                  "finish or archive an active run before creating another",
                );
              const id = randomUUID(),
                seed = input.seed ?? secureSeed(),
                speed = input.speed ?? 1;
              const duration = Math.max(
                10,
                Math.ceil(config.roundSeconds / speed),
              );
              const created = await client.query<Session>(
                `INSERT INTO a4_sessions(id,creator_id,debate_id,asset,mode,state,config,seed,reveal_at,speed,proposition,topic_id) VALUES($1,$2,$3,'YAP',$4,'running',$5,$6,clock_timestamp()+($7*INTERVAL '1 second'),$8,$9,$10) RETURNING *`,
                [
                  id,
                  actor.userId,
                  input.debateId,
                  input.mode,
                  JSON.stringify(config),
                  seed,
                  duration * config.periods,
                  speed,
                  visible.rows[0]!.proposition,
                  visible.rows[0]!.topic_id,
                ],
              );
              const s = created.rows[0]!;
              await post(
                client,
                `center-issuance:${id}`,
                "play_center_issuance",
                transfer(
                  account(scopeOf(s), "play-issuer", "issuer"),
                  center(s),
                  BigInt(config.capacity) *
                    BigInt(config.maxQuantity) *
                    BigInt(config.periods) *
                    BigInt(YAP.face),
                ),
                {
                  capacity: config.capacity,
                  maxQuantity: config.maxQuantity,
                  periods: config.periods,
                },
              );
              if (s.mode !== "observer")
                await issue(
                  client,
                  scopeOf(s),
                  `user:${actor.userId}`,
                  actor.userId,
                  `starter:${scopeOf(s)}:${actor.userId}`,
                  BigInt(fundingPolicy.starterCoins),
                );
              for (let period = 1; period <= config.periods; period++) {
                const roundSeed = digest({
                  seed: s.seed,
                  domain: "price",
                  period,
                });
                const rows = await client.query<Round>(
                  `INSERT INTO a4_rounds(id,session_id,asset,period,state,opens_at,closes_at,seed,seed_commitment) VALUES($1,$2,'YAP',$3,'scheduled',(SELECT reveal_at FROM a4_sessions WHERE id=$2)-($4*INTERVAL '1 second'),(SELECT reveal_at FROM a4_sessions WHERE id=$2)-($5*INTERVAL '1 second'),$6,$7) RETURNING *`,
                  [
                    randomUUID(),
                    id,
                    period,
                    duration * (config.periods - period + 1),
                    duration * (config.periods - period),
                    roundSeed,
                    digest(roundSeed),
                  ],
                );
                if (period === 1) await openRound(client, s, rows.rows[0]!);
              }
              await audit(client, id, actor.userId, "run.create", {
                mode: s.mode,
              });
              return { id };
            },
          ),
        actor,
      );
    },
    async submit(
      actor: Actor,
      key: string,
      roundId: string,
      terms: {
        side: Order["side"];
        limit: string;
        quantity: number;
        rule: string;
      },
    ) {
      decimal(terms.limit);
      return transaction(
        (client) =>
          idempotent(
            client,
            actor,
            key,
            "submit",
            { roundId, ...terms },
            async () => {
              const found = await client.query<{ session_id: string }>(
                "SELECT session_id FROM a4_rounds WHERE id=$1",
                [roundId],
              );
              if (!found.rows[0]) throw new A4Error("round not found", 404);
              const s = await getSession(
                client,
                found.rows[0].session_id,
                actor.userId,
              );
              if (s.mode === "human") throw retired();
              await enabled(client);
              const visible = await client.query(
                "SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published' AND d.status NOT IN ('cancelled','void_review')",
                [s.debate_id],
              );
              if (!visible.rowCount)
                throw new A4Error("market is unavailable for new commitments");
              if (s.mode === "observer")
                throw new A4Error(
                  "observer runs cannot accept human participation",
                  403,
                );
              if (s.state !== "running" || terms.rule !== RULE)
                throw new A4Error("run paused, closed or terms changed");
              const round = await client.query<Round>(
                "SELECT * FROM a4_rounds WHERE id=$1 FOR UPDATE",
                [roundId],
              );
              const r = round.rows[0]!;
              // Read clock after account/session/run/round lock waits. Receipt time is not admission.
              const cutoff = await client.query<{ valid: boolean }>(
                "SELECT clock_timestamp()<closes_at AND state='open' AS valid FROM a4_rounds WHERE id=$1",
                [r.id],
              );
              if (!cutoff.rows[0]!.valid)
                throw new A4Error("round is locked or past cutoff");
              const order: Order = {
                participant: `user:${actor.userId}`,
                kind: "human",
                side: terms.side,
                limit: terms.limit,
                quantity: terms.quantity,
              };
              validateOrder(order, s.config);
              await issue(
                client,
                scopeOf(s),
                order.participant,
                actor.userId,
                `starter:${scopeOf(s)}:${actor.userId}`,
                BigInt(fundingPolicy.starterCoins),
              );
              await admit(client, s, r, [{ order, userId: actor.userId, key }]);
              await audit(client, s.id, actor.userId, "order.commit", {
                roundId: r.id,
                requestKey: key,
              });
              return {
                roundId: r.id,
                side: order.side,
                limit: order.limit,
                quantity: order.quantity,
                reserved: String(
                  reservation(
                    order.quantity,
                    BigInt(YAP.face),
                    s.config.feeBps,
                  ),
                ),
                status: "committed",
              };
            },
          ),
        actor,
      );
    },
    async refill(actor: Actor, key: string, sessionId?: string) {
      // Without a run, the refill was the account-wide YAP play grant.
      if (sessionId === undefined) throw retired();
      return transaction(
        (client) =>
          idempotent(client, actor, key, "refill", { sessionId }, async () => {
            const s = await getSession(client, sessionId, actor.userId);
            if (s.mode === "human") throw retired();
            await enabled(client);
            if (s.mode === "observer")
              throw new A4Error("observer runs have no human balance", 403);
            const scope = s.id;
            const day = (
              await client.query<{ day: string }>(
                "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
              )
            ).rows[0]!.day;
            await issue(
              client,
              scope,
              `user:${actor.userId}`,
              actor.userId,
              `starter:${scope}:${actor.userId}`,
              BigInt(fundingPolicy.starterCoins),
            );
            const issued = await issue(
              client,
              scope,
              `user:${actor.userId}`,
              actor.userId,
              `refill:${scope}:${actor.userId}:${day}`,
              BigInt(fundingPolicy.refillCoins),
            );
            return {
              issued,
              day,
              asset: "YAP",
              amount: issued
                ? String(BigInt(fundingPolicy.refillCoins) * BigInt(YAP.face))
                : "0",
            };
          }),
        actor,
      );
    },
    async control(
      actor: Actor,
      key: string,
      id: string,
      action: "run" | "pause" | "step" | "archive" | "speed",
      speed?: number,
    ) {
      return transaction(
        (client) =>
          idempotent(
            client,
            actor,
            key,
            "control",
            { id, action, speed: speed ?? null },
            async () => {
              const s = await getSession(client, id, actor.userId);
              if (s.creator_id !== actor.userId || s.mode === "human")
                throw new A4Error("bot control unavailable", 403);
              if (s.state === "complete" || s.state === "archived")
                throw new A4Error("run has ended");
              if (action === "speed" && ![1, 5, 20].includes(speed ?? 0))
                throw new A4Error("invalid speed", 400);
              if (action === "run") await enabled(client);
              if (
                action === "pause" ||
                action === "run" ||
                action === "archive"
              )
                await client.query(
                  "UPDATE a4_sessions SET state=$2 WHERE id=$1",
                  [
                    id,
                    action === "pause"
                      ? "paused"
                      : action === "archive"
                        ? "archived"
                        : "running",
                  ],
                );
              if (action === "step") {
                const next = await client.query<Round>(
                  "SELECT * FROM a4_rounds WHERE session_id=$1 AND state NOT IN ('pending','settled','void') ORDER BY period LIMIT 1 FOR UPDATE",
                  [id],
                );
                if (next.rows[0]) {
                  if (next.rows[0].state === "scheduled") await enabled(client);
                  await transition(client, s, next.rows[0], true);
                }
                await settle(client, s);
              }
              if (action === "speed")
                await client.query(
                  "UPDATE a4_sessions SET speed=$2 WHERE id=$1",
                  [id, speed],
                );
              if (action === "archive") {
                const rounds = await client.query<Round>(
                  "SELECT * FROM a4_rounds WHERE session_id=$1 AND state IN ('scheduled','open') ORDER BY period FOR UPDATE",
                  [id],
                );
                for (const r of rounds.rows)
                  await voidOpen(client, s, r, "owner_archived_sandbox");
              }
              await audit(client, id, actor.userId, `run.${action}`, { speed });
              return { id, action };
            },
          ),
        actor,
      );
    },
    async view(actor: Actor, id: string, offset = 0, limit = 50) {
      return transaction(async (client) => {
        const s = await getSession(client, id, actor.userId);
        const observer = s.mode === "observer" && s.creator_id === actor.userId;
        if (observer) await audit(client, id, actor.userId, "observer.read");
        const rows = await client.query<Round>(
          "SELECT * FROM a4_rounds WHERE session_id=$1 ORDER BY period",
          [id],
        );
        const rounds = [];
        for (const r of rows.rows) {
          const own = await client.query<StoredSubmission>(
            "SELECT * FROM a4_submissions WHERE round_id=$1 AND user_id=$2",
            [r.id, actor.userId],
          );
          const mine = own.rows[0];
          const revealed = !!r.revealed_at || observer;
          const receipt = mine
            ? {
                side: mine.side,
                limit: mine.limit_value,
                quantity: mine.quantity,
                status:
                  r.state === "void"
                    ? "void"
                    : mine.outcome
                      ? r.state === "settled" && mine.outcome.executed
                        ? "settled"
                        : mine.outcome.status
                      : "committed",
                reserved: String(
                  reservation(mine.quantity, BigInt(YAP.face), s.config.feeBps),
                ),
                ...(mine.outcome
                  ? {
                      accepted: mine.outcome.accepted,
                      executed: mine.outcome.executed,
                      premium: mine.outcome.premium,
                      fee: mine.outcome.fee,
                      released: mine.outcome.released,
                    }
                  : {}),
                ...(revealed && mine.outcome
                  ? {
                      payout: mine.outcome.payout,
                      net: mine.outcome.net,
                      premiumDust: mine.outcome.premiumDust,
                      payoutDust: mine.outcome.payoutDust,
                    }
                  : {}),
              }
            : null;
          let diagnostics: Record<string, unknown> | undefined;
          if (revealed) {
            const all = await client.query<StoredSubmission>(
              "SELECT * FROM a4_submissions WHERE round_id=$1 ORDER BY participant LIMIT $2 OFFSET $3",
              [r.id, limit + 1, offset],
            );
            const totals = await client.query<{
              participants: number;
              humans: number;
              bots: number;
              accepted: number;
              executed: number;
              premium: string;
              payout: string;
              fee: string;
              quantity: string;
            }>(
              `SELECT count(*)::int AS participants,count(*) FILTER(WHERE kind='human')::int AS humans,count(*) FILTER(WHERE kind='bot')::int AS bots,count(*) FILTER(WHERE (outcome->>'accepted')::boolean)::int AS accepted,count(*) FILTER(WHERE (outcome->>'executed')::boolean)::int AS executed,COALESCE(sum((outcome->>'premium')::numeric),0)::text AS premium,COALESCE(sum((outcome->>'payout')::numeric),0)::text AS payout,COALESCE(sum((outcome->>'fee')::numeric),0)::text AS fee,COALESCE(sum(quantity) FILTER(WHERE (outcome->>'executed')::boolean),0)::text AS quantity FROM a4_submissions WHERE round_id=$1`,
              [r.id],
            );
            const t = totals.rows[0]!;
            diagnostics = {
              pricing: r.pricing,
              totals: t,
              centerTrading: String(BigInt(t.premium) - BigInt(t.payout)),
              centerFunding: String(
                BigInt(s.config.capacity) *
                  BigInt(s.config.maxQuantity) *
                  BigInt(s.config.periods) *
                  BigInt(YAP.face),
              ),
              centerAvailable: String(await balance(client, center(s))),
              centerFees: t.fee,
              centerResult: String(
                BigInt(t.premium) - BigInt(t.payout) + BigInt(t.fee),
              ),
              noTrade: t.executed === 0,
              // Humans stay anonymous: "Participant N", and their stored
              // outcome's participant ("user:<id>") is left out.
              book: all.rows.slice(0, limit).map((o, i) => ({
                label:
                  o.kind === "bot"
                    ? o.participant
                    : `Participant ${offset + i + 1}`,
                kind: o.kind,
                side: o.side,
                limit: o.limit_value,
                quantity: o.quantity,
                outcome: o.outcome ? bookOutcome(o.outcome, r.state) : null,
              })),
              pagination: { offset, limit, hasMore: all.rows.length > limit },
              snapshotHash: r.snapshot_hash,
              seed: r.seed,
            };
          }
          rounds.push({
            id: r.id,
            period: r.period,
            state: r.state,
            opensAt: r.opens_at,
            closesAt: r.closes_at,
            lockedAt: r.locked_at,
            seedCommitment: r.seed_commitment,
            offer: r.pricing?.price ?? null,
            receipt,
            ...(diagnostics ? { diagnostics } : {}),
            revealed: !!r.revealed_at,
          });
        }
        const balances = await client.query(
          "SELECT kind,COALESCE(sum(amount),0)::text AS amount FROM a4_accounts WHERE scope=$1 AND user_id=$2 GROUP BY kind ORDER BY kind",
          [scopeOf(s), actor.userId],
        );
        const visible = await client.query<{
          proposition: string;
          slug: string;
          topic_id: string;
        }>("SELECT proposition,slug,topic_id FROM debates WHERE id=$1", [
          s.debate_id,
        ]);
        // Round deadlines use the database clock; browsers offset countdowns by it.
        const clock = await client.query<{ serverNow: Date }>(
          'SELECT clock_timestamp() AS "serverNow"',
        );
        return {
          id: s.id,
          debateId: s.debate_id,
          debate: {
            ...visible.rows[0],
            proposition: s.proposition,
            topic_id: s.topic_id,
          },
          asset: YAP,
          fundingPolicy,
          mode: s.mode,
          state: s.state,
          config: s.config,
          speed: s.speed,
          revealAt: s.reveal_at,
          serverNow: clock.rows[0]?.serverNow,
          observer,
          balances: balances.rows,
          rounds,
          ...(s.state === "complete" || observer
            ? { researchSeed: s.seed }
            : {}),
        };
      }, actor);
    },
    async timeline(actor: Actor, debateId: string, scope: "human" | "sandbox") {
      return transaction(
        (client) => readTimeline(client, actor.userId, debateId, scope),
        actor,
      );
    },
    async list(actor: Actor, debateId?: string, offset = 0) {
      return transaction(async (client) => {
        const result = await client.query(
          `SELECT s.id,s.debate_id AS "debateId",s.mode,s.state,s.created_at AS "createdAt",s.config->>'argumentLabel' AS "argumentLabel" FROM a4_sessions s JOIN debates d ON d.id=s.debate_id JOIN topics t ON t.id=d.topic_id
          WHERE (s.creator_id=$1 OR (s.mode='human' AND ((d.publication_state='published' AND t.publication_state='published') OR EXISTS(SELECT 1 FROM a4_submissions o JOIN a4_rounds r ON r.id=o.round_id WHERE r.session_id=s.id AND o.user_id=$1)))) AND ($2::uuid IS NULL OR s.debate_id=$2) ORDER BY s.created_at DESC,s.id LIMIT 21 OFFSET $3`,
          [actor.userId, debateId ?? null, offset],
        );
        return {
          items: result.rows.slice(0, 20),
          hasMore: result.rows.length > 20,
          offset,
        };
      }, actor);
    },
    async wallet(actor: Actor) {
      return transaction(async (client) => {
        const rows = await client.query(
          "SELECT kind,COALESCE(sum(amount),0)::text AS amount FROM a4_accounts WHERE scope='global' AND user_id=$1 GROUP BY kind",
          [actor.userId],
        );
        return { asset: YAP, fundingPolicy, balances: rows.rows, mode };
      }, actor);
    },
    async history(actor: Actor, offset = 0) {
      return transaction(async (client) => {
        // Journal metadata can contain settlement share: never return it in private history.
        // Pending vault/fee balances and other accounts are not selected.
        const rows = await client.query(
          `SELECT j.reference,j.kind,j.asset,j.created_at AS "createdAt",a.scope,a.kind AS bucket,p.amount::text
          FROM a4_postings p JOIN a4_accounts a ON a.id=p.account_id JOIN a4_journals j ON j.reference=p.reference
          WHERE a.user_id=$1 ORDER BY j.created_at DESC,j.reference,a.id LIMIT 51 OFFSET $2`,
          [actor.userId, offset],
        );
        return {
          items: rows.rows.slice(0, 50),
          hasMore: rows.rows.length > 50,
          offset,
        };
      }, actor);
    },
    async tick() {
      const sessions = await database.query<{
        id: string;
        speed: number;
      }>(`SELECT s.id,s.speed FROM a4_sessions s WHERE EXISTS (
        SELECT 1 FROM a4_rounds r WHERE r.session_id=s.id AND (
          r.state IN ('locked','priced') OR (r.state='open' AND r.closes_at<=clock_timestamp()) OR
          (r.state='scheduled' AND ((s.state='running' AND r.opens_at<=clock_timestamp()) OR r.closes_at<=clock_timestamp())) OR
          (r.state IN ('pending','void') AND r.revealed_at IS NULL AND s.reveal_at<=clock_timestamp() AND NOT EXISTS (
            SELECT 1 FROM a4_rounds u WHERE u.session_id=s.id AND u.state NOT IN ('pending','settled','void')))))
        AND NOT EXISTS(SELECT 1 FROM a4_audit a WHERE a.session_id=s.id AND a.action='recovery.failed' AND a.created_at>clock_timestamp()-INTERVAL '30 seconds') ORDER BY s.reveal_at,s.id LIMIT 10`);
      let budget = 40;
      const failures: unknown[] = [];
      for (const s of sessions.rows) {
        try {
          for (let step = 0; step < s.speed && budget > 0; step++, budget--)
            await processRound(s.id);
        } catch (error) {
          failures.push(error);
          await transaction((client) =>
            audit(client, s.id, null, "recovery.failed", {
              code: "invariant_or_database_failure",
              retrySeconds: 30,
            }),
          );
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "A4 recovery failed; other due runs were processed",
        );
    },
  });
  async function voidOpen(
    client: PoolClient,
    s: Session,
    r: Round,
    reason: string,
  ) {
    if (!["scheduled", "open"].includes(r.state))
      throw new A4Error("priced obligations require settlement");
    const rows = await client.query<StoredSubmission>(
      "SELECT * FROM a4_submissions WHERE round_id=$1 ORDER BY participant",
      [r.id],
    );
    const postings: Posting[] = [];
    for (const o of rows.rows)
      postings.push(
        ...transfer(
          reserved(s, r, toOrder(o), o.user_id),
          available(s, o.participant, o.user_id),
          reservation(o.quantity, BigInt(YAP.face), s.config.feeBps),
        ),
      );
    postings.push(
      ...transfer(vault(s, r), center(s), await balance(client, vault(s, r))),
    );
    await post(client, `void:${r.id}`, "void_refund", postings, {
      reason,
      roundId: r.id,
    });
    await client.query("UPDATE a4_rounds SET state='void' WHERE id=$1", [r.id]);
    await audit(client, s.id, s.creator_id, "round.void", {
      roundId: r.id,
      reason,
    });
  }
}
