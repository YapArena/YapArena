# Decision 0014 — User avatars: the 30 Pixel Yappers

Status: approved by the founder, 2026-11-02 ("pixel yappers are the ones i like"; "i approve this
and activate the avatars"). Builds on [Decision 0002](0002-identity-and-social.md) (public
profiles) and the slots in the [site design](../site-design.md).

## The set

1. People choose one of 30 Pixel Yappers: small creatures drawn in the emblem's 12 × 12 tiles, each
   with its own shape and colour. No uploads, no animation, no other styles.
2. The files are `public/avatars/<id>.svg`, served at `/assets/avatars/<id>.svg` with the asset
   revision. Each is under 1 KB, draws its own dark stepped tile and has no script or external
   reference. The ids and names live in `src/features/identity/avatars.ts`, in a fixed order.
3. Slots are squares at multiples of 12 px (24, 36, 48, 72, 96) so the pixels stay crisp. Slots
   add no crop, border or background behind an avatar.

## Choosing and storing

4. The handle pop-up shows a picker under the handle field and starts on a random Yapper. Settings
   has the same picker in the public profile form. The choice is public, like the username.
5. `public_profiles.avatar_id` (migration `1793665232104`) is nullable. The database checks the id's
   format only; the server accepts only ids from the current set (`400`, field `avatarId`).
6. `NULL` means the owner never chose. The server then shows a default derived from the handle:
   FNV-1a (32-bit) over its UTF-8 bytes, modulo 30, over the first 30 ids in their fixed order.
   Handles never change, so neither does the default, and avatars added later don't change anyone's.
   Profiles that existed before this decision need no backfill.
7. Every API response that carries an owned or public profile returns the resolved `avatarId`,
   never `NULL`.

## Where avatars show

8. Avatar PR A: the header's account button and menu, Settings, the handle pop-up and the public
   profile page.
9. Avatar PR B: the debate page's player cards, debate cards, Home's featured footer, the queue
   overlay's cards and chat. Until then those keep the initials.
