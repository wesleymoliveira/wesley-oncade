// Money is an integer number of cents. Dollars appear only in `toDollars` and `fromDollars`, for the provider,
// and in `formatUsd`, for a person.

export type Cents = number;

/** Checks that a value is a whole, non-negative number of cents. */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`not a whole, non-negative number of cents: ${value}`);
  }
  return value;
}

export function sum(values: readonly Cents[]): Cents {
  return cents(values.reduce((total, value) => total + cents(value), 0));
}

/** Dollars for the API edge only. 1234 → 12.34 */
export function toDollars(value: Cents): number {
  return Number((cents(value) / 100).toFixed(2));
}

/** Dollars from the API edge. Refuses a value with a fraction of a cent. */
export function fromDollars(dollars: number): Cents {
  const value = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || Math.abs(dollars * 100 - value) > 1e-6) {
    throw new RangeError(`not a whole number of cents: ${dollars} dollars`);
  }
  return cents(value);
}

/** 123456 → "1,234.56" */
export function formatUsd(value: Cents): string {
  const whole = Math.trunc(cents(value) / 100).toLocaleString('en-US');
  return `${whole}.${String(value % 100).padStart(2, '0')}`;
}

export type FeeType = 'flat_rate_plus_percentage' | 'per_payout_plus_percentage';

export interface FeeRule {
  label: string;
  /** 0 to 100, with up to four decimals. */
  percentage: number;
  flatCents: Cents;
  feeType: FeeType;
}

/**
 * The fee one rule adds to a distribution. The percentage part is rounded up:
 * this number is a reserve, and a reserve must never come out short.
 * BigInt keeps the multiplication exact for any amount.
 */
export function feeCents(rule: FeeRule, totalCents: Cents, recipients: number): Cents {
  const scaled = BigInt(Math.round(rule.percentage * 10_000)); // 2.5% → 25000
  const percentPart = Number((BigInt(cents(totalCents)) * scaled + 999_999n) / 1_000_000n);
  const flatPart = rule.feeType === 'per_payout_plus_percentage' ? rule.flatCents * recipients : rule.flatCents;
  return cents(flatPart + percentPart);
}

export function estimateFees(rules: readonly FeeRule[], totalCents: Cents, recipients: number): Cents {
  return sum(rules.map((rule) => feeCents(rule, totalCents, recipients)));
}
