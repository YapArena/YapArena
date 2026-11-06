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
- **Avatar slots** `.avatar-slot` (square, `--avatar-size` a multiple of 12: 24, 36, 48, 72, 96)
  with the person's Pixel Yapper (`.avatar-img`, [Decision 0014](decisions/0014-user-avatars.md)),
  or `.avatar-initials` ("?") where nobody is named yet. The avatars draw their own tile, so
  slots add no crop, border or background. Server pages fill them with `personSlot()`
  (`src/features/discovery/avatar-web.ts`).
- **Avatar picker** `.avatar-picker` (`frontend/avatar.ts`): a radio per Yapper drawn as a 48 px
  tile, the chosen one ringed, in the handle pop-up and Settings.
- **Dialogs** `.scrim` and `.dialog`: a centred card, a bottom sheet on phones.
- **Reveal** `.kit-reveal`: the landing's page-load wipe, for page heads only.

Every animation stops with reduced motion. Focus rings are 2 px `#f8f8f8` at a 3 px offset.

## List pages and cards

Explore (`/debates`), Topics, topic pages and profiles use the kit through
`src/features/discovery/kit-web.ts` (`inscription()`, avatar slots, the search icon) and
`src/features/discovery/cards-web.ts`, with their layout in `public/explore.css`. Live loads the
same stylesheet for its topic cards.

- **Explore switch** (first-run plan): Explore's two lists, `/debates` and `/topics`, open with
  Debates and Topics as a two-option switch above the page head, styled like the Create page's
  Now / Propose times; the current one has `aria-current="page"`. Full width on phones.
