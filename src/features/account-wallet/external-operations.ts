import { createHash } from "node:crypto";

export const coinAsset = Object.freeze({
  id: "USDC",
  precision: 6,
  atomicPerYapCoin: 10_000n,
});

export type CoinEnvironment = "sandbox" | "live";
export type ExternalOperationKind = "funding" | "withdrawal" | "refund";
export type ExternalOperationStatus =
  "pending" | "completed" | "failed" | "uncertain";

export interface ExternalOperationTerms {
  environment: CoinEnvironment;
  accountId: string;
  kind: ExternalOperationKind;
  provider: string;
  network: string;
  asset: "USDC";
  precision: 6;
  amount: string;
  networkFee: string;
  destination: string;
  quoteId: string;
}

/**
 * A refusal the API returns as `{ error, code?, ...details }`. The code lets
 * browsers show their own words instead of the server's text; details carry
 * safe extra fields, such as the caller's own available balance.
 */
export class CoinOperationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code?: string,
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}

export function atomicAmount(value: string, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,35})$/.test(value))
    throw new CoinOperationError("invalid atomic amount", 400);
  const amount = BigInt(value);
  if (!allowZero && amount === 0n)
    throw new CoinOperationError("amount must be positive", 400);
  return amount;
}

export function operationTermsDigest(terms: ExternalOperationTerms): string {
  if (
    !["sandbox", "live"].includes(terms.environment) ||
    typeof terms.accountId !== "string" ||
    !/^[1-9][0-9]*$/.test(terms.accountId) ||
    !["funding", "withdrawal", "refund"].includes(terms.kind) ||
    terms.asset !== coinAsset.id ||
    terms.precision !== coinAsset.precision ||
    typeof terms.provider !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,79}$/.test(terms.provider) ||
    typeof terms.network !== "string" ||
    !/^[a-z][a-z0-9_.:-]{0,79}$/.test(terms.network) ||
    typeof terms.destination !== "string" ||
    !terms.destination ||
    terms.destination.length > 512 ||
    typeof terms.quoteId !== "string" ||
    !terms.quoteId ||
    terms.quoteId.length > 200
  )
    throw new CoinOperationError("invalid external operation terms", 400);
  atomicAmount(terms.amount);
  atomicAmount(terms.networkFee, true);
  // Explicit ordered tuples exclude prototype properties and future accidental
  // additions from an authorization/idempotency binding.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "yaparena.external-operation.v1",
        terms.environment,
        terms.accountId,
        terms.kind,
        terms.provider,
        terms.network,
        terms.asset,
        terms.precision,
        terms.amount,
        terms.networkFee,
        terms.destination,
        terms.quoteId,
      ]),
    )
    .digest("hex");
}

export interface ExternalObservation {
  id: string;
  externalId: string;
  termsDigest: string;
  source: "submission" | "webhook" | "reconciliation";
  status: ExternalOperationStatus;
  // A failed request or provider status named "failed" is not this proof.
  // Adapters may set this only after an authoritative original-operation lookup
  // proves the operation cannot subsequently transfer value.
  finalNoTransfer: boolean;
  transactionId: string | null;
}

export interface ExternalOperationState {
  termsDigest: string;
  externalId: string | null;
  status: ExternalOperationStatus;
  transactionId: string | null;
}

export interface ExternalTransition {
  state: ExternalOperationState;
  // The caller must apply this once, under the operation lock, in the same
  // transaction as the event insert and append-only balanced journal.
  disposition: "retain" | "settle" | "release";
}

export function observeExternalOperation(
  previous: ExternalOperationState,
  event: ExternalObservation,
): ExternalTransition {
  if (
    typeof event.id !== "string" ||
    !event.id ||
    event.id.length > 200 ||
    typeof event.externalId !== "string" ||
    !event.externalId ||
    event.externalId.length > 200 ||
    !/^[a-f0-9]{64}$/.test(previous.termsDigest) ||
    previous.termsDigest !== event.termsDigest ||
    (previous.externalId !== null &&
      previous.externalId !== event.externalId) ||
    !["submission", "webhook", "reconciliation"].includes(event.source) ||
    !["pending", "completed", "failed", "uncertain"].includes(event.status) ||
    typeof event.finalNoTransfer !== "boolean" ||
    (event.transactionId !== null &&
      (typeof event.transactionId !== "string" ||
        !event.transactionId ||
        event.transactionId.length > 200))
  )
    throw new CoinOperationError("conflicting external observation");

  const known = { ...previous, externalId: event.externalId };
  if (previous.status === "completed") {
    if (
      event.status === "failed" ||
      (event.status === "completed" &&
        event.transactionId !== previous.transactionId)
    )
      throw new CoinOperationError(
        "completed operation needs manual reconciliation",
      );
    return { state: known, disposition: "retain" };
  }
  if (previous.status === "failed") {
    if (event.status === "completed")
      throw new CoinOperationError(
        "released operation needs manual reconciliation",
      );
    return { state: known, disposition: "retain" };
  }
  if (event.status === "completed") {
    if (event.source !== "reconciliation" || !event.transactionId)
      throw new CoinOperationError(
        "completion requires reconciled transfer evidence",
      );
    return {
      state: {
        ...known,
        status: "completed",
        transactionId: event.transactionId,
      },
      disposition: "settle",
    };
  }
  if (event.status === "failed") {
    if (event.source === "reconciliation" && event.finalNoTransfer === true)
      return {
        state: { ...known, status: "failed", transactionId: null },
        disposition: "release",
      };
    return {
      state: { ...known, status: "uncertain" },
      disposition: "retain",
    };
  }
  return {
    state: {
      ...known,
      // Delayed pending webhooks cannot erase a submission timeout/uncertainty.
      status:
        previous.status === "uncertain" || event.status === "uncertain"
          ? "uncertain"
          : "pending",
    },
    disposition: "retain",
  };
}
