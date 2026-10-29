import { html, type SafeHtml } from "../html.ts";

// These pages sit between YapArena and the sign-in provider, so they carry the
// brand and colours themselves instead of loading the site's stylesheets.
const style = html`<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(90% 60% at 50% 0,#1c1c1c 0,transparent 60%),#000;color:#f4f4f4;font:16px/1.5 Arial,Helvetica,sans-serif}
  main{width:min(440px,100%);padding:34px 30px 30px;border:1px solid #414141;border-radius:26px;background:#0f0f0f;box-shadow:0 40px 120px #000000aa}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;color:#fff;font-size:.72rem;font-weight:700;letter-spacing:.16em;text-decoration:none}
  .brand svg{width:26px;height:30px;fill:none;stroke:#f8f8f8;stroke-width:2.4}
  h1{margin:0 0 10px;font-size:1.7rem;line-height:1.15;letter-spacing:-.04em}
  p{margin:0;color:#b9b9b9;font-size:.92rem;line-height:1.6}
  .actions{display:grid;gap:10px;margin-top:26px}
  .button,.secondary{display:flex;align-items:center;justify-content:center;min-height:50px;padding:0 18px;border-radius:14px;font-weight:700;font-size:.9rem;text-decoration:none}
  .button{background:linear-gradient(180deg,#fcfcfc,#f7f7f7);color:#0c0c0c}
  .secondary{border:1px solid #4b4b4b;background:#161616;color:#e2e2e2}
  .button:hover{filter:brightness(0.88)}.secondary:hover{border-color:#f3f3f3}
  a:focus-visible{outline:2px solid #f8f8f8;outline-offset:3px}
  .spinner{width:34px;height:34px;margin-bottom:18px;border:3px solid #3b3b3b;border-top-color:#f8f8f8;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spinner{animation:none}}
</style>`;

const brand = html`<a class="brand" href="/home" aria-label="YAP Arena home"><svg viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="20" rx="13" ry="16" transform="rotate(30 20 20)"/><path d="M9 35 31 5"/></svg><span>YAP ARENA</span></a>`;

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
  heading = "You're signed in",
) {
  return page(
    "Signing you in",
    html`<div class="spinner" aria-hidden="true"></div><h1>${heading}</h1><p>Taking you back to YAP Arena…</p><div class="actions"><a class="button" href="${returnPath}">Continue</a></div>`,
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
    html`<h1>${input.title}</h1><p role="alert">${input.message}</p>
<div class="actions">${input.retry ? html`<a class="button" href="${input.retry}">Try again</a>` : ""}<a class="${input.retry ? "secondary" : "button"}" href="${input.back}">Back to YAP Arena</a></div>`,
  );
}
