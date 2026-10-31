// Random, clearly different colors for the landing headline's rotating words
// (docs/landing-page.md). Pure: the random source is injected for tests.

export const COLORED_WORDS = [
  "opinions",
  "debates",
  "ideas",
  "discussions",
  "yappers",
] as const;
export type ColoredWord = (typeof COLORED_WORDS)[number];
export type Rgb = readonly [number, number, number];

export interface HeadlineColor {
  css: string;
  rgb: Rgb;
  lightness: number;
  chroma: number;
  hue: number;
}

// Five hues 72° apart, each moved by up to ±13.5°: any two stay at least 45°
// apart, wider than one color family, so lavender rules out every purple.
const HUE_STEP = 72;
const HUE_JITTER = 13.5;
export const MIN_HUE_DISTANCE = 45;
export const MIN_CONTRAST = 4.5;
// Light blues, purples and reds lose almost all chroma in sRGB, so fitting
// darkens a color down to this floor before it gives up any chroma.
const LIGHTNESS_FLOOR = 0.7;

const wrap = (hue: number) => ((hue % 360) + 360) % 360;
const step = (value: number) => Math.round((value - 0.005) * 1000) / 1000;

// OKLCH → OKLab → linear sRGB (Björn Ottosson's matrices).
export function oklchToLinearRgb(
  lightness: number,
  chroma: number,
  hue: number,
): [number, number, number] {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function inGamut(linear: readonly number[]) {
  return linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

// Linear sRGB → 8-bit sRGB.
export function toRgb8(linear: readonly number[]): Rgb {
  const [r, g, b] = linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded =
      clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });
  return [r!, g!, b!];
}

// WCAG relative luminance and contrast against the page's black background.
export function contrastWithBlack(rgb: Rgb) {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05) / 0.05;
}

export function hueDistance(a: number, b: number) {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

// Bring a color inside sRGB: darken first, then give up chroma.
export function fitToGamut(lightness: number, chroma: number, hue: number) {
  while (
    lightness > LIGHTNESS_FLOOR &&
    !inGamut(oklchToLinearRgb(lightness, chroma, hue))
  )
    lightness = step(lightness);
  while (chroma > 0 && !inGamut(oklchToLinearRgb(lightness, chroma, hue)))
    chroma = step(chroma);
  return { lightness, chroma };
}

function drawColor(random: () => number, hue: number): HeadlineColor {
  // Yellows look olive unless they are lighter than the other hues.
  const yellow = hue >= 80 && hue <= 130;
  const { lightness, chroma } = fitToGamut(
    yellow ? 0.86 + random() * 0.06 : 0.74 + random() * 0.12,
    0.12 + random() * 0.04,
    hue,
  );
  const rgb = toRgb8(oklchToLinearRgb(lightness, chroma, hue));
  return {
    css: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`,
    rgb,
    lightness,
    chroma,
    hue,
  };
}

function readableAndDistinct(colors: HeadlineColor[]) {
  return colors.every(
    (color, index) =>
      contrastWithBlack(color.rgb) >= MIN_CONTRAST &&
      colors
        .slice(index + 1)
        .every(
          (other) => hueDistance(color.hue, other.hue) >= MIN_HUE_DISTANCE,
        ),
  );
}

// A new set for each visit: five hues around the wheel from a random start,
// then a random word for each color.
export function pickHeadlineColors(
  random: () => number = Math.random,
): Record<ColoredWord, HeadlineColor> {
  let colors: HeadlineColor[];
  do {
    const start = random() * 360;
    colors = COLORED_WORDS.map((_, index) =>
      drawColor(
        random,
        wrap(start + index * HUE_STEP + (random() * 2 - 1) * HUE_JITTER),
      ),
    );
  } while (!readableAndDistinct(colors));
  for (let index = colors.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [colors[index], colors[other]] = [colors[other]!, colors[index]!];
  }
  const [opinions, debates, ideas, discussions, yappers] = colors;
  return {
    opinions: opinions!,
    debates: debates!,
    ideas: ideas!,
    discussions: discussions!,
    yappers: yappers!,
  };
}
