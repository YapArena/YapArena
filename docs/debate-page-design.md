# Debate page design

`/debates/<slug>` follows direction **BC1**, chosen by the founder on 2026-10-30 from the round 2
design canvas and revised in review the same day: a large stage with chat over the video, the
debaters in match cards under it with the emblem turn clock between them, and a right rail with
the answer panel above a panel of tabs (AI outline, Results, About). On a replay, a turn timeline
sits under the video and Results by turn under the scoreboard (the founder's replay board,
2026-11-02). It amends [Decision 0013](decisions/0013-yap-coins-always-on-and-debate-staking.md)
(see its 2026-10-30 and 2026-11-02 amendments). Everything else in Decisions 0012 and 0013 stands. Behaviour and data flow are in
[the debate workspace](debate-workspace.md). Phones (under 600 px) also get the argument being made
now under the speakers, an Arguments tab, Results by turn as rows and a price draw card (first-run
build plan PR 8, 2026-11-06); wider screens are unchanged.

The founder asked for the emblem clock in review, so it landed with the layout instead of in a
pull request of its own. `frontend/pixel-emblem.ts` has the countdown mode only; the queue overlay
adds the landing's living mode when it moves `startEmblem` out of `frontend/landing.ts`. The
replay timeline and Results by turn are new modules (`frontend/replay-timeline.ts`,
`frontend/turn-results.ts`, rules in `frontend/turn-results-model.ts`); `frontend/arena-chart.ts`
still draws the bot history's line chart, unchanged.

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

| Width       | Layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1200 px   | Grid `minmax(0, 1fr) 400px`, gap 24, max width 1920. The page fits one screen: the footer is hidden (its links are in About) and the video takes the largest 16:9 size above the status line and scoreboard (968 × 544 at 1440 × 900). Chat sits over the video when the video is at least 800 × 480 px; on a smaller video (about 1280 × 900 windows and smaller) it is a tab, as below 1200 px. The rail is the answer panel, then the tabs panel; the rail scrolls inside itself when the ticket is tall.   |
| 960–1199 px | One screen as above, rail 340 px. Chat becomes a tab ("Chat · N new" counts messages that arrive while it is hidden). The cards drop the @handle and show the side as text.                                                                                                                                                                                                                                                                                                                                    |
| 600–959 px  | One column, max width 720, scrolling: stage, answer panel, then the tabs panel (`min(560px, max(70svh, 26rem))` tall) with Chat as a tab.                                                                                                                                                                                                                                                                                                                                                                      |
| < 600 px    | Amended by [Decision 0016](decisions/0016-phone-full-screen-watch.md): the video is watched only in full screen, opened by Join as viewer or Play replay; the rest below stays. Video full-bleed with no radius, compact cards with the argument line under them, the tabs panel (Arguments, Chat, Results, About), then the answer bar pinned to the bottom with safe-area padding. Picking Yes or No opens it as a sheet (at most 85svh, scrolls); Back or Escape closes it and returns focus to the answer. |

On phones the bar steps aside while the chat composer has focus or the cookie banner is open, and
`scroll-padding-bottom` keeps focused elements clear of it. No width from 320 px up scrolls
sideways.

### Phone full screen

[Decision 0016](decisions/0016-phone-full-screen-watch.md). A phone is `PHONE_WATCH_QUERY` in
`frontend/watch-phone.ts`: under 600 px wide, or landscape under 500 px tall. There, Join as viewer
or Play replay opens the full screen (`frontend/watch-screen.ts`), and the page has no Enlarge and
never plays the video inline.

- **Takeover:** the video surface itself, fixed over the header, the tab row and the footer at
  `100svh` with safe-area padding, the page's scroll locked (`html.watch-open`). It is a modal
  dialog named by the question, with focus kept inside. `[data-arena]` carries `data-watch="open"`
  and `data-watch-orientation`. Back, Escape or the browser's back closes it: a live debate is
  left, a replay pauses where it was, and focus returns to the button that opened it.
- **Vertical:** side A's camera over side B's in the top 82% (`object-fit: cover`), the listener's
  camera dimmed; the 76 px turn clock on the seam (coral in the last 10 s, "NEXT" and the next
  speaker between turns) and the turn bar along the top; the 146 px dock with the last-answer bar
  (a line of figures over a 4 px track; a tap still opens its card) above the Yes and No keys.
  The keys press the answer panel's own Yes and No, so the answer sheet opens over the full screen
  and gives focus back to the key; after placing, the key reads "Yes · 25" and the other dims.
