// Markup helpers for the site kit (docs/site-design.md), shared by the pages
// that move onto it.
import { html, type SafeHtml } from "../../platform/html.ts";
import { inscribe } from "./inscribe.ts";

// Text set in Dydema Capitals: the real spelling for screen readers, and
// visible capitals with U shown as V, hidden from them. `emphasis` is set in
// the visit's second colour, as the landing's headline does.
export function inscription(text: string, emphasis = ""): SafeHtml {
  const visible = inscribe(text.toLowerCase());
  return html`<span class="sr-only">${text}${emphasis ? ` ${emphasis}` : ""}</span><span class="ins" aria-hidden="true">${visible}${emphasis ? html` <em>${inscribe(emphasis.toLowerCase())}</em>` : ""}</span>`;
}

export const initials = (name: string | null | undefined) =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";

// A square avatar slot at a multiple of 12 px. Today it holds the person's
// initials; the chosen avatars replace them later without moving anything.
// Without a size, the page's stylesheet sets one per screen width.
export const avatarSlot = (name: string | null | undefined, size?: number) =>
  html`<span class="avatar-slot"${size ? html` style="--avatar-size:${size}px"` : ""} aria-hidden="true"><span class="avatar-initials">${initials(name)}</span></span>`;

export const searchIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`;
