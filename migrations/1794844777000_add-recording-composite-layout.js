export const shorthands = undefined;

// Decision 0016: where each camera sits in a recording.
//
// - 'livekit-grid': LiveKit's default egress page. Its grid orders cameras by
//   who spoke and joined first, with gaps, rounded tiles and a speaking ring.
//   Every recording made before this migration used it.
// - 'sides-v1': YapArena's recording page (/recording-template/). Side A's
//   camera fills the left half and side B's the right half, edge to edge.
//
// Existing rows, and rows from a web or jobs version that predates the column,
// get the default, which is the layout those versions record. Runtime already
// holds table-level privileges on debate_media; the encoder's column grants do
// not need this column.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.debate_media
      ADD COLUMN composite_layout text NOT NULL DEFAULT 'livekit-grid'
      CONSTRAINT debate_media_composite_layout
        CHECK (composite_layout IN ('livekit-grid', 'sides-v1'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE yaparena.debate_media DROP COLUMN composite_layout;`);
};
