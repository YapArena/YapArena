// Forecast duels (rule "fd-v1"), Decision 0017.
// A pure, deterministic settlement for one window of sealed tickets: no seed, no
// price, no platform position, exactly zero-sum before rounding. A ticket's side
// carries no money; its whole stake rides on its read. Reads are settled by
// pairwise duels, each scored on the YES share among every ticket except the two
// duellists, so a ticket's own side never moves its own result.
import {
  A4Error,
  add,
  compare,
  decimal,
  floor,
  fraction,
  median,
  sub,
  type Fraction,
  type Order,
} from "../a4/engine.ts";

export const DUEL_RULE = "fd-v1";
export type DuelTerms = {
  rule: typeof DUEL_RULE;
  leverageMilli: number; // read leverage in thousandths; 12500 = 12.5
  minTickets: number; // below this, every stake is returned
  maxQuantity: number;
  capacity: number;
};
export const DUEL_TERMS: Readonly<DuelTerms> = Object.freeze({
  rule: DUEL_RULE,
  leverageMilli: 12_500,
  minTickets: 5,
  maxQuantity: 100,
  capacity: 1001,
});
export type DuelStatus = "settled" | "returned_small_room";

const ZERO = fraction(0);
const MICRO = 1_000_000n;

export function validateDuelTerms(terms: DuelTerms) {
  const whole = (value: number, low: number, high: number) =>
    Number.isInteger(value) && value >= low && value <= high;
  if (
    terms.rule !== DUEL_RULE ||
    !whole(terms.leverageMilli, 1000, 1_000_000) || // at least 1, so a duel's cap is at most the whole score range
    !whole(terms.minTickets, 3, 1001) || // a duel needs a third ticket to be scored on
    !whole(terms.maxQuantity, 1, 100) ||
    !whole(terms.capacity, 1, 1001)
  )
    throw new A4Error("unsupported duel terms", 400);
}

// Pairwise duels on the reads, in integers. Every score in a room shares the
// denominator ((n - 2) * 10^6)^2, so only numerators are compared.
function duels(
  yes: boolean[],
  readMicros: bigint[],
  weight: bigint[], // stake, in atomic units
  leverageMilli: number,
) {
  const n = yes.length;
  const others = BigInt(n - 2);
  const yesCount = BigInt(yes.filter(Boolean).length);
  const scale = (others * MICRO) ** 2n;
  const bound = 1000n * scale; // a duel's gap counts up to 1 / leverage
  const leverage = BigInt(leverageMilli);
  // score[i][b]: ticket i's score numerator in a duel with a partner whose side is b
  const score = readMicros.map((read, i) =>
    [0n, 1n].map((partner) => {
      const miss =
        (yesCount - (yes[i] ? 1n : 0n) - partner) * MICRO - read * others;
      return -(miss * miss);
    }),
  );
  const points = yes.map(() => 0n);
  const won = yes.map(() => 0),
    lost = yes.map(() => 0);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const gap = score[i]![yes[j] ? 1 : 0]! - score[j]![yes[i] ? 1 : 0]!;
      if (gap === 0n) continue;
      const [winner, loser] = gap > 0n ? [i, j] : [j, i];
      won[winner]!++;
      lost[loser]!++;
      let counted = leverage * (gap > 0n ? gap : -gap);
      if (counted > bound) counted = bound;
      points[winner]! += weight[loser]! * counted;
      points[loser]! -= weight[winner]! * counted;
    }
  const total = weight.reduce((a, b) => a + b, 0n);
  return {
    // result[i] = leverage * w_i * sum_j (w_j / W) * capped gap, in atomic units
    result: points.map((p, i) => fraction(weight[i]! * p, total * bound)),
    won,
    lost,
  };
}

export function settleWindow(orders: Order[], terms: DuelTerms, face: bigint) {
  validateDuelTerms(terms);
  if (
    face <= 0n ||
    orders.length > terms.capacity ||
    new Set(orders.map((o) => o.participant)).size !== orders.length
  )
    throw new A4Error("invalid locked population", 400);
  for (const order of orders) {
    if (
      !order.participant ||
      !["YES", "NO"].includes(order.side) ||
      !Number.isInteger(order.quantity) ||
      order.quantity < 1 ||
      order.quantity > terms.maxQuantity
    )
      throw new A4Error("invalid submission", 400);
    decimal(order.limit);
  }
  const n = orders.length;
  const stakes = orders.map((o) => BigInt(o.quantity) * face);
  const total = stakes.reduce((a, b) => a + b, 0n);
  const reads = orders.map((o) => decimal(o.limit)); // the read, on the YES scale
  const yes = orders.map((o) => o.side === "YES");
  const yesCount = yes.filter(Boolean).length;
  const share = n ? fraction(yesCount, n) : null;
  const crowd = median(reads);
  const summary = {
    rule: DUEL_RULE,
    tickets: n,
    share, // YES share of the answers
    crowd, // median read: what the room forecast that share to be
    // Whether the room came out more YES than it forecast; never a winner.
    verdict:
      share && crowd
        ? (["NO", "EVEN", "YES"] as const)[compare(share, crowd) + 1]!
        : null,
  };
  const row = (
    i: number,
    status: DuelStatus,
    read: Fraction = ZERO,
    won = 0,
    lost = 0,
  ) => {
    const payoutExact = add(fraction(stakes[i]!), read);
    if (compare(payoutExact, ZERO) < 0)
      throw new A4Error("loss exceeds stake", 500);
    const payout = floor(payoutExact);
    return {
      participant: orders[i]!.participant,
      status,
      stake: String(stakes[i]!),
      payout: String(payout),
      net: String(payout - stakes[i]!),
      payoutDust: sub(payoutExact, fraction(payout)),
      readExact: read,
      duelsWon: won,
      duelsLost: lost,
      othersShare: n > 1 ? fraction(yesCount - (yes[i] ? 1 : 0), n - 1) : null,
    };
  };
  if (n < terms.minTickets)
    return {
      summary: { ...summary, status: "returned_small_room" as const },
      outcomes: orders.map((_, i) => row(i, "returned_small_room")),
      dust: "0",
    };

  const readMicros = reads.map((r) => (BigInt(r.n) * MICRO) / BigInt(r.d));
  const duel = duels(yes, readMicros, stakes, terms.leverageMilli);
  const outcomes = orders.map((_, i) =>
    row(i, "settled", duel.result[i]!, duel.won[i]!, duel.lost[i]!),
  );
  const paid = outcomes.reduce((a, o) => a + BigInt(o.payout), 0n);
  if (paid > total || total - paid >= BigInt(n))
    throw new A4Error("window does not balance", 500);
  return {
    summary: { ...summary, status: "settled" as const },
    outcomes,
    dust: String(total - paid), // fewer atomic units than tickets; owed to the system account
  };
}
export type WindowSettlement = ReturnType<typeof settleWindow>;
