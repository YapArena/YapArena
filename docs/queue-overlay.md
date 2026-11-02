# Queue overlay

The live topic queue ([Decision 0011](decisions/0011-live-matchmaking-and-challenges.md)) shows
one full-screen native `<dialog>` in the landing page's style. While the player waits, it shows
the landing emblem's living bursts, "Finding other humans…" and a rotating quote. On a match it
turns into the 30-second accept countdown in place, without changing the URL. The founder approved
the design on 2026-10-30 after four review rounds of a click-through preview. The preview is the
layout and behaviour reference; it and the design canvas are private to the founder.

## When it shows

- It opens when a queue ticket is created on a topic page, when a page loads with a waiting ticket
  the player hasn't folded away, from the header pill while queued, and on any page when a match
  is offered.
- **Keep browsing** folds it into the header pill for that ticket on every page of the visit
  (`sessionStorage` key `yaparena.queueOverlay.folded`). Escape does the same while waiting. A
  match always shows, and if it falls through the waiting screen stays open.
- **Leave queue** closes it. A missed or declined match shows "Match missed" or "Match
  declined" with **Queue again** (same topic and side) and **Close**. Other closing reasons show
  "Queue closed" with Close.
- When both players accept, "Entering the arena" shows for up to 600 ms (none under reduced
  motion), then the debate opens.

## Screen

- The topic sits at the top: "YOU ARGUE <side>" in Dydema Capitals above the title in Forum. The
  title is clamped to two balanced lines, or one on a phone on its side.
- Every timer uses `--font-display` (Dydema Capitals, which has no digits, so they show in Forum).
  This includes the header pill's time.
- Visible capitals follow the landing's inscription rule (U shown as V) through
  `src/features/discovery/inscribe.ts`. Screen readers get the real spelling.
- While waiting there is no small print. The status line is visually hidden but still read out.
- On a match, two player cards replace the quote: initials, name, handle, state ("Your move" or
  "Deciding", then "Accepted" in mint with no icon) and side. A card lights up in the countdown's
  colour when that player accepts: white, or coral (`--warning`) in the last 10 seconds.
- The quote cell keeps room for the longest quote, so nothing moves when quotes change or the
  match arrives. Phones stack the cards and put the buttons at the bottom. Phones on their side
  use two columns.

## Countdown

The ring uses the debate page's turn-clock rules (`frontend/turn-clock-logic.ts`) with
`total: 30`:

- it drains clockwise from 12 o'clock, with an ember in the visit's Yappers colour behind the sweep;
- in the last 10 seconds it turns coral and pulses once a second.

The overlay adds three opt-in pieces to the shared drawing in `frontend/pixel-emblem.ts`. The debate
page uses none of them.

- **Glow.** A blurred copy of the lit tiles sits behind the ring.
- **Sweep timing.** `sinceStart` times the 0.6-second opening sweep from when the page received
  the offer, so network delay doesn't cut it short. A page opened mid-offer skips the sweep.
- **Refill.** When both players accept, the spent tiles relight clockwise over 0.4 seconds.

The countdown is always computed from the server's deadline, so a late or hidden tab stays right.

## Motion

- Space pauses the bursts, the quote rotation and the dots while waiting, as on the landing
  (WCAG 2.2.2). There is no visible pause button: reduced motion and Keep browsing also stop the
  motion.
- Reduced motion removes the bursts, the word animations, the quote rotation, the sweep, the
  ember, the pulse and the glow. The ring then drains in whole seconds.

## Quotes

`frontend/queue-quotes.ts` holds the 16 approved quotes. Each next quote is picked with
`Math.random()` from those not yet shown this round, so none repeats until all have shown and none
shows twice in a row.

Every line except Solzhenitsyn's is public domain: the originals are old, and each translation is
our own or by a translator who died long ago. Solzhenitsyn's is one short, credited line from a 1975
speech. Before wide promotion:

- find de Staël's exact sentence in _Corinne_;
- check Solzhenitsyn's wording against a transcript of the speech;
- check every line against a public-domain copy of its source.

## Opponent

The offer carries `opponent: { handle, displayName, sideLabel }` on the player's private stream
only. The handle and name are null if the opponent's profile is no longer published.

## Files

- `frontend/queue-overlay.ts` (view) and `frontend/queue-overlay-logic.ts` (rules, tested in
  `tests/queue-overlay.test.js`).
- `frontend/matchmaking.ts` decides when the overlay shows, and loads it on first use.
- The styles are in `public/site.css`, under "Live topic queue".