- **Always shown:** LIVE with the watching count, and the rail: Chat (the page's own chat,
  translucent over the lower camera with its composer), Turns (a sheet) and Share (the system
  share sheet, else Copy event link). On shorter phones the rail moves down to the dock, then
  tightens to 42 px buttons (from 671 px tall), and drops its words only under 634 px.
- **Tap controls:** a tap on the picture ("Show controls", a real button) shows Back, ···, the
  question at the bottom and the name tags with their avatars; they start hidden.
- **··· sheet (D7):** rows for Outline and About, then Your positions, "Set a maximum price
  instead" and the review pop-up switch ("Get ready" was removed on 2026-11-16). They are the
  page's own elements, moved into the sheet while it is open and put back when it closes, so they
  keep their state and behaviour.
- **Horizontal (Proto-H, 844 × 390):** A | B side by side, the name tags in the outer top corners,
  LIVE beside ···, and a 360 px answer cluster centred on the seam 14 px from the bottom: the
  last-answer bar, then Yes · 72 px clock · No with Yes under side A (D2). The question sits
  small above it, centred (D3). The rail is Chat and Turns. Chat is a 236 px translucent column
  over the right camera and moves the cluster and question left. Turns, ··· and the answer sheet
  are 392 px right-side sheets, and while one is open the rail, B's tag, the question, the
  cluster and chat step aside.

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
- **Chat over the video (≥ 1200 px and a video of at least 800 × 480 px):** in the lower right, from 42% of the video's height (at
  least 15rem tall) to 12 px from the bottom, `min(20rem, 50% − 10.5rem)` wide (at least 14rem)
  so it ends before side B's name tag. No title and no panel: a radial shadow in the corner keeps
  white text readable, the messages fade out towards the top, newest at the bottom. The composer
  is a 44 px see-through pill with the "⋯" menu beside it; the menu fills the chat area above
  the composer. "Load earlier messages" has its own row above the messages. A chat button next to Enlarge
  hides it; the choice is kept on the device (`yaparena-chat-overlay`).
