# Decision 0016 — Full-screen watching on phones

Status: the clickable prototypes were approved by the founder on 2026-11-16 ("i approve of the
clickable prototypes"). The founder answered D1–D9 the same day (D8 was dropped). This amends the phone row of the [debate page design](../debate-page-design.md#layout),
[Decision 0013](0013-yap-coins-always-on-and-debate-staking.md) (the ticket and the results card on
phones) and [Decision 0015](0015-last-answer-endorsement.md) (where the bar sits on phones).
Computers and tablets keep today's page.

## Approved design

The reference is the private design canvas "Full-Screen Debate Watch", page "Clickable
prototype". It has four boards: vertical with the question at the bottom, vertical with the
question at the top, horizontal with the question at the top, and horizontal with the question at
the bottom. Only the approved choices below are built.

A phone is a viewport under 600 px wide, or a landscape viewport under 500 px tall.

1. **The only way to watch.** On a phone, a live debate or a replay is watched only in full screen.
   - Everything else on the phone debate page stays as it is: the header and its tab row, the
     cards, the tabs (Arguments, Chat, Results, About) and the answer bar.
   - Only the inline video goes. In its place, "Join as viewer" or "Play replay" opens the full
     screen, and there is no Enlarge button.
   - Back closes the full screen and returns to the page. A live debate stops playing; a replay
     pauses where it was.
   - While the full screen is open, it covers the header, the tab row and the footer, and it keeps
     clear of the safe areas (notch and home indicator).
2. **Vertical.**
   - Side A's camera sits over side B's, together filling about 82% of the height.
   - The turn clock is a 76 px ring on the seam.
   - Under the cameras, a 146 px dock holds the last-answer bar, then Yes and No.
   - The side rail on the right holds Chat, Turns and Share.
3. **Horizontal.**
   - Side A and side B sit side by side.
   - Centred on the seam at the bottom are the last-answer bar, then Yes · clock · No.
   - Yes sits under side A (D2).
   - The rail holds Chat and Turns.
4. **Answer keys.**
   - Solid green Yes and red No keys with stepped pixel corners and a key-cap edge.
   - The words are written out, with no icons.
   - "Do you agree?" is not shown.
   - After placing, the key keeps the size ("Yes · 25"); the other key dims.
5. **Answer sheet.** Picking Yes or No opens a sheet. From top to bottom:
   - the side word and the clock;
   - size chips 10 · 25 · 50 · 75 · 100;
   - the read slider ("What share will say yes this turn?");
   - one button naming the exact terms, which updates as the size or read changes ("Place Yes · 25 · max 14.50 YC");
   - "Final once placed. Yap Coins are play money with no cash value."

   The sheet shows no turn number, no question and no "Reserved now", "Most you can lose" or fee lines. The button still names the terms that Decision 0013 requires.

6. **Turns sheet.**
   - Titled "Turns".
   - It shows the bars of the revealed turns, the counts, the change since the last turn and the
     switching line.
   - There is no "Not a vote…" line.
7. **Turn result.** When a turn the viewer answered is revealed, a plate pops up in the middle of
   the screen for about 3.5 s.
   - It shows "YOU WON" or "YOU LOST", the amount counting up from zero beside a pixel "YC" coin,
     and "N WINS IN A ROW" from the second win in a row. Breaking even shows "BROKE EVEN".
   - A win flashes a square shockwave and bursts green and white pixel bits. A loss shakes and
     drops red shards.
   - It is announced politely, once.
   - Under reduced motion it only fades.
   - It replaces the phone's results card. Every revealed position stays listed in the Turns sheet.
8. **Always on screen:** LIVE with the watching count, and the rail.
9. **Shown by a tap on the picture:** Back, the ··· button, the question (small, at the bottom),
   and the two name tags with their avatars.
   - They start hidden (D4), and a second tap hides them.
   - The speaker is shown by dimming the listener's camera; while the tags are shown, the speaker's tag is solid white.
   - An open chat stays open through taps.

## Founder answers, 2026-11-16

- **D1 — Last-answer bar.**
  - On phones, it sits in the dock above Yes/No (vertical) or above the answer cluster (horizontal).
  - On computers, it stays on the video's bottom edge, as Decision 0015 says.
  - The card still opens on tap.
- **D2 — Horizontal keys.** Yes sits under side A, which answers yes (Decision 0015).
- **D3 — Question.** The question goes at the bottom, in both orientations.
- **D4 — Controls.** They start hidden.
- **D5 — Replay controls.** No scrubber where the clock sits; see D9.
- **D6 — Only mode.** As point 1: full screen is the only way to watch on a phone, and the rest of
  the phone page stays.
- **D7 — The full screen's ··· sheet.** Approved as proposed:
  - The ··· button opens a sheet with:
    - Outline (live AI argument outline);
    - About;
    - Your positions;
    - "Get ready" defaults (removed by the amendment below);
    - "Set a maximum price instead" (removed by the amendment below);
    - the review pop-up switch (removed by the amendment below).
  - The answer sheet keeps "Same as last turn" as one line under the chips (removed by the
    amendment below).
  - The scoreboard cards are replaced by the name tags.
  - Live captions, when on, sit just above the dock.
  - Copy event link becomes Share (the system share sheet where available).
- **D8 — Overlays.** Dropped. Banners and notices behave as they do today.
- **D9 — Pausing.**
  - On a replay, the only control is pause and play: a centred key that shows and hides with the
    other tap controls. There is no seek bar and there are no native video controls.
  - A live debate cannot be paused.

## Amended 2026-11-16: one ticket everywhere

The founder, the same day: "make the answer sheet the standard everywhere people can place bets,
remove the get ready thing." Then, about the review pop-up and the other parts the first build
kept: "there wasn't this in the prototype snapshots, only put what was in the snapshots." This
amends point 5 and D7 above (D7's "Get ready" row, its maximum price and review rows, and "Same as
last turn" under the chips), and Decision 0013's ticket layout and its bullets on "Set a maximum
price instead", the review pop-up, the one-time explanation, "Same as last turn" and "Get ready".
Decision 0013's other rules stand: the key names the exact terms, Yes is green and No is red with
their words, and the word "bet" is not used on the page.

- **One ticket, only the approved sheet's parts.** Point 5's answer sheet, as in the approved
  prototype, is the only ticket wherever a viewer can answer: in the rail on computers and
  tablets (where the ticket is today, not a pop-up), in the phone page's answer sheet and over the
  full screen. It has the side word and the clock (and a close button where it is a sheet),
  "Size" with the chips 10 · 25 · 50 · 75 · 100, "What share will say yes this turn?" with its
  value and the slider, one key naming the exact terms that updates as the size or read changes,
  and "Final once placed. Yap Coins are play money with no cash value." Nothing else is in it; an
  error line shows under the read only when something goes wrong.
- **Gone from the ticket, everywhere:** the 5 chip and the typed size ("Contracts"), the terms
  list ("Reserved now", "Most you can lose", "You get back", fee, results), the "You'll pay at
  most" line, the turn number and the question.
- **Removed from the product:**
  - "Get ready", its saved defaults and its ··· row;
  - "Set a maximum price instead": the read alone sets the price;
  - the review pop-up and its switch: placing is immediate once the key is pressed;
  - the one-time "How it works" explanation;
  - "Same as last turn" (approved in D7, superseded by this instruction);
  - the "Available: N YC" line under the ticket (the header keeps the balance).

  The panel deletes their device keys (`yaparena-stake-defaults`, `yaparena-stake-review`,
  `yaparena-stake-explained`) once. The ticket opens at 10 contracts and a 50% read and keeps the
  last size and read used on the page.

- **The ··· sheet** keeps Outline, About and Your positions.
- **No heading or question on the panel.** Asked whether to remove the panel's "Do you agree?"
  heading and question too, the founder answered: "Yes, remove them". The answer panel in the
  rail and the phone's pinned answer bar start with Yes and No, and the panel is named "Answer
  this turn" for screen readers. This supersedes Decision 0013's "The panel asks 'Do you agree?'"
  bullet. The debate's question stays where else the page shows it (the page title, the video and
  the full screen).
- **Unchanged:** the page's Yes and No that open the ticket, the receipt, the results card and
  "Your positions" outside the full screen, and the header balance. On the phone page the pinned
  answer bar opens the same sheet as the full screen, with the receipt, results and positions
  under the ticket as before.

## Engineering notes

- **Replays.** A replay is one side-by-side recording (LiveKit composite, grid layout).
  - Horizontal shows it as it is.
  - Vertical keeps one hidden video and draws each half into its own canvas, one per camera. The
    sound, seeking and the `yap:playback` event stay on the video element.
- **Live video.** It already arrives as one element per side. Vertical stacks them with a grid row
  change.
- **Breakpoints.** Phones are detected with a media query in CSS and in `matchMedia`. The phone
  sheet logic, the chat placement and Enlarge stop keying off width alone.
- **Full screen.** It is a CSS takeover (`100svh`, safe-area padding), not the Fullscreen API,
  which iPhone Safari allows only on `<video>`.

## Delivery

| Pull request | Ships                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 0            | This record and the doc updates                                                                                 |
| 1            | Vertical live: the takeover, stacked cameras, clock on the seam, dock with the bar and keys, rail, tap controls |
| 2            | Answer sheet and Turns sheet; the ··· sheet (D7)                                                                |
| 3            | Turn result plate                                                                                               |
| 4            | Horizontal                                                                                                      |
| 5            | Replays on phones: split canvases, the pause key (D9)                                                           |

Each pull request lists its user-visible changes, updates the page snapshot and runs the phone
passes of the browser verifiers at 390 × 844, 320 × 640 and 844 × 390.
