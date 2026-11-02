import { html, type SafeHtml } from "../html.ts";

// These pages sit between YapArena and the sign-in provider, so they carry the
// site kit's look themselves (docs/site-design.md) instead of loading the
// site's stylesheets: the landing logo, a Dydema heading, the pixel loader,
// a 16 px card and the kit's pills.
const style = html`<style>
  @font-face{font-family:"Dydema Capitals";font-display:swap;src:url("/assets/landing/fonts/headline.woff2") format("woff2")}
  @font-face{font-family:"Forum";font-display:swap;src:url("/assets/landing/fonts/forum-latin-400-normal.woff2") format("woff2")}
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px 16px;background:#000;color:#f4f4f4;font:16px/1.5 Arial,Helvetica,sans-serif}
  main{display:grid;gap:16px;width:min(30rem,100%);padding:32px;border:1px solid #4b4b4b;border-radius:16px;background:#0f0f0f}
  .brand{display:inline-flex;align-items:center;min-height:44px;margin-bottom:8px;justify-self:start}
  .brand img{display:block;width:auto;height:26px}
  h1{margin:0;font:400 1.75rem/1.3 "Dydema Capitals",Forum,Georgia,serif;letter-spacing:0;text-transform:uppercase}
  p{margin:0;color:#a9a9a9;font-size:1rem;line-height:1.5}
  .actions{display:grid;gap:12px;margin-top:8px}
  .button,.secondary{display:flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border-radius:999px;font-weight:700;font-size:.95rem;text-decoration:none}
  .button{background:linear-gradient(180deg,#fcfcfc,#f7f7f7);color:#0c0c0c}
  .secondary{border:1px solid #4b4b4b;background:#161616;color:#e2e2e2}
  .button:hover{filter:brightness(0.88)}.secondary:hover{border-color:#f3f3f3}
  a:focus-visible{outline:2px solid #f8f8f8;outline-offset:3px}
  .loader{display:grid;grid-template-columns:repeat(3,6px);gap:2px;width:max-content}
  .loader i{width:6px;height:6px;background:rgb(238 180 80);opacity:.18;animation:tile 1.2s cubic-bezier(.19,1,.22,1) infinite}
  .loader i:nth-child(3n+2){background:rgb(149 151 255)}.loader i:nth-child(3n){background:rgb(124 225 151)}
  .loader i:nth-child(4){background:rgb(252 146 161)}.loader i:nth-child(8){background:rgb(27 174 211)}
  .loader i:nth-child(2){animation-delay:.1s}.loader i:nth-child(3){animation-delay:.2s}.loader i:nth-child(6){animation-delay:.3s}.loader i:nth-child(9){animation-delay:.4s}.loader i:nth-child(8){animation-delay:.5s}.loader i:nth-child(7){animation-delay:.6s}.loader i:nth-child(4){animation-delay:.7s}.loader i:nth-child(5){animation-delay:.8s}
  @keyframes tile{0%,100%{opacity:.18}20%{opacity:1}}
  @media (prefers-reduced-motion:reduce){.loader i{animation:none;opacity:.6}}
  .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
</style>`;

const brand = html`<a class="brand" href="/home"><img src="/assets/landing/yaparena-logo.png" width="575" height="151" alt="YAP Arena home"></a>`;

// Dydema text: the real spelling for screen readers, capitals with U shown as
// V for the eye (src/features/discovery/inscribe.ts).
const heading = (text: string) =>
  html`<h1><span class="sr-only">${text}</span><span aria-hidden="true">${text.toLowerCase().replace(/u/g, "v")}</span></h1>`;

function page(title: string, body: SafeHtml, refresh?: string) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? html`<meta http-equiv="refresh" content="${`0;url=${refresh}`}">` : ""}
<title>${title} · YAP Arena</title>
${style}
</head>
<body><main>${brand}${body}</main></body>
</html>`.toString();
}

// The provider's redirect to the callback is cross-site, so a browser would
// withhold the SameSite=Strict session cookie on an immediate HTTP redirect.
// This same-site hop sends it on arrival.
export function renderSignInContinue(
  returnPath: string,
  title = "You're signed in",
) {
  return page(
    "Signing you in",
    html`<span class="loader" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>${heading(title)}<p>Taking you back to YAP Arena…</p><div class="actions"><a class="button" href="${returnPath}">Continue</a></div>`,
    returnPath,
  );
}

export function renderSignInProblem(input: {
  title: string;
  message: string;
  retry?: string;
  back: string;
}) {
  return page(
    input.title,
    html`${heading(input.title)}<p role="alert">${input.message}</p>
<div class="actions">${input.retry ? html`<a class="button" href="${input.retry}">Try again</a>` : ""}<a class="${input.retry ? "secondary" : "button"}" href="${input.back}">Back to YAP Arena</a></div>`,
  );
}