- **Empty states:** upcoming (emblem at rest, "Starts Nov 4 · 3:00 PM EST", "Video appears here
  when the debate begins.", and with the live queue on a "Notify me" button with a bell that
  turns into an outlined "Notifying you"; see [the workspace](debate-workspace.md)), live before joining ("The debate is live", the turn summary, Join as
  viewer), replay before Play (emblem, Play replay, "10 turns · 10:00") and ended ("Debate
  ended"). The media status stays in its row under the video.
- **Captions:** a 44 px `#0f0f0f` pill under the video, cut at the start with an ellipsis, with a
  36 px toggle. Live only.
- **Replay timeline (replays):** under the video, one segment per turn with 4 px gaps: a 6 px
  track (`#262626`) that fills white as the turn plays, a 16 px white thumb ringed in black on the
  playing turn, and a 44 px target around each. Choosing a turn seeks the replay to its start, or
  presses Play replay first and seeks once the recording loads. One tab stop; the arrow keys,
  Home and End move between turns. Its 44 px stay reserved while the window list loads, and stay
  empty if the turns have no places in the recording.
- **Results by turn (replays, under the scoreboard; the Results tab elsewhere):** see Results
  below.
- **Endorsement bar ([Decision 0015](decisions/0015-last-answer-endorsement.md)):** the
  debate's last-answer figure on the video's bottom edge, the surface's last child, on debates
  with turn windows whose question is the topic title. A 6 px track (black at 55%, 1 px white top
  edge at 16%) with a white fill at the Yes share, animating its width over 0.12 s (none under
  reduced motion), clipped by the surface's rounded corners, at z-index 5: above the frames and
  the overlay chat, below the chat and Enlarge buttons. Its hit area is 12 px tall, below the
  overlay chat, and shrinks to the visible 6 px while the replay video shows, so the native
  controls keep their clicks. It is a `role="meter"` ("Viewers' last answers", its value text
  "47% Yes, People first; 53% No, Markets first; 3,491 accounts") with a 2 px focus outline inset
  in the surface, always visible, and stays on the bottom edge in expanded mode. Hovering with a
  mouse, keyboard focus, a tap, Enter or Space opens a card above it (black at 86%, 12 px radius,
  at most 20rem wide), centred on the share's edge and kept inside the surface: "Last answers in
  this debate", each side's label and share in Forum 24 px, "1,640 Yes · 1,851 No · 3,491 accounts
  · through turn 6", the change since the previous counted turn ("Since turn 5: +2 pts Yes", "No
  change since turn 5" or "First revealed turn"), how many accounts changed answer ("120 accounts
  changed answer: 70 to Yes, 38 to No, 12 changed back" or "No one changed answer") and "Not a
  vote, a price or a forecast." Escape, blur, the mouse leaving or a tap elsewhere closes it, and
  nothing in it is announced live. A topic the founder reviewed as "side A is not yes" shows plain
  Yes and No instead of the side labels. Before a reveal the bar is empty and the card says "Fills
  after each turn's answers are revealed." or, for a five-day debate, "Answers stay hidden until
  Nov 18 at 3:00 PM EST, 5 days after the debate." It reads the `endorsement` block of the window
  list (`frontend/endorsement-bar.ts`, wording in `frontend/endorsement-bar-model.ts`). On a
  replay it follows playback: from each turn's first second it shows the figure through that turn
  (`endorsementTurns`), a void turn keeps the one before, and before turn 1 it is empty with "Fills
  as each turn plays."; a seek changes it at once.
- **Scoreboard:** two cards (48 px avatar, or "?" before a speaker is named; name, "@handle ·
  speaking / listening / next", the
  side pill, filled white while that side has the floor) and the turn clock between them, with
  "Turn 3 of 10" below. Cards are white and grey only.
- **Argument line (phones):** with the AI outline on, a line under the cards (the scoreboard's last
  row) names the argument being made now, from the outline state the panel paints
  (`frontend/outline-now.ts`): "Argument" in white or "Counterargument" in coral `#fa9b8c` with the
  speaker's first name and turn ("Counterargument · Maya · turn 5", an 11 px capitals kicker), then
  the label (15/20 bold, two lines kept so the page under it stays put) on `--panel` with a 3 px
  left border in the kicker's colour. When the media snapshot (`yap:turn`) reports a turn the
  outline hasn't reached, it reads "Léo · turn 6" and the panel's "Listening for the next
  argument…" in muted text. It hides once the debate ends, and on a replay until the player
  reports a position. Not announced: the panel already announces new arguments.
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
  readers only; the clock shows it. The receipt sits in a bordered box with a green check.
- **Ticket (Decision 0016, amended 2026-11-16):** one ticket wherever a viewer answers: under Yes
  and No in this card, and as the phone's answer sheet. The side word (Forum 32 px caps, green
  or red) and the clock pill; "Size" and the chips 10 · 25 · 50 · 75 · 100 (44 px pills, no
  typed size); "Same as last turn" as one underlined line under them; "What share will say yes
  this turn?" with the read in Forum 26 px over the slider; one 56 px pixel-corner key in the
  side's colour naming the exact terms ("Place Yes · 25 · max 14.50 YC"), updating as the size
  or read changes; then "Final once placed. Yap Coins are play money with no cash value." Below
  it, small and secondary: "Set a maximum price instead" (collapsed) and the review pop-up
  switch. No turn number, question, terms list, "Reserved now", "Most you can lose", fee or "pay
  at most" line. There is no "Get ready": the ticket opens at 10 contracts and a 50% read and
  keeps the last ones used on the page.
