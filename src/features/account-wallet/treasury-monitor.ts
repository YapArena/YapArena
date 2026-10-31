// The two operating treasuries that back every Yap Coins stake (founder D1):
// `center_available` reserves each contract's face value, and
// `promotional_available` the same again for a grant-funded stake. Both are
// valueless simulation fixtures the operator seeds and tops up
// (docs/coin-sandbox-operations.md). When either runs low, answers pause
// with a clear refusal; this monitor warns before that happens.

/** Available USDC-equivalent atomic units of each treasury. */
export interface TreasuryBalances {
  centerAvailable: string;
  promotionalAvailable: string;
}

const atomsPerUsdc = 1_000_000n;

/** Each treasury's available whole USDC-equivalent, and whether it is low. */
export function treasuryStatus(
  balances: TreasuryBalances,
  thresholdUsdc: number,
) {
  const threshold = BigInt(thresholdUsdc) * atomsPerUsdc;
  return (
    [
      ["center", balances.centerAvailable],
      ["promotional", balances.promotionalAvailable],
    ] as const
  ).map(([account, atoms]) => ({
    account,
    availableUsdc: Number(BigInt(atoms) / atomsPerUsdc),
    low: BigInt(atoms) < threshold,
  }));
}

/**
 * The worker's check: one warning per low treasury per run, which the
 * uptime alerts can match on its message.
 */
export function createTreasuryMonitor(options: {
  read(): Promise<TreasuryBalances>;
  thresholdUsdc: number;
  logger: { warn(details: object, message: string): void };
}) {
  return Object.freeze({
    async check() {
      const status = treasuryStatus(
        await options.read(),
        options.thresholdUsdc,
      );
      for (const entry of status)
        if (entry.low)
          options.logger.warn(
            {
              account: entry.account,
              availableUsdc: entry.availableUsdc,
              thresholdUsdc: options.thresholdUsdc,
            },
            "coin treasury low",
          );
      return status;
    },
  });
}
