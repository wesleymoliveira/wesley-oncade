import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cents,
  estimateFees,
  feeCents,
  formatUsd,
  fromDollars,
  sum,
  toDollars,
  type FeeRule,
} from '../../lib/core/money.ts';

describe('cents', () => {
  it('accepts whole, non-negative numbers', () => {
    expect(cents(0)).toBe(0);
    expect(cents(1999)).toBe(1999);
  });

  it.each([0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses %s', (value) => {
    expect(() => cents(value)).toThrow(RangeError);
  });

  it('sums a list', () => {
    expect(sum([100, 250, 1])).toBe(351);
    expect(sum([])).toBe(0);
  });
});

describe('dollars exist only at the edge', () => {
  it('goes to dollars and back without losing a cent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_00 }), (value) => {
        expect(fromDollars(toDollars(value))).toBe(value);
      }),
    );
  });

  it('refuses a fraction of a cent', () => {
    expect(() => fromDollars(0.001)).toThrow(RangeError);
    expect(() => fromDollars(Number.NaN)).toThrow(RangeError);
  });

  it('formats for people', () => {
    expect(formatUsd(123456)).toBe('1,234.56');
    expect(formatUsd(5)).toBe('0.05');
  });
});

describe('fees', () => {
  const flat: FeeRule = { label: 'Service', percentage: 5, flatCents: 30, feeType: 'flat_rate_plus_percentage' };
  const perPayout: FeeRule = { ...flat, feeType: 'per_payout_plus_percentage' };

  it('flat rate plus percentage charges the flat part once', () => {
    expect(feeCents(flat, 100_00, 20)).toBe(30 + 5_00);
  });

  it('per payout plus percentage charges the flat part per person', () => {
    expect(feeCents(perPayout, 100_00, 20)).toBe(30 * 20 + 5_00);
  });

  it('rounds the percentage up, so a reserve is never short', () => {
    const rule: FeeRule = { label: 'x', percentage: 2.9, flatCents: 0, feeType: 'flat_rate_plus_percentage' };
    expect(feeCents(rule, 1_01, 1)).toBe(3); // 2.929 cents
    expect(feeCents(rule, 1_000_00, 1)).toBe(29_00); // exact: no float drift
  });

  it('is never below the exact fee and never a full cent above it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_00 }), fc.integer({ min: 0, max: 100_0000 }), (total, scaled) => {
        const rule: FeeRule = {
          label: 'x',
          percentage: scaled / 10_000,
          flatCents: 0,
          feeType: 'flat_rate_plus_percentage',
        };
        const exactTimesMillion = BigInt(total) * BigInt(scaled);
        const fee = BigInt(feeCents(rule, total, 1)) * 1_000_000n;
        expect(fee >= exactTimesMillion && fee < exactTimesMillion + 1_000_000n).toBe(true);
      }),
    );
  });

  it('adds every rule', () => {
    expect(estimateFees([flat, perPayout], 100_00, 2)).toBe(30 + 5_00 + 60 + 5_00);
    expect(estimateFees([], 100_00, 2)).toBe(0);
  });
});
