export const shorthands = undefined;

// Live topic queue (Decision 0011): a ticket waits on one topic and side; an offer pairs the
// oldest ticket on each side and expires 30 seconds after creation unless both players accept.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.matchmaking_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      topic_id uuid NOT NULL REFERENCES yaparena.topics(id) ON DELETE RESTRICT,
      side char(1) NOT NULL CHECK (side IN ('A', 'B')),
      status varchar(12) NOT NULL
        CHECK (status IN ('searching', 'offered', 'matched', 'closed')),
      closed_reason varchar(20)
        CHECK (closed_reason IN ('left', 'declined', 'missed', 'stale', 'unavailable', 'topic_closed')),
      debate_id uuid REFERENCES yaparena.debates(id) ON DELETE SET NULL,
      priority_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT matchmaking_tickets_closed_reason
        CHECK ((status = 'closed') = (closed_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX matchmaking_tickets_one_active
      ON yaparena.matchmaking_tickets (user_id) WHERE status IN ('searching', 'offered');
    CREATE INDEX matchmaking_tickets_waiting
      ON yaparena.matchmaking_tickets (topic_id, side, priority_at, id) WHERE status = 'searching';
    CREATE INDEX matchmaking_tickets_user_recent
      ON yaparena.matchmaking_tickets (user_id, updated_at);
    CREATE INDEX matchmaking_tickets_resolved
      ON yaparena.matchmaking_tickets (updated_at) WHERE status IN ('matched', 'closed');
    CREATE INDEX matchmaking_tickets_debate ON yaparena.matchmaking_tickets (debate_id);

    CREATE TABLE yaparena.match_offers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      topic_id uuid NOT NULL REFERENCES yaparena.topics(id) ON DELETE RESTRICT,
      ticket_a_id uuid NOT NULL REFERENCES yaparena.matchmaking_tickets(id) ON DELETE CASCADE,
      ticket_b_id uuid NOT NULL REFERENCES yaparena.matchmaking_tickets(id) ON DELETE CASCADE,
      user_a_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      user_b_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      status varchar(12) NOT NULL
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
      deadline_at timestamptz NOT NULL,
      accepted_a_at timestamptz,
      accepted_b_at timestamptz,
      debate_id uuid REFERENCES yaparena.debates(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT match_offers_distinct CHECK (user_a_id <> user_b_id AND ticket_a_id <> ticket_b_id),
      CONSTRAINT match_offers_deadline CHECK (deadline_at > created_at)
    );
    CREATE UNIQUE INDEX match_offers_pending_a
      ON yaparena.match_offers (ticket_a_id) WHERE status = 'pending';
    CREATE UNIQUE INDEX match_offers_pending_b
      ON yaparena.match_offers (ticket_b_id) WHERE status = 'pending';
    CREATE INDEX match_offers_ticket_a ON yaparena.match_offers (ticket_a_id);
    CREATE INDEX match_offers_ticket_b ON yaparena.match_offers (ticket_b_id);
    CREATE INDEX match_offers_due
      ON yaparena.match_offers (deadline_at) WHERE status = 'pending';
    CREATE INDEX match_offers_debate ON yaparena.match_offers (debate_id);
  `);
  for (const table of ["matchmaking_tickets", "match_offers"])
    pgm.sql(`
      ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON yaparena.${table} FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON yaparena.${table} TO yaparena_runtime;
      CREATE POLICY backend_access ON yaparena.${table}
        TO yaparena_runtime USING (true) WITH CHECK (true);
    `);
};

export const down = () => {
  throw new Error("Matchmaking queue tables are retained; forward-fix");
};
