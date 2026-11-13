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
  Once it has shared rounds, its endorsement history follows its debates
  ([Topic history](#topic-history)); the last-answer figure will replace it.
- **Profile**: the avatar in a 96 px slot (72 on phones) beside the name, @handle, bio and Follow.
- **Empty lists** show the emblem, today's words and Clear search; inside a topic or profile, a
  quieter note without the emblem.

## Home

`/home` is a list of debates (first-run plan PR 6, direction A of the decision confirmed on
2026-11-06): `src/features/discovery/home-list-model.ts` sorts the public debate reads,
`home-list-view.ts` draws them, `public/home.css` styles them and `frontend/home-list.ts` adds
what depends on the reader. One column of at most 48rem on every screen, so phones and wide
screens read the same order; a visually hidden "Yap Arena" is the page's heading.

- **Intro**: one closable line for new and signed-out readers, "Live video debates. Say whether
  you agree during each turn's 60-second window." It stays closed on the device once closed
  (`yaparena-home-intro`, listed in the Cookie Policy) and hides for an account that follows a
  topic. It explains nothing about Yap Coins until the founder approves that wording.
- **Chips**: All, Soon · n and Replays · n (the kit's `.chips`, pressed is white). Category chips
  join them with the topic categories (PR 5).
- **Top slot**: never an empty card or chart. Under a Dydema title, one card with the page's one
  white button, filled in this order (the decision page's "When nothing is live"): a live debate
  in a followed topic; a debate starting within a day or a replay still taking answers in a
  followed topic ("From your topics"); any other live debate ("Live now", or "Live in other
  topics" for someone who follows topics), never hidden; the next debate within a day with its
  countdown; a replay still taking answers; someone waiting; a finished debate, one with its
  result first ("Latest result"); and, with nothing at all, "Start the first debate" (Pick a
  topic, or Create a topic without the live queue). "Your topics" are the topics you follow;
  signed out or new, you follow none. With nothing live, a quiet line says "Nothing live right
  now. Live debates show here first."
- **Sections**, each a Dydema title over rows, nothing listed twice: Live now (the others follow a
  live top slot in its own section), Starting soon (a start that passed is never shown, nor one
  more than a day away; each row counts down), Someone's waiting (`GET /api/matchmaking/waiting`:
  "1 person waiting to argue …", "Take the other side: …" and Argue for / Argue against, where for
  is side A; the row opens the topic page at that side's queue button), Replays you can still
  answer ("Answers close in 4 days", until each debate's 120-hour close) and Finished debates
  ("Ended 3 days ago · Turn 6: 58% said yes", the latest revealed turn). "All debates →" ends the
  list.
- **Rows**: both speakers' Pixel Yappers in 36 px slots ("?" while nobody is named), the
  proposition in Forum, who and the topic under it, and one way in: Watch, Answer or Argue; a
  debate starting soon shows its countdown instead. The whole row is the link, with the focus
  ring on it. On phones the avatars and the button share the first line and the proposition takes
  the full width under them; nothing scrolls sideways at 320 px.
- **The reader's part**: the server renders what everyone sees. The browser then reads the
  account's followed topics (`GET /api/me/follows`), who is waiting and each replay's and
  finished debate's public turn windows (`GET /api/public/debates/:id/windows`): a replay keeps
  taking answers only in the five-day mode with an open turn window, before its close, and
  shows that close; any other is finished. It renders the list again once, keeping focus, and
  updates countdowns every 15 seconds.
- When discovery fails the page is one state: "Discovery temporarily unavailable." with Try
  again and Explore topics.

On a 390 × 844 phone the top slot's button ends above the bottom tabs
(`scripts/verify-homepage-browser.ts` checks it). The old trending home (`homepage-view.ts`,
`homepage.css`, `frontend/homepage.ts`, [wide homepage](wide-homepage.md)) no longer shows; its
code is removed in PR 7, which keeps what topic pages use (below).

## Topic history

A topic page shows its endorsement history once it has shared rounds
(`src/features/discovery/topic-history-web.ts`, `frontend/topic-chart.ts`, styles at the end of
`public/explore.css`): the chart that used to sit on the home, under the topic's debates. It reuses
the home's idea model (`publicHomepage()`), geometry (`homepage-chart.ts`) and inspection
(`frontend/homepage-chart.ts`, `changeText()` from `homepage-view.ts`): one white line on five
dotted guides, five dates, a square end pixel that pulses; hover, a tap or the keyboard shows a
square marker with "Oct 19 55%". Endorsement or Price, 1D, 1W or 1M. It shows the history the page
was served, and a topic without rounds shows no chart.

Planned ([Decision 0015](decisions/0015-last-answer-endorsement.md), pull request 4): the shared
simulation chart gives way to the topic's last-answer figure, read from stored
`endorsement_points`.

- **Where viewers ended up** (kicker "Last answers"), above Debates: "Of **3,491** accounts,
  **47%** last answered YES (**People first**). Not a vote, a price or a forecast." and "Last
  debate: Nov 12, 2026 · 14 debates counted" (the live end date of the debate behind the latest
  point). A topic reviewed as "side A is not yes" reads "…last answered Yes." with no side label.
- **Debate cards** of counted debates get one line: "Final: 52% Yes · 140 accounts".
- **How answers changed**, under the figure: accounts that answered more than once, the share
  that changed answer (kept the new side or came back), changes per answer pair within and between
  debates, and the share of changes toward Yes.
- **History chart:** the same line, guides, end pixel and inspection as today, with one point per
  revealed turn placed by its order (five-day points share a reveal time), dates of the points
  under the line, and a ±3 point margin. All (default), 1D, 1W and 1M count back from the latest
  point and keep at least the latest debate's points; the Endorsement/Price switch goes. The
  tooltip reads "Nov 12 · Turn 4 · {debate}" over "**47%** Yes · 3,491 accounts"; the meta line
  says each point counts every account's last answer once a turn is revealed, and the change since
  the first point in range. Without points the section keeps a line saying the figure starts with
  a debate's first revealed turn, and that five-day debates reveal five days after they end.

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
  header hides its Sign in pill here. The header's Sign in leads here, so these buttons open
  Auth0's Log in screen; only the landing's new-user buttons open Sign up
  ([landing page](landing-page.md#routes-and-sessions)).
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
  Accept all are equal secondary pills; Customize is a text link. The bottom offset follows the
  safe area. On phones (under 600 px) the banner is one short line, "Analytics cookie only with
  your OK.", with Customize beside it and Reject all and Accept all side by side at the same width
  below: 122 px, about 15% of a 375×812 screen instead of 37% (two lines of text in the same
  height at 320 px). Customize and Cookie settings open the full card on phones too: the title,
  the full text with the Cookie Policy link, the switches, then Reject all and Accept all with Save
  choices under them. The choices, what they store and the analytics are the same at every width.
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
- On the debate page, the header lines up with its wider layout (up to 120rem).
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

- The kit's page head ("Pick a question and a side"), then a dashed "+ Create" card. For a
  signed-in player it opens the Create sheet (below); guests, and pages with the queue off, follow
  its link to the Match page's topic form (`/match#topic-create`), which signs in.
- "Someone's waiting": the questions where someone is in the live queue now, from
  `GET /api/matchmaking/waiting`, each with the count per side ("2 people waiting to argue …") and
  one button for the other side. Hidden while nobody is waiting; refreshed every 20 seconds while
  the page is visible.
- "All questions": every published topic, 12 a page, each with its title (linking to the topic
  page), its category, a "Waiting now" note when someone is queued on it, and one button per side
  named by the side. Demo examples, which the queue refuses, say "Demo" and name their sides
  without buttons. Category chips above the list (All, then the founder's list) are links to
  `/queue?category=…`; pagination and the canonical address keep the category.
- The Create sheet (first-run PR 3b): a native modal `<dialog>`, a centred card from 600 px and a
  bottom sheet below. It asks for the question, what the debate is about, both sides, a category
  (the browsed one preselected) and "You argue", with the server's limits checked before sending.
  While the question is typed, up to three published questions (demo examples left out) sharing a
  word of four letters or more show under "Already asked?" with their side buttons, which close
  the sheet and queue. "Create
  and join the queue" makes the slug from the question, creates and publishes the topic with the
  Match page's own calls (`POST /api/matching/topics`, then `…/publish`; a taken slug retries once
  with a short random ending), adds the row at the top of the list and queues on the chosen side
  like a side button. "Save as a private draft" only creates it; it is published later from
  Create. A public question can't be edited, which the sheet says.
- The buttons queue through `frontend/matchmaking.ts` (a `yap:queue-request` window event), with the
  topic page's sign-in, camera check, one-queue rule, overlay and strip. Your own side then reads
  "Leave queue" and the others are off until you leave; notices show above the list.
- With the queue off, the page lists the questions without buttons and says the queue isn't open.

## First-run guide

First-run plan PRs 11 and 12. Every sentence is in `frontend/first-run-copy.ts`, for the founder's
review; the coin sentences follow [A4](a4-mechanism.md). Two web switches, both off by default,
turn the parts on separately: `FIRST_RUN_WELCOME_ENABLED` and `FIRST_RUN_TIPS_ENABLED`. They reach
the browser as `data-first-run-welcome` and `data-first-run-tips` on `<html>`, like
`data-matchmaking`. With both off, the pages are unchanged.

- Welcome screen (`frontend/profile-setup.ts`): the handle pop-up's last step shows the new
  account's Yapper and "Welcome, <first name>", then "How YAP Arena works" in three lines (two
  people debate live; during each turn, tap Yes or No; Yap Coins on your answer, with the welcome
  grant of 2,500 that `grant-accounting.ts` issues). Then "What brings you here?": Watch debates
  opens Live, Debate myself opens the Queue tab (Create while the queue is off), and Just look
  around stays on the page. It replaces the living emblem and "Start exploring".
- Tips (`frontend/first-run-tips.ts`, loaded by `frontend/site-header.ts`):
  - The coin menu (tap your coins in the top bar) gains two lines on answering with contracts.
  - On a debate page, tip 1 of 2 shows under Yes and No the first time a turn can be answered,
    naming whoever has the floor. Got it, or tapping Yes or No, ends it.
  - Tip 2 of 2 shows on the answer panel's results card the first time it shows a result.
  - Each tip shows once per browser (`localStorage`); the answer panel itself is unchanged.

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
