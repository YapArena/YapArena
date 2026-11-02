// The visit's five landing colours (docs/site-design.md): one random set per
// page load, shared by the header, the debate page and anything else that
// paints with them. They are written to the root element as --visit-0 …
// --visit-4 (in COLORED_WORDS order) and --visit-yappers; public/site.css
// holds fixed fallbacks for pages without JavaScript. Some page scripts are
// bundled with their own copy of this module, so the set lives on window:
// every copy on a page returns the same colours.
import {
  COLORED_WORDS,
  pickHeadlineColors,
  type ColoredWord,
  type HeadlineColor,
} from "../landing-colors.js";

declare global {
  interface Window {
    yapVisitColors?: Record<ColoredWord, HeadlineColor>;
  }
}

/** The visit's colours, picked once per page and written to the root. */
export function visitColors(random: () => number = Math.random) {
  let colors = window.yapVisitColors;
  if (!colors) {
    colors = pickHeadlineColors(random);
    window.yapVisitColors = colors;
    const root = document.documentElement;
    COLORED_WORDS.forEach((word, index) =>
      root.style.setProperty(`--visit-${index}`, colors![word].css),
    );
    root.style.setProperty("--visit-yappers", colors.yappers.css);
  }
  return colors;
}
