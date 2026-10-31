import { asset } from "./assets.ts";
import { html } from "../../platform/html.ts";

// Placeholder artwork built from the landing emblem and logo (public/icons/).
// /favicon.ico is served at the root, where browsers also look for it.
export function iconLinks() {
  return html`<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="apple-touch-icon" href="${asset("icons/apple-touch-icon.png")}"><link rel="manifest" href="${asset("manifest.webmanifest")}">`;
}

// Open Graph tags give a shared link its title, text and image. X reads
// them too and needs only its own card type. Every URL must be absolute.
export function shareMetadata({
  origin,
  title,
  description,
  url,
}: {
  origin: string;
  title: string;
  description: string;
  url: string;
}) {
  return html`<meta property="og:site_name" content="YAP Arena"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${url}"><meta property="og:image" content="${origin}${asset("icons/share.png")}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="YAP Arena"><meta name="twitter:card" content="summary_large_image">`;
}

export function siteFooterMarkup() {
  return html`<footer class="site-footer"><div class="container footer-inner"><span>YAP ARENA <span class="muted">/ Ideas under pressure.</span></span><span><a href="/topics">Topics</a> · <a href="/coins">Yap Coins</a> · <a href="/about">About</a> · Play money</span></div></footer>`;
}
