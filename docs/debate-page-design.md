# Debate page design

`/debates/<slug>` follows direction **BC1**, chosen by the founder on 2026-10-30 from the round 2
design canvas and revised in review the same day: a large stage with chat over the video, the
debaters in match cards under it with the emblem turn clock between them, and a right rail with
the answer panel above a panel of tabs (AI outline, Results, About). It amends
[Decision 0013](decisions/0013-yap-coins-always-on-and-debate-staking.md) (see its two 2026-10-30
amendments). Everything else in Decisions 0012 and 0013 stands. Behaviour and data flow are in
[the debate workspace](debate-workspace.md).

The founder asked for the emblem clock in review, so it landed with the layout instead of in a
pull request of its own. `frontend/pixel-emblem.ts` has the countdown mode only; the queue overlay
adds the landing's living mode when it moves `startEmblem` out of `frontend/landing.ts`. The
replay timeline with per-turn results still needs S's clearance for `frontend/arena-chart.ts`;
until then the replay keeps the existing chart, restyled.

## Tokens

The page uses the [landing page's](landing-page.md) values only. `public/site.css` carries them
for every page except the landing, which keeps its own copy; `tests/design-tokens.test.js` keeps
the two equal.

| Use                      | Token                                              | Value                                       |
| ------------------------ | -------------------------------------------------- | ------------------------------------------- |
| Ground, surface, raised  | `--bg`, `--panel`, `--raised`                      | `#000`, `#0f0f0f`, `#161616`                |
| Control border, divider  | `--control-border`, `--line`                       | `#4b4b4b`, `#202020`                        |
| Text, muted, button text | `--text`, `--muted`, `--button-text`               | `#f4f4f4`, `#a9a9a9`, `#e2e2e2`             |
| Acid and its text        | `--acid`, `--on-acid`                              | `#f8f8f8`, `#0c0c0c`                        |
| Primary button           | `--primary-gradient`                               | `linear-gradient(180deg, #fcfcfc, #f7f7f7)` |
| Yes                      | `--answer-yes`, `--on-yes`, `--answer-yes-tint`    | `#2fbf71`, `#04140b`, 12%                   |
| No                       | `--answer-no`, `--on-no`, `--answer-no-tint`       | `#ff536c`, `#2a0509`, 12%                   |
| Warning (last 10 s)      | `--warning`                                        | `#ff8a5c`                                   |
| Spacing                  | `--space-1` … `--space-8`                          | 4, 8, 12, 16, 24, 32, 48, 64 px             |
| Radii                    | `--radius-card`, `--radius-inner`, `--radius-pill` | 16, 12, 999 px                              |
| Type                     | `--font-display`, `--font-number`, `--font-body`   | Dydema Capitals, Forum, Arial               |
| Motion                   | `--ease-expo`                                      | `cubic-bezier(0.19, 1, 0.22, 1)`            |

The type scale is 12, 14, 16, 20, 24, 28 and 40 px; nothing is smaller than 12 px. arena.css's
older `--yes` (white) and `--no` stay for other pages.

Labels in Dydema Capitals ("Do you agree?", "Chat", "AI outline", "Results by turn", "About this
debate", stage titles, the turn label) are visible capitals with U shown as V, hidden from screen
readers, plus a visually hidden real spelling, rendered with `inscribe()`
(`src/features/discovery/inscribe.ts`). Digits and punctuation fall back to Forum. The debate page
preloads `headline.woff2` as the landing does; without the file, the labels show in Forum.

## Layout

| Width       | Layout                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1200 px   | Grid `minmax(0, 1fr) 400px`, gap 24, max width 1920. The page fits one screen: the footer is hidden (its links are in About) and the video takes the largest 16:9 size above the status line and scoreboard (968 × 544 at 1440 × 900). Chat sits over the video. The rail is the answer panel, then the tabs panel; the rail scrolls inside itself when the ticket is tall. |
| 960–1199 px | One screen as above, rail 340 px. Chat becomes a tab ("Chat · N new" counts messages that arrive while it is hidden). The cards drop the @handle and show the side as text.                                                                                                                                                                                                 |
| 600–959 px  | One column, max width 720, scrolling: stage, answer panel, then the tabs panel (`min(560px, max(70svh, 26rem))` tall) with Chat as a tab.                                                                                                                                                                                                                                   |
| < 600 px    | Video full-bleed with no radius, compact cards, the tabs panel, then the answer bar pinned to the bottom with safe-area padding. Picking Yes or No opens it as a sheet (at most 85svh, scrolls); Back or Escape closes it and returns focus to the answer.                                                                                                                  |

On phones the bar steps aside while the chat composer has focus or the cookie banner is open, and
`scroll-padding-bottom` keeps focused elements clear of it. No width from 320 px up scrolls
sideways.

## Stage

- **Video:** flat `#0f0f0f` when empty, 16 px radius on wide screens. Participant videos are
  ordered by side (A left, B right) from the speaker token's metadata.
- **Speaker frames:** a frame over each debater's video (`.arena-frames`, hidden from screen
  readers). The side with the floor (`data-active-side` on `[data-arena]`) gets a 3 px white
  inset ring with a soft inner glow, fading in and out over 0.3 s. On hover or focus each frame
  shows the debater's name and @handle at its bottom left (black at 62% with a blur, 10 px
  radius). The scoreboard names them for screen readers.
