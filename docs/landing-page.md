# Landing page

`/` is an x.com-style landing page for readers without a session. The
[wide homepage](wide-homepage.md) moved unchanged to `/home`, including its
unavailable fallback and the development-only `?reference=1` view.

## Routes and sessions

- A request to `/` with a valid session cookie gets `303` to `/home`. A missing,
  revoked or expired session, or a failed session lookup, shows the landing page.
  The response is `no-store` with `Vary: Cookie`.
- The session cookie is `SameSite=Strict`, so a reader who follows a link from
  another site reaches `/` without it. The landing script then requests
  `/api/auth/me` from the same origin and replaces the page with `/home` when it
  succeeds.
- Sign-up and sign-in are the existing email-first Auth0 flow
  ([Decision 0009](decisions/0009-auth0.md)). "Continue with Google" and
  "Continue with email" pick the connection; "Sign in" lets Universal Login offer
  both. All three return to `/home`, which is also the login default when no return
  path is given. Sign-out still returns to `/`.
- Links that mean the app's home (the site header brand, the sign-in interstitial
  brand and the measurement page's back link) point to `/home`. Product
  measurement records `/home` as the `home` surface; the landing page loads no
  measurement script.

## Page

The landing page stands alone: it loads only `landing.css` and the `landing.js`
module, not the site header, homepage bundle or account scripts. The static logo
sits in the header, the sign-up actions on the left and the animated emblem on the
right.

### Spacing and layout

- Every margin, padding and gap uses the 8-point scale on `:root`: `--space-1`
  (4px) to `--space-8` (64px).
- Header, main and footer share one container (`max-width: 80rem`, gutters
  `clamp(1rem, 4.5vw, 4rem)`, never inside the phone safe areas). The logo,
  headline, buttons and Explore link start at the same left edge at every width.
- From 1000px the main area is a 12-column grid with a 32px gap: text in columns
  1–6, the emblem centered in columns 7–12 (at most 560px wide and 70vh tall). The
  bottom padding is 4vh larger than the top, lifting the content slightly above
  center.
- Gaps in the text column group related items: headline → "Join the arena." 32px,
  → first button 24px, between the sign-up buttons 12px, → "Already have an
  account?" 48px, → Sign in 12px, → Explore 24px.
- Header padding is 24px (16px on phones) around a 32px logo (28px). The footer
  has 24px padding and links at least 24px tall, 24px apart.
- Below 1000px the page is one column: the emblem (`min(60vw, 20rem)`, sized so
  the page fits a 390×844 phone without scrolling), a 32px gap, then the text.
  The headline's phone size is `clamp(2.25rem, 10vw, 3.4rem)`, so its longest
  line fits at 320px.

### Rotating headline

The headline loops through "Your opinions matter", "Your debates matter", "Your
ideas matter", "Your discussions matter" and "Yappers matter", 2.6s apart. Line 1
is "Y", a slot for "our"/"appers" and a slot for the noun; line 2 is "matter".
The block never changes height, so nothing below it moves.

- Steps 1→2, 2→3 and 3→4 move only the noun.
- 4→5 and 5→1 keep the "Y" in place and change the rest of line 1: "our" and
  the noun leave as "appers" arrives, and back again.
- Every step moves upward. Each track ends with a copy of its first item, so 5→1
  lands on the copies and then resets to the start without a visible change.
- The headline holds its step while the tab is hidden or Space has paused it.
- Splitting "Y" from the rest breaks the font's kerning, so the script measures
  each "Y" pair in the headline's font and pulls the word in by that amount.
- `frontend/landing-headline.ts` holds the step logic and
  `src/features/discovery/landing-web.ts` the words; a test keeps them equal.

The motion matches dydema.com's hero:

- **Word flip.** A slot clips its track with `inset(-0.3em -0.18em -0.06em)`.
  Each step moves the track up `1.6em` while the slot's width follows the
  incoming word, both over 0.7s with `cubic-bezier(0.19, 1, 0.22, 1)`. The first
  flip comes 2.6s after the headline's reveal ends.
- **Page-load reveal.** Blocks wipe up from `clip-path: inset(100% -8% -8%)` to
  `inset(-8%)` over 1.05s and fade in over 0.525s, with the same easing. The
  delays are 0s and 0.08s for the two headline lines, 0.16s for "Join the arena.",
  0.25s for the sign-up buttons, and 0.35s for the sign-in group and the Explore
  link. The reveal is CSS `@keyframes`, so it needs no script and the content ends
  visible without JavaScript.

With `prefers-reduced-motion: reduce` there is no reveal and no flip, and the
headline shows "Yappers matter". Without JavaScript it shows "Your opinions
matter". Screen readers hear one stable sentence, "Your opinions, debates, ideas
and discussions matter. Yappers matter."; the animated lines are `aria-hidden`.

### Word colors

"opinions", "debates", "ideas", "discussions" and "Yappers" each get their own
color; "Your" and "matter" stay white. `frontend/landing-colors.ts` picks a new
set with `Math.random()` on every visit and keeps it for the whole visit.

- Five OKLCH hues sit 72° apart from a random start, each moved by up to ±13.5°,
  so any two are at least 45° apart. That is wider than one color family, so a
  lavender rules out every other purple and a burgundy every other red.
- Lightness is 0.74–0.86 (0.86–0.92 for hues 80–130°, so yellows do not turn
  olive) and chroma 0.12–0.16.
- A color outside sRGB is first darkened, down to lightness 0.70, and only then
  loses chroma. Light blues, purples and reds would otherwise fade to grey; this
  keeps every color at chroma 0.115 or more, with at least 7.5:1 contrast on
  black.
- The colors are converted to `rgb()` in code and checked: each must have 4.5:1
  contrast on black, and every pair must stay 45° apart, or the set is drawn
  again. A shuffle then decides which word gets which color.
- On 4→5 the "Y" fades to the "Yappers" color with the flip (0.7s, same easing)
  and fades back to white on 5→1. The trailing copy of "opinions" shares the
  first one's color, so the loop reset shows no change.
- Without JavaScript every word stays white. Reduced motion shows "Yappers"
  colored, without the fade.

## Logo assets

The founder supplied both images on 2026-10-28:

- `public/landing/yaparena-logo.png` is `yaparena_precision_logo_name.png`
  (575×151).
- `public/landing/yaparena-emblem.png` is the 2048×1715 PNG embedded in the
  supplied animated logo page (`yaparena-source.zip`, `index.html`).

## Animation

`frontend/pixel-life.ts` holds the settings and pure planning code;
`frontend/landing.ts` renders it. The site's content security policy blocks
inline scripts, so the supplied page's two inline scripts were ported to strict
TypeScript. Settings, algorithms, timings, canvas layers, filters, compositing,
pointer handling, the hidden-tab pause and the reduced-motion fallback are
unchanged. There are two intentional differences:

1. Space pauses or resumes the animation only when focus is not on a link,
   button or form control, so keyboard users can still activate the page's
   controls. The same key also pauses the looping headline (WCAG 2.2.2), and
   one status message covers both.
2. The screen-reader description names the YAP Arena emblem and says Space
   pauses the headline too.
