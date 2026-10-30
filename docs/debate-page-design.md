# Debate page design

`/debates/<slug>` follows direction **BC1**, chosen by the founder on 2026-10-30 from the round 2
design canvas: a large stage with the answer panel and chat in a right rail, the debaters in match
cards under the video with the turn clock between them, and the AI outline as argument cards. It
amends [Decision 0013](decisions/0013-yap-coins-always-on-and-debate-staking.md) (chat moves to
the rail). Everything else in Decisions 0012 and 0013 stands. Behaviour and data flow are in
[the debate workspace](debate-workspace.md).

The work lands in three pull requests: layout and look (this record), the emblem turn clock (after
the queue overlay's `frontend/pixel-emblem.ts` exists), and the replay timeline with per-turn
results (needs S's clearance for `frontend/arena-chart.ts`). Until the second lands, the clock is
text; until the third, the replay keeps the existing chart, restyled.

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

| Width       | Layout                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1200 px   | Grid `minmax(0, 1fr) 400px`, gap 24, padding 16 24 24, max width 1920. The video is `min(100%, (100svh − 296px) × 16/9)` wide, centred: 968 × 544 at 1440 × 900. The rail is sticky and as tall as the screen allows; chat fills it (at least 360 px) and the rail scrolls when the ticket makes it taller. |
| 960–1199 px | Rail 340 px. The cards drop the @handle and show the side as text. Outline cards in two columns.                                                                                                                                                                                                            |
| 600–959 px  | One column, max width 720: stage, panel, Outline \| Chat tabs (chat 480 px tall), then the rest.                                                                                                                                                                                                            |
| < 600 px    | Video full-bleed with no radius, compact cards, the tabs, then the answer bar pinned to the bottom with safe-area padding. Picking Yes or No opens it as a sheet (at most 85svh, scrolls); Back or Escape closes it and returns focus to the answer.                                                        |

On phones the bar steps aside while the chat composer has focus or the cookie banner is open, and
`scroll-padding-bottom` keeps focused elements clear of it. No width from 320 px up scrolls
sideways.

## Stage

- **Video:** flat `#0f0f0f` when empty, 16 px radius on wide screens. Participant videos are
  ordered by side (A left, B right) from the speaker token's metadata, and the side with the floor
  gets a 2 px white inset ring (`data-active-side` on `[data-arena]`).
- **Hover corners:** black at 72%, 12 px radius; the question as a 20 px bold `h1`; "Live · N
  watching" with a white dot.
- **Empty states:** upcoming (emblem at rest, "Starts Nov 4 · 3:00 PM EST", "Video appears here
  when the debate begins."), live before joining ("The debate is live", the turn summary, Join as
  viewer), replay before Play (emblem, Play replay, "10 turns · 10:00") and ended ("Debate
  ended"). The media status stays in its row under the video.
- **Captions:** a 44 px `#0f0f0f` pill under the video, cut at the start with an ellipsis, with a
  36 px toggle. Live only.
- **Scoreboard:** two cards (48 px initials, name, "@handle · speaking / listening / next", the
  side pill, filled white while that side has the floor) and the centre: the time left (Forum
  28 px) or a word ("Nov 4", "Replay", "Paused", "Next · Maya", "Closed"), with "Turn 3 of 10"
  below. Cards are white and grey only.
- **AI outline:** heading, turn and AI note on one line, then the turn's arguments as cards (4, 2
  or 1 columns) in a fixed-height box that scrolls inside itself. "Listening for the next
  argument…" fills the next slot while live.
- **Chart and About:** the chart restyled with CSS only (Yes green, No red, landing type, no
  gradient panel), then "About this debate" with the latest result.

## Rail

- **Answer panel:** a `#0f0f0f` card, 24 px padding. Turn line 14 px bold; meta and "0:42 left"
  12 px muted; "Do you agree?" in Dydema 28 px; the proposition in Forum 20/26. Yes and No are
  48 px pills with icons, a 12% tint and 1 px border, solid with dark text when pressed. Size
  chips are 40 px pills; the confirm button is the 48 px white pill; the receipt sits in a
  bordered box with a green check. The panel's logic, copy and hooks are unchanged.
- **Chat:** "CHAT", the connection pill and a 44 px "⋯" menu (like, copy link, check chat now,
  QR code, overlay, report). Messages are 14/20 with the author in bold, coloured from the visit's
  five landing colours (`pickHeadlineColors()`) by a stable hash of the name. Time and Report show
  on hover or focus, always on touch. The composer is a 52 px pill with a 44 px white send
  button.

## Accessibility

Focus rings are 2 px `#f8f8f8` with a 3 px offset (drawn inside scroll boxes and the video).
Headings: the question (`h1`), then "Do you agree?", "Chat", "AI outline", "Results by turn" and
"About this debate" (`h2`). The rail is a labelled `aside`. Yes and No carry icons and words; the
speaking state carries a word and a border. Reduced motion removes the hover fades, the outline
highlight and the sheet animation.
