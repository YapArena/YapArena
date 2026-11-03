export const shorthands = undefined;

// People choose one of the Pixel Yappers when they claim a handle and can
// change it in Settings (founder, 2026-11-02; Decision 0014). NULL means the
// owner never chose: the server shows the default derived from the handle, so
// existing profiles need no backfill. The database checks only the id's
// format; the server checks it against the current set, so adding avatars
// later needs no migration. The table-level grant already covers the column.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.public_profiles ADD COLUMN avatar_id varchar(40)
      CONSTRAINT public_profiles_avatar_id_format
      CHECK (avatar_id ~ '^yap-[a-z]+(-[a-z]+)*$');
  `);
};

export const down = () => {
  throw new Error("Avatar choices are profile records; forward-fix");
};
