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
right. Below 1000px it becomes one column with the emblem first.

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
   controls.
2. The screen-reader description names the YAP Arena emblem.