- **Page head**: a kicker, the `.page-title` with its emphasised words in `--visit-1`, and a lead.
- **Search**: a pill field with a Search button. On phones the field is hidden and Explore's search
  bar in the top row takes its place ([Header](#header)), so there is only one.
- **Status filters** on Explore: All, Live, Upcoming and Replay as chips, then More (a
  `<details data-menu>` that closes on Escape or a click outside) with Ready, Ended, Under review,
  Finalized and Cancelled; More shows the status in use. URLs are unchanged.
- **Category filters** on Topics: All and the founder's categories from
  `src/features/discovery/topic-categories.ts`, in its order, as chips linking to
  `/topics?category=<id>` (the API's filter; an unknown category is an invalid link). Each keeps
  the search. They wrap from 600 px; on phones the row scrolls sideways and loads with the chosen
  chip in view (`frontend/site.ts`). The debate list has no category chips: debates can't be
  filtered by their topic's category without a new database query.
- **Debate card** `.dcard`: a 16:9 picture with both speakers' avatars in 48 px slots on two
  panes, under the recording's still for replays and finalized debates (the media router serves
  no still for others; `frontend/site.ts` hides one that fails), the status tag and a stamp; then
  the topic, the proposition in Forum and both speakers in 24 px slots.
- **Topic card** `.tcard`: the title in Forum, the summary on three lines at most, the two sides on
  one line.
- Both cards are links as a whole, with the focus ring on the card.
- **Topic page**: the title in Forum beside one card holding both sides (under it below 1000 px).
  With the queue on, each side has a "Queue for this side" button described by the side's name;
  a side you queued for lights up and its button turns white.
- **Profile**: the avatar in a 96 px slot (72 on phones) beside the name, @handle, bio and Follow.
- **Empty lists** show the emblem, today's words and Clear search; inside a topic or profile, a
  quieter note without the emblem.

## Home

`/home` (`src/features/discovery/homepage-view.ts`, `public/homepage.css`,
`frontend/homepage.ts`; [wide homepage](wide-homepage.md)) has no headline of its own:

- **Trending card**: the idea's pixel mark (`pixelMark("idea-" + id, 48)` from
  `src/features/discovery/pixel-mark.ts`: a 5 × 5 mirrored pattern from an FNV-1a hash in one
  of the visit colours; ideas get marks, people get their avatars), the category in Dydema, the
  title in Forum 28 / 20 px and a bookmark to follow. From a 640 px card, For and Against with
  their share in Forum and up to three arguments sit beside the chart, and the body keeps a
  28rem minimum so every slide is the same height. The footer holds the volume, the debaters
  and one white Explore debate. An idea without rounds shows "No rounds yet" and an empty frame.
- **Chart**: one white line on five dotted guides, five dates, a square end pixel that pulses;
  hover, a tap or the keyboard shows a square marker with "Oct 19 55%".
- **Under the card**: dots (the current idea as three lit pixels) and previous / next named after
  the neighbouring ideas, icons only on phones. Nothing turns by itself.
- **Rail** (20rem from 1200 px, two columns under the card below that): Live now, Take a side
  (Join the arena when signed out; not on phones), Popular ideas by 24-hour volume, and
  Explore all ideas.
- **Ideas in motion**: today's tools and cards with the idea's 24 px mark, a Forum title and
  percentage, and a white sparkline that draws in like the chart.
- With no ideas the page is one state: "No public ideas yet." or, when discovery fails,
  "Discovery temporarily unavailable." with Try again.

At 1440 × 900 and 1280 × 800 the card and its controls end by 800 px; on a 390 × 844 phone
Explore debate ends by 820 px (`scripts/verify-homepage-browser.ts` checks both).

## Live

`/live` (`featured-web.ts`, `video-card-web.ts`, `public/live.css`): the featured debate in a
contained 16:9 stage with rounded corners, its words beside it from 1000 px (under it below) and
a white "Step into the debate". `frontend/hero-preview.ts` keeps the muted preview, its controls
and staying on the video to enter. The cards are the kit's debate cards with the preview in
their picture and the words under it; topics use topic cards; the note is small muted text.
With nothing to watch, a Dydema headline sits beside the living emblem
(`frontend/living-emblem.ts`, the landing's renderer, resting off screen).

## Sign-in, Settings and Yap Coins

`/account` and `/coins` (`src/features/discovery/account-web.ts`, `renderCoins` in `web.ts`,
`public/account-auth.css`):

- **Sign-in** (signed out): the landing's layout. The words sit in columns 1–7: a Dydema headline
  "Every idea deserves _a voice._" (64 / 40 / 28 px), the lead, "Join the arena" with "Sign in or
  create an account", and 380 px Google and email buttons. The living emblem sits in columns 8–12,
  above the words when upright under 900 px and beside them on a phone held sideways. The
  header hides its Sign in pill here.
- **While the account is checked**, a screen-tall space with the pixel loader holds the page, so
  the back link and the footer don't move.
- **Settings**: the avatar slot (`.settings-avatar`, 72 px, 48 on phones) with the person's avatar
  (the person icon until the profile loads), the name in Forum and @handle; the avatar picker in
  the public profile form; card titles in Dydema 20 px; 48 px fields; the
  tabs as a vertical list from 1000 px and a row of pills below, with the WAI tab keys and hash
  links.
- **Handle pop-up** (`frontend/profile-setup.ts`, styles in `public/site-header.css`): the kit's
  dialog (a bottom sheet on phones), the landing logo, visible "Create your profile" and "Confirm
  your handle", the preview in a 48 px slot (72 to confirm) showing the avatar chosen in the
  picker under the handle field (it starts on a random Yapper), 44 px tap areas for the terms tick
  and the 20 px "i" marks, and a welcome with the living emblem after "Claim my handle".
- **Sign-in hand-off pages** (`src/platform/auth/sign-in-pages.ts`) stay self-contained but take
  the landing logo, a Dydema heading, the pixel loader, a 16 px card and the kit's pills.
- **Yap Coins**: the pixel coin (`pixelCoin()` in `pixel-mark.ts`: a ring in the five visit colours
  around a white Y), the balance in Forum 64 / 40 px with a smaller "YC", Available and In open
  positions, then the daily claim, Grants and History. Placeholders hold the balance's size while
  it loads.

## Create, About, errors, legal pages, cookie banner and offline page

`public/pages.css` (Create, About, errors), `public/legal.css`, `public/offline.html`:

- **Create** (`/match`): the page head. "Start a topic" and "Challenge a person" (or "Open a
  request" without the live queue) are a WAI tab pair showing one form at a time; every field,
  help text and hook is unchanged. Now / Propose times is a two-option switch made of the radios.
  Live queue, Your challenges, Your events and Updates sit in a column beside the forms from
  1000 px. Each empty list says "Nothing here yet." with a hint, and a list that cannot load offers
  Try again. Signed out, only the sign-in card shows.
- **About**: the page head, the text at 33rem with Dydema section headings, and the living emblem
  beside it from 1000 px.
- **Errors** (404, 400, 503): the landing's composition. The kicker and a `.display-title` headline
  (64 / 40 / 28 px) sit beside the living emblem (above it upright under 900 px), with one main
  button and "Go to Home →". The 503's Try again reloads the page that failed (a same-site path
  only).
- **Legal pages** (`legal-web.ts`): the shared header and footer, Privacy / Terms / Cookies as chips,
  the title at 40 / 28 px, section numbers inline, the points at a glance as one bordered list on
  phones, and 44 px contents and "Back to top" links on touch screens.
- **Cookie banner** (`frontend/measurement.ts`): the kit's card with a Dydema title. Reject all and
  Accept all are equal secondary pills; Customize is a text link (under them on phones). The bottom
  offset follows the safe area.
- **Offline page**: the kit's type and colours, from `site.css` alone (the service worker caches
  only the two).

## Header

`src/features/discovery/site-header-web.ts`, `public/site-header.css`, `frontend/site-header.ts`.

| Width                                | Layout                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1000 px                            | One 64 px row: the landing logo (32 px), Live · Explore · Create, a 22rem search pill, then the account group.                                                                                                                                                                                                                                             |
| 600–999 px, and phones held sideways | The same row; search is a 44 px icon that opens a search row under the header (Escape closes it). Without JavaScript the icon links to the debates search.                                                                                                                                                                                                 |
| < 600 px                             | A 56 px row like the X app: the account button on the left, the logo (26 px), the page's name or Explore's search in the middle, the balance on the right. Under 600 px the main navigation is the bottom tabs (below); pages without them (the debate page, moderation and measurement) keep the three destinations as a 44 px tab row under the top row. |

- The page's section (from its canonical path: Live, Explore for debates, topics and people, Create
  for `/match`) has `aria-current="page"` and three 4 px pixels in the visit colours under it.
