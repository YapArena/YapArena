export const shorthands = undefined;

// Time reservations replace one active seat per player (Decision 0011): a player may hold several
// bookings at different times, and only overlapping ones conflict. The check runs under each
// player's lock in the application. Seats recorded before this migration have no window and keep
// blocking every time until their debate ends, as before.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.event_participants
      ADD COLUMN reserved_from timestamptz,
      ADD COLUMN reserved_until timestamptz,
      ADD CONSTRAINT event_participants_reservation CHECK (
        (reserved_from IS NULL) = (reserved_until IS NULL)
        AND (reserved_from IS NULL OR reserved_until > reserved_from));
    DROP INDEX yaparena.event_participants_one_active;
    CREATE INDEX event_participants_active_user
      ON yaparena.event_participants (user_id, reserved_from) WHERE active;

    -- A queued player leaves the queue when a booking would overlap a queue match.
    ALTER TABLE yaparena.matchmaking_tickets
      DROP CONSTRAINT matchmaking_tickets_closed_reason_check,
      ADD CONSTRAINT matchmaking_tickets_closed_reason_check CHECK (closed_reason IN
        ('left', 'declined', 'missed', 'stale', 'unavailable', 'topic_closed', 'booking'));
  `);
};

export const down = () => {
  throw new Error("Seat reservations are retained; forward-fix");
};
