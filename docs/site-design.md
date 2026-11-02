# Site design

Every page shares the look of the [landing page](landing-page.md), the queue overlay and the
[debate page](debate-page-design.md): a black ground, the landing's tokens, Dydema Capitals
headlines with U shown as V, Forum for numbers and user content, Arial for text, and the visit's
five random colours. The founder approved this site-wide redesign on 2026-10-31 and 2026-11-02
from an audit of every page; it ships in five pull requests, starting with this kit, the header and
the footer. The pages move onto the kit one group at a time.

## Tokens

`public/site.css` holds the landing's values (see the table in
[the debate page design](debate-page-design.md#tokens)); `tests/design-tokens.test.js` keeps every
shared name equal to `landing.css`. The site adds:

| Use           | Token                                        | Value                                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------------- |
| Container     | `--container`                                | `80rem`, as the landing                                 |
| Side gutter   | `--gutter`                                   | `clamp(1rem, 4.5vw, 4rem)`, plus the phone's safe areas |
| Visit colours | `--visit-0` … `--visit-4`, `--visit-yappers` | fallbacks only; see below                               |

The visit colours are runtime values, not design tokens. `frontend/lib/visit-colors.ts` picks one
set per page load with `pickHeadlineColors()` (the landing's rules: five hues at least 45° apart,
each at least 4.5:1 on black), writes them to the root element and keeps them on `window`, so the
header, the debate page and any bundled copy of the module share one set.

## Type roles

| Role                | Class            | Face and size (desktop / phone)                                     |
| ------------------- | ---------------- | ------------------------------------------------------------------- |
| Page title          | `.page-title`    | Dydema 40 / 28 px, line-height 1.3, emphasised words in `--visit-1` |
| Label above a title | `.kicker`        | Dydema 14 px, 0.06em, muted                                         |
| Section title       | `.section-title` | Dydema 28 / 24 px                                                   |
| User content title  | `.title-serif`   | Forum 40 / 28 px                                                    |
| Lead paragraph      | `.page-lead`     | Arial 20 / 16 px, muted, at most 36rem                              |
| Numbers             | `.num`           | Forum, tabular                                                      |
| Running text        | `.measure`       | at most 33rem, about 74 characters                                  |

Dydema text is set in visible `aria-hidden` capitals with U shown as V, plus a visually hidden real
spelling, through `inscribe()` in `src/features/discovery/inscribe.ts` (browser modules that import
it are listed in `inPlaceBundles` in `scripts/build-frontend.ts`). Bare `h1`, `h2` and `h3` are Arial
at 40, 28 and 20 px (28 and 24 on phones) with normal letter spacing; nothing is smaller than 12 px.

## Components

All in `public/site.css`, under "The site kit":

- **Buttons** `.btn` with `.btn-primary` (the landing's white pill), `.btn-secondary` or
  `.btn-outline`; 48 px, `.btn-sm` 40 px (44 px on touch screens). One white button per screen.
  The older `.button` class is the primary pill too.
- **Chips** `.chip` (40 / 44 px; pressed or current is white) in a `.chips` row that scrolls sideways.
- **Tags** `.tag`, `.tag-live` with a blinking `.live-pixel`.
- **Cards** `.card`: `--panel`, 1 px `--line`, 16 px corners, 24 px padding (16 on phones).
- **Fields** `.field`, `.input` (48 px, 12 px corners), `.search-pill`.
- **States** `.state` for empty and error, `.skeleton` blocks and the `.pixel-loader` (nine tiles
  lighting in the visit colours) for loading.
- **Avatar slots** `.avatar-slot` (square, `--avatar-size` a multiple of 12: 24, 36, 48, 72, 96) with
  today's `.avatar-initials`. The chosen avatars ship later and draw their own tile, so slots add
  no crop, border or background.
- **Dialogs** `.scrim` and `.dialog`: a centred card, a bottom sheet on phones.
- **Reveal** `.kit-reveal`: the landing's page-load wipe, for page heads only.

Every animation stops with reduced motion. Focus rings are 2 px `#f8f8f8` at a 3 px offset.

## Header

`src/features/discovery/site-header-web.ts`, `public/site-header.css`, `frontend/site-header.ts`.

| Width                                | Layout                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1000 px                            | One 64 px row: the landing logo (32 px), Live · Explore · Create, a 22rem search pill, then the account group.                                             |
| 600–999 px, and phones held sideways | The same row; search is a 44 px icon that opens a search row under the header (Escape closes it). Without JavaScript the icon links to the debates search. |
| < 600 px                             | A 56 px row (logo 26 px, search icon, account group) and the three destinations as a 44 px tab row: 100 px in all.                                         |

- The page's section (from its canonical path: Live, Explore for debates, topics and people, Create
  for `/match`) has `aria-current="page"` and three 4 px pixels in the visit colours under it.
- Signed out: Sign in is an outline pill, hidden on the signed-out account page, which has its own
  sign-in buttons. While the account loads, nine tiles hold the account group's width.
- Signed in: the queue pill (queue overlay), the balance pill (a small pixel coin, the amount in
  Forum) and the account button, a 44 px target around a 36 px square avatar slot with the
  initials. The balance pop-up repeats the amount in Forum 40 px with "In open positions" and
  "Play money · no cash value"; the account menu starts with the avatar, name and @handle.
- On the debate page, and on `/home` until it moves onto the kit, the header lines up with their
  wider layouts (up to 120rem).

## Footer

`siteFooterMarkup()` in `src/features/discovery/page-chrome-web.ts`: one centred row of 44 px links
(Topics, Yap Coins, About, Privacy, Terms, Cookies, then Cookie settings from
`frontend/measurement.ts`) and "Play money · no cash value" under it. It stays at the bottom of short
pages. The debate page hides it from 960 px.

## Breakpoints

1000 px (search becomes an icon), 600 px (phone layout) and 360 px (smaller logo), as in the
prototype. Pages use the same three; the debate page keeps its own (1200, 960, 600).