- **Phone answer sheet:** Yes or No in the pinned answer bar, or a key in the full screen, opens
  the ticket as a bottom sheet (22 px top corners, a handle, a round close button, named "Your
  answer: Yes"); Back shows instead while there is no ticket to show. On the page the receipt,
  balance, results and "Your positions" stay under it as before; over the full screen the
  maximum price, review switch and positions are in the ··· sheet, and a placed answer closes
  the sheet.
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
  AI…" sits under the list. A debater's own cards open to their flag buttons. On phones the tab
  and its heading say "Arguments" (the same panel and cards).
- **Results by turn:** "Results by turn" in Dydema 16 px beside "Share who said yes in each
  60-second window · bars rise for a yes majority and drop for a no majority" (14 px muted). A
  two-line caption (15/24) names the turn and speaker, the argument in bold and the result, for the
  turn under the pointer or focus, else the chosen turn (the latest revealed one at first), else
  when results come. Below it, one 184 px column per turn on a dashed 50% line 88 px down, with
  "50%" in a gutter on the right: a 32 px bar (4 px radius) in Yes green rising from the line or
  No red dropping from it, at 4 px per percentage point (less when a share is far from 50%, so
  bars keep within 56 px), its value in Forum 18 px beyond it, then the turn number and the
  speaker's first name ("playing" under the playing turn). The chosen column is filled
  `--raised`, the playing one outlined in `--control-border`; unrevealed turns are empty. In a
  narrow chart (under 36rem: the rail panel and phones) values are 14 px and speakers are
  initials. Bars are buttons with one tab stop; hover or focus previews a turn in the caption,
  choosing it fills it and, on a replay, plays it. "Price and typical limits" (the price
  inspector and its turn picker) is a disclosure under the bars, closed at first. With Bots mode
  on, the bot history keeps its line chart, restyled with CSS only, until a turn is revealed.
- **Results by turn on phones:** one row per turn with a result (revealed, unanswered or
  cancelled; turns still to come or waiting for their reveal stay off, and the caption says when
  results come). A row is a 44 px button: "Turn 4", a 10 px bar split at the yes share (Yes green,
  then No red), the share in Forum 16 px, and under them the speaker's first name and the turn's
  argument labels in 13/18 muted ("Léo · “Fares fund a third of operations”"), or the result in
  words when there is no share. The chosen row is filled `--raised`, the playing one outlined. The
  rows carry the caption's content, so the caption shows only while there are none; the line
  under the heading reads "… · tap a turn for its price draw". Up and Down move between rows as
  well as Left and Right. Tapping a revealed row opens the disclosure as a card and scrolls it into
  view.
- **Price draw card (phones):** the disclosure's summary reads "Price draw · _a_ < _p_ < _b_", with
  the inspector's previous and next buttons and "Turn 4" beside it (its select is hidden). In a
  `--bg` card with a 1 px `--line` border: the inspector's scale (the draw range as the band, the
  typical limits as ticks, the drawn Yes price as a ringed dot, the final yes share and the
  viewer's own limit), then three chips "_a_ 0.45 < _p_ 0.52 < _b_ 0.60" captioned "Typical No
  limit", "Drawn Yes price" and "Typical Yes limit" (hidden from screen readers; the values are in
  the inspector's own lines). A whole-range draw (the engine's exploratory or fallback branch)
  draws the band over the whole track, reads "0 < _p_ 0.81 < 1" with "Whole range" under 0 and 1,
  and adds "Drawn over the whole range, from 0 to 1 YC." Then the inspector's drawn Yes and No
  prices, explanation and legend. Signed-in viewers' own limits come from the answer panel's
  private read (`yap:stake-rounds`, kept for late modules like the window list in
  `frontend/stake-windows.ts`), on every width. Under 360 px the turn buttons take their own
  row at the top of the card, and the tabs' side padding narrows to 6 px so the four names fit.
- **About:** "About this debate" with the event, moderation and site links (Topics, Yap Coins,
  About YAP Arena). Its latest result bar was removed with the endorsement bar (Decision 0015, D2);
  with the bar on, the note under the details says what it counts.
- **Chat as a tab (< 1200 px, or a smaller video):** the panel grows to at least 26rem while Chat is open (the rail scrolls on short screens). The connection pill and a 44 px "⋯" menu (like, copy link, check
  chat now, QR code, overlay, report), which ends just above the composer, measured as it opens. Messages are 14/20 with the author in bold, coloured from
  the visit's five landing colours (`pickHeadlineColors()`) by a stable hash of the name. Time and
  Report show on hover or focus, always on touch. The composer is a 52 px pill with a 44 px white
  send button.

## Accessibility

Focus rings are 2 px `#f8f8f8` with a 3 px offset (drawn inside scroll boxes and the video; an
outline card's ring goes round the whole card). Headings: the question (`h1`), then "Do you
agree?", "Chat", "AI outline", "Results by turn" and "About this debate" (`h2`). The rail is a
labelled `aside`. On phones the outline's tab and heading are "Arguments". Yes and No carry words and colours; the speaking state carries a word, a border
and the lit video frame. Reduced motion removes the hover fades, the frame and outline
transitions, the outline highlight, the clock's motion and the sheet animation.
