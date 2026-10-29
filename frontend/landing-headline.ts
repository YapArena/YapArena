// The landing page's rotating headline (docs/landing-page.md): "Y", then a
// slot for "our"/"appers", then a slot for the noun, over a fixed "matter".
// Pure step logic, kept apart from the DOM so Node tests can import it.

export const HEADLINE_PHRASES = [
  "Your opinions matter",
  "Your debates matter",
  "Your ideas matter",
  "Your discussions matter",
  "Yappers matter",
] as const;

// Each slot's track ends with a copy of its first item, so the step from
// "Yappers" back to "Your opinions" also moves up instead of scrolling back.
export const PRONOUN_TRACK = ["our", "appers", "our"] as const;
export const NOUN_TRACK = [
  "opinions",
  "debates",
  "ideas",
  "discussions",
  "",
  "opinions",
] as const;

export const FINAL_STEP = HEADLINE_PHRASES.length - 1;
// Timings from dydema.com's FlipWord: a step every 2.6s, each move 0.7s.
export const FLIP_EVERY_MS = 2600;
export const FLIP_MS = 700;
// The headline's second line finishes its page-load reveal at 0.08s + 1.05s.
export const REVEAL_END_MS = 1130;

export interface SlotPositions {
  pronoun: number;
  noun: number;
}

export interface HeadlineMove {
  to: number;
  positions: SlotPositions;
  moves: { pronoun: boolean; noun: boolean };
  // The slots land on their trailing copies and must then reset to the start.
  wraps: boolean;
}

// Where each slot's track rests while a step is shown.
export function restingPositions(step: number): SlotPositions {
  return step === FINAL_STEP
    ? { pronoun: 1, noun: 4 }
    : { pronoun: 0, noun: step };
}

export function phraseAt(step: number): string {
  const { pronoun, noun } = restingPositions(step);
  const word = NOUN_TRACK[noun];
  return `Y${PRONOUN_TRACK[pronoun]}${word ? ` ${word}` : ""} matter`;
}

// Steps 1→2, 2→3 and 3→4 move only the noun; 4→5 and 5→1 move both slots.
export function nextMove(from: number): HeadlineMove {
  if (from === FINAL_STEP)
    return {
      to: 0,
      positions: {
        pronoun: PRONOUN_TRACK.length - 1,
        noun: NOUN_TRACK.length - 1,
      },
      moves: { pronoun: true, noun: true },
      wraps: true,
    };
  const current = restingPositions(from);
  const positions = restingPositions(from + 1);
  return {
    to: from + 1,
    positions,
    moves: {
      pronoun: positions.pronoun !== current.pronoun,
      noun: positions.noun !== current.noun,
    },
    wraps: false,
  };
}

// The headline holds its step while the tab is hidden or Space paused it.
export function canAdvance(state: { hidden: boolean; paused: boolean }) {
  return !state.hidden && !state.paused;
}

// Reduced motion shows the final phrase and never flips.
export function initialStep(reducedMotion: boolean) {
  return reducedMotion ? FINAL_STEP : 0;
}
