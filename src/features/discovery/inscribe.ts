// Roman inscriptional style for text set in Dydema Capitals: every "u" is
// shown as "v" (YOVR, TVRN). Pass lowercase text and set it in capitals with
// `text-transform: uppercase`. Only visible, aria-hidden text changes; screen
// readers get the real spelling. Browser-safe: the debate page's scripts use
// it too.
export const inscribe = (word: string) => word.replace(/u/g, "v");
