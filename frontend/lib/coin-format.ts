// The one Yap Coins formatter for every page: up to two decimals, thousands
// separators and the "−" minus sign. 10,000 atomic units are one Yap Coin,
// for cash and grant principal alike. Amounts are cut (never rounded up) to
// the hundredth, so a balance never shows more than it holds. No DOM access,
// so tests can import the built module.

const atomsPerHundredth = 100n;

function grouped(whole: bigint) {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
// "2,500", "0.54", "1,234.50": whole coins drop the decimals.
function magnitudeText(magnitude: bigint) {
  const hundredths = magnitude / atomsPerHundredth;
  const whole = hundredths / 100n,
    cents = hundredths % 100n;
  return cents
    ? `${grouped(whole)}.${String(cents).padStart(2, "0")}`
    : grouped(whole);
}
const parts = (atoms: string | bigint) => {
  const value = BigInt(atoms);
  const magnitude = value < 0n ? -value : value;
  return {
    value,
    magnitude,
    tiny: magnitude > 0n && magnitude < atomsPerHundredth,
  };
};

/** "2,500 YC", "0.54 YC", "−3 YC"; a nonzero amount under 0.01 YC says so. */
export function formatCoins(atoms: string | bigint) {
  const { value, magnitude, tiny } = parts(atoms);
  if (tiny) return "under 0.01 YC";
  return `${value < 0n ? "−" : ""}${magnitudeText(magnitude)} YC`;
}

/**
 * A result: "+3.40 YC", "−0.40 YC". A result that rounds to zero says so:
 * "no gain or loss", "a gain under 0.01 YC", "a loss under 0.01 YC".
 */
export function formatSignedCoins(atoms: string | bigint) {
  const { value, magnitude, tiny } = parts(atoms);
  if (!value) return "no gain or loss";
  if (tiny) return value > 0n ? "a gain under 0.01 YC" : "a loss under 0.01 YC";
  return `${value > 0n ? "+" : "−"}${magnitudeText(magnitude)} YC`;
}

/** Whole hundredths of a Yap Coin, such as a price per contract: "0.54 YC". */
export function formatHundredths(hundredths: number) {
  return formatCoins(BigInt(Math.round(hundredths)) * atomsPerHundredth);
}

/**
 * A price per contract always shows two decimals, "0.54 YC" or "1.00 YC",
 * so prices line up.
 */
export function formatPrice(hundredths: number) {
  const value = Math.max(0, Math.round(hundredths));
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")} YC`;
}
