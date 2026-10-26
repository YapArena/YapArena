export const shorthands = undefined;

// Decision 0013 amends Decision 0009, point 8, for opening only: Yap Coins are
// always on. An account's first own sandbox request records an automatic
// opening without a confirmation. Openings confirmed by a fresh sign-in before
// this release keep their operation. Expand only: the previous release always
// supplies an operation and keeps working.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.coin_sandbox_openings ALTER COLUMN operation_id DROP NOT NULL;
    COMMENT ON COLUMN yaparena.coin_sandbox_openings.operation_id IS
      'Fresh sign-in confirmation that opened the sandbox before Decision 0013; NULL for an automatic opening.';
  `);
};

export const down = () => {
  throw new Error("Automatic sandbox openings require a reviewed forward fix");
};