- Signed out: Sign in is an outline pill, hidden on the signed-out account page, which has its own
  sign-in buttons. While the account loads, nine tiles hold the account group's width.
- Signed in: the queue pill (queue overlay), the balance pill (a small pixel coin, the amount in
  Forum) and the account button, a 44 px target around a 36 px square slot with the person's
  avatar. The balance pop-up repeats the amount in Forum 40 px with "In open positions" and
  "Play money · no cash value"; the account menu starts with the avatar, name and @handle.
- On the debate page, and on `/home` until it moves onto the kit, the header lines up with their
  wider layouts (up to 120rem).
- Phones (first-run redesign, PR 1 of the confirmed plan): Live, Queue and Create (`/match`) show
  their name in Dydema in the middle of the top row; Explore's two lists show its search bar
  (below); every other page shows the logo. There is no search icon. The account
  button opens the account menu as a drawer from the left over a dimmed page; tapping the dimmed
  page or pressing Escape closes it, and the page behind does not scroll. The queue pill takes its
  own row under the top row.
- Explore's search bar (phones, first-run plan): on `/debates` and `/topics` the middle of the top
  row is a search pill, "Search debates" or "Search topics" (`.site-page-search`, from the
  `search` option of `siteHeaderMarkup()`), with 16 px text so phones don't zoom in. It reloads
  the list it is on with the query and keeps the filters in use as hidden fields: the status on
  Debates, the category on Topics. It fills the room between the account button and the balance;
  signed out, it starts at the side gutter. Tablets and desktop keep the header's search, which
  always searches debates, and the page's own field.

## Queue tab

`renderQueue()` in `src/features/discovery/web.ts` (`/queue`), `frontend/queue-page.ts` and
`frontend/queue-page-model.ts`, styles at the end of `public/explore.css`.

- The kit's page head ("Pick a question and a side"), then a dashed "+ Create" card that opens the
  Match page's topic form (`/match#topic-create`).
- "Someone's waiting": the questions where someone is in the live queue now, from
  `GET /api/matchmaking/waiting`, each with the count per side ("2 people waiting to argue …") and
  one button for the other side. Hidden while nobody is waiting; refreshed every 20 seconds while
  the page is visible.
- "All questions": every published topic, 12 a page, each with its title (linking to the topic
  page), a "Waiting now" note when someone is queued on it, and one button per side named by the
  side.
- The buttons queue through `frontend/matchmaking.ts` (a `yap:queue-request` window event), with the
  topic page's sign-in, camera check, one-queue rule, overlay and strip. Your own side then reads
  "Leave queue" and the others are off until you leave; notices show above the list.
- With the queue off, the page lists the questions without buttons and says the queue isn't open.

## Bottom tabs

`siteTabBarMarkup()` in `src/features/discovery/site-header-web.ts`, styles in `public/site-header.css`.

- Phones only (under 600 px), on every page built by `layout()` except the debate page, whose stake
  bar sits at the bottom. Wider screens keep the header's navigation and never show the tabs.
- Home (`/home`, the YAP Arena ring upright like the emblem), Live, Queue (two speech bubbles, in
  the middle), Explore and Create: 24 px icons with their names under them, in one 56 px row fixed
  above the phone's home indicator. The current page's tab is white with `aria-current="page"`;
  the others are muted. The header's navigation lists the same four destinations on wider screens.
- The tabs are labelled "Main navigation", like the header's navigation, which they replace on
  phones; only one of the two is ever shown.
- The page keeps 57 px of space under its footer for the tabs. When you are in the queue, the
  queue pill becomes a strip just above the tabs; the cookie choice also sits above them.

## Footer

`siteFooterMarkup()` in `src/features/discovery/page-chrome-web.ts`: one centred row of 44 px links
(Topics, Yap Coins, About, Privacy, Terms, Cookies, then Cookie settings from
`frontend/measurement.ts`) and "Play money · no cash value" under it. It stays at the bottom of short
pages. The debate page hides it from 960 px.

## Breakpoints

1000 px (search becomes an icon), 600 px (phone layout) and 360 px (smaller logo), as in the
prototype. Pages use the same three; the debate page keeps its own (1200, 960, 600).