- **Hover corners:** black at 72%, 12 px radius; the question as a 20 px bold `h1`; "Live · N
  watching" with a white dot.
- **Chat over the video (≥ 1200 px):** in the lower right, from 42% of the video's height (at
  least 15rem tall) to 12 px from the bottom, `min(20rem, 50% − 10.5rem)` wide (at least 14rem)
  so it ends before side B's name tag. No title and no panel: a radial shadow in the corner keeps
  white text readable, the messages fade out towards the top, newest at the bottom. The composer
  is a 44 px see-through pill with the "⋯" menu beside it; the menu fills the chat area above
  the composer. "Load earlier messages" shows on hover or focus. A chat button next to Enlarge
  hides it; the choice is kept on the device (`yaparena-chat-overlay`).
- **Empty states:** upcoming (emblem at rest, "Starts Nov 4 · 3:00 PM EST", "Video appears here
  when the debate begins."), live before joining ("The debate is live", the turn summary, Join as
  viewer), replay before Play (emblem, Play replay, "10 turns · 10:00") and ended ("Debate
  ended"). The media status stays in its row under the video.
- **Captions:** a 44 px `#0f0f0f` pill under the video, cut at the start with an ellipsis, with a
  36 px toggle. Live only.
- **Scoreboard:** two cards (48 px initials, name, "@handle · speaking / listening / next", the
  side pill, filled white while that side has the floor) and the turn clock between them, with
  "Turn 3 of 10" below. Cards are white and grey only.
- **Turn clock:** the landing emblem's tiles on a canvas (`frontend/turn-clock.ts`, rules in
  `frontend/turn-clock-logic.ts`). As a turn starts the tiles light clockwise over 0.6 s; they
  then drain clockwise from 12 o'clock over the turn, with an ember in the visit's Yappers colour
  just behind the sweep. In the last 10 s the lit tiles and the time turn coral (`--warning`) and
  pulse once a second. The time (Forum) or a word ("Nov 4", "Replay", "Paused", "Next · Maya",
  "Closed") sits in the emblem's hole. It is a `role="timer"` named "42 seconds left in turn 3";
  "10 seconds left to answer." is announced once a turn while the ticket is open. It redraws only
  when a tile changes, only while a turn runs, the tab is visible and the clock is on screen.
  Reduced motion steps whole seconds with no refill, ember or pulse.

## Rail

- **Answer panel:** a `#0f0f0f` card, 24 px padding. "Do you agree?" in Dydema 28 px; the
  proposition in Forum 20/26. Yes and No are 48 px pills with their word only, a 12% tint and
  1 px border, solid with dark text when pressed. The turn and time line is kept for screen
  readers only; the clock shows it. Size chips are 40 px pills; the confirm button is the 48 px
  white pill; the receipt sits in a bordered box with a green check. The panel's logic, copy and
  hooks are unchanged.
- **Tabs panel:** a `#0f0f0f` card filling the rest of the rail, with pill tabs (WAI tabs pattern:
  arrows, Home and End). Each panel's heading is visually hidden; the tab names it.
- **AI outline:** the current turn first, then earlier turns, newest first, each under "Turn 3 ·
  Maya Chen (Free for everyone)" (a breathing dot on the current turn while live). Each argument
  is a card like the landing's argument cards: `#121212`, 1 px `--line` border, 12 px radius; an
  11 px capitals kicker, "Argument" in white or "Counterargument" in coral `#fa9b8c` when it
  rebuts another; the label 15/21 bold; "2 points · 1 rebuttal" 12 px muted. A card with more to
  show is one big button with a chevron: open, it shows its points as small boxes and "Rebuts" /
  "Rebutted by" links that open, scroll to and focus the other card. Cards stay open through
  updates. Earlier turns arrive as labels only, so their cards show points only if the page saw
  that turn live. "Listening for the next argument…" fills the next slot while live; "Written by
  AI…" sits under the list. A debater's own cards open to their flag buttons.
- **Results:** the chart restyled with CSS only (Yes green, No red, landing type, no gradient
  panel), its labels scaled up for the narrow panel.
- **About:** "About this debate" with the latest result, then the event, moderation and site
  links (Topics, Yap Coins, About YAP Arena).
- **Chat as a tab (< 1200 px):** the connection pill and a 44 px "⋯" menu (like, copy link, check
  chat now, QR code, overlay, report). Messages are 14/20 with the author in bold, coloured from
  the visit's five landing colours (`pickHeadlineColors()`) by a stable hash of the name. Time and
  Report show on hover or focus, always on touch. The composer is a 52 px pill with a 44 px white
  send button.

## Accessibility

Focus rings are 2 px `#f8f8f8` with a 3 px offset (drawn inside scroll boxes and the video; an
outline card's ring goes round the whole card). Headings: the question (`h1`), then "Do you
agree?", "Chat", "AI outline", "Results by turn" and "About this debate" (`h2`). The rail is a
labelled `aside`. Yes and No carry words and colours; the speaking state carries a word, a border
and the lit video frame. Reduced motion removes the hover fades, the frame and outline
transitions, the outline highlight, the clock's motion and the sheet animation.
