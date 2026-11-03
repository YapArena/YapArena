export const shorthands = undefined;

// YA-04: a Yap Coins round holds at most its capacity (terms.capacity, 1,001
// orders). Submits count in the application after the ledger lock that
// serializes them; this trigger is the database backstop. It takes a
// per-round transaction lock before counting, so concurrent inserts into one
// round see each other, and refuses an order past capacity with the message
// the application maps to "window_full". It fires after
// coin_debate_admission (triggers run in name order).

export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION yaparena.coin_debate_order_capacity() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE capacity integer; admitted bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('coin-debate-capacity:'||NEW.round_id::text, 0));
      SELECT (r.terms->>'capacity')::integer INTO capacity
        FROM yaparena.coin_debate_rounds r WHERE r.id=NEW.round_id;
      SELECT count(*) INTO admitted FROM yaparena.coin_debate_orders o
        WHERE o.round_id=NEW.round_id;
      IF capacity IS NULL OR admitted >= capacity THEN
        RAISE EXCEPTION 'sandbox round is full' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.coin_debate_order_capacity() FROM PUBLIC;
    CREATE TRIGGER coin_debate_capacity BEFORE INSERT ON yaparena.coin_debate_orders
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_debate_order_capacity();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER coin_debate_capacity ON yaparena.coin_debate_orders;
    DROP FUNCTION yaparena.coin_debate_order_capacity();
  `);
};
