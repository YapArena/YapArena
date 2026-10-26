# Decision 0013 — Yap Coins always on, and staking on debates

Status: approved by the founder, 2026-10-25. Amends [Decision 0009](0009-auth0.md) point 8 for
opening the coin sandbox only. Works within [Decision 0010](0010-single-ledger.md) (one `coin_*`
ledger) and the phase-1 rules in the [financial brief](../financial-architecture-options.md).

## Yap Coins are always on

Founder: "yapcoins are always turned on... so no need to put that as an option." Confirmed the
same day: every account gets Yap Coins and the welcome grant automatically, and withdrawals keep
their fresh sign-in.

1. Every account's coin sandbox is open. There is no opening confirmation and no unlock or claim
   step. The account's first own sandbox request records an automatic opening
   (`coin_sandbox_openings.operation_id` is NULL). Browsers call `POST /api/coin-sandbox/initialize`
   as soon as a summary reports no welcome grant, which claims the 2,500 YC welcome grant once.
   `GET /api/coin-sandbox/summary` stays read-only.
2. The opening confirmation routes (`/opening/operations`, `/opening`) and the `sandbox.open`
   purpose are removed. Openings confirmed before this decision keep their operation.
3. Each withdrawal and each recovery consent still needs its own fresh sign-in, with every
   safeguard in 0009 point 8.
4. Owner authority never opens an account's sandbox. Owner funding confirmations and new payout
   authorization still require the opening that the account's own first request recorded.
5. "On first sign-in" is implemented as the account's first sandbox request, inside the sandbox.
   The Auth0 sign-in path and account creation are unchanged.

Consequence: a testnet deposit no longer needs an earlier fresh sign-in, because the funding quote
that precedes it opens the sandbox. The founder accepted this on 2026-10-26: testnet deposits may
follow an automatic opening.

Migration `1792972953000_allow-automatic-sandbox-openings` makes `operation_id` nullable. It only
expands the schema: the previous release keeps working, and it reads automatic openings as open.

## Staking on debates

Founder answers and snapshot approval, 2026-10-25; sides correction and staging, 2026-10-26.
Built on the turn windows and round rules of Decision 0012 (pull requests 1, 1b and 1c). A stake
is an A4 endorsement in one turn's 60-second window; there is no winner (F09).

- Layout: chat on the left, a large video in the centre, the betting panel at the top of the
  right column. The debate question appears in the video's top-left corner and "Live · N
  watching" in its top-right corner while the pointer is over the video.
- The panel asks "Do you agree?" about the debate's proposition, with a green Yes and a red No
  button, each with a text label and icon. The word "bet" is not used.
- Yes and No belong only to the question. A turn names its speaker by display name and topic side
  label ("Turn 3 · Maya speaking (People first)"); side A is not the yes side, and no speaker is
  coloured by answer.
- A "read of the room" slider ("What share will say yes this turn?") sets the A4 limit: the yes
  ceiling is the read, the no ceiling is 100 minus it. A plain maximum price is under "Set a
  maximum price instead".
- One confirm button names the exact terms. A review pop-up is optional, remembered per device. A
  one-time explanation shows the first time the ticket opens on a device.
- A window that closes before the viewer confirms reserves nothing; the ticket keeps its values
  and offers the next turn.
- The next turn offers "Same as last turn", which pre-fills the ticket with the previous
  position's side, size and read; it still needs the confirm tap. Before a scheduled debate
  starts, "Get ready" saves a default size and read on the device, and every ticket opens with
  them. Neither places anything by itself.
- At reveal, a results card lists each revealed position (price from the position's side, final
  yes share and result) under a total; positions still locked stay in "Your positions".
- Five-day reveal stays for user-created debates (F11): live viewers see their receipt and the
  participant count (F12), never side totals, until the 120-hour close. Debaters can't take a
  position in their own debate (F14). Replay viewers join only the window of the turn that's
  playing, sent with its recording position (F10). There is no staking before a scheduled debate
  starts. Results notices are in-app only.
- Results notice (interface 10): every page except the reference homepage loads
  `frontend/results-notice.ts`. For a signed-in viewer it reads
  `GET /api/coin-sandbox/results?since=` on page load, on tab focus, and (spread over up to 3 s) on
  the personal stream's `results` event, through `frontend/lib/user-stream.ts`. It subscribes only
  after a successful read, so a site with Yap Coins off opens no stream for it. New results show as
  a dismissible notice that groups them per debate and links to each one. Dismissing it or opening
  a debate from it stores the newest reveal time on the device (`yaparena-results-seen:<account>`);
  a device's first check looks back seven days.
- Staged (founder, 2026-10-26): the YAP human-run and refill controls were removed first, with the
  Bots sandbox behind a tab next to Info. Bots mode then moved to `/coins` entirely: the debate
  page keeps the shared bot history chart and an info card linking to `/coins?debate=…`. On
  `/coins` the human mode option is gone and the run-scoped daily play-coin refill stays for Bots
  runs; only the account-wide refill is retired (410).
