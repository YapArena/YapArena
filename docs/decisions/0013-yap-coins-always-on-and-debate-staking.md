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

## Staking on debates (approved design, not yet built)

Founder answers and snapshot approval, 2026-10-25. The panel is built after the turn-aligned
trading windows of Decision 0012 merge. A stake is an A4 endorsement in one turn's 60-second
window; there is no winner (F09).

- Layout: chat on the left, a large video in the centre, the betting panel on the right. The
  debate question appears in the video's top-left corner and "Live · N watching" in its top-right
  corner while the pointer is over the video.
- The panel asks "Do you agree?" with a green Yes and a red No button, each with a text label and
  icon. The word "bet" is not used.
- A "read of the room" slider ("What share will say yes this turn?") sets the A4 limit; a plain
  maximum price is under Advanced.
- One confirm button names the exact terms. A review pop-up is optional, remembered per device.
- Five-day reveal stays for user-created debates (F11). Replay viewers join only the window of the
  turn that's playing. There is no staking before a scheduled debate starts. Results notices are
  in-app only.
- The YAP human-run and refill controls leave the debate page; Bots mode moves behind a link.
