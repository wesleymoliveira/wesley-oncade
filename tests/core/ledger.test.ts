import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunk } from '../../lib/core/batches.ts';
import {
  account,
  assertBalanced,
  balanceDrift,
  balancesOf,
  cancelEntries,
  fundingEntries,
  payoutEntries,
  type Entry,
} from '../../lib/core/ledger.ts';

const people = [
  { id: 'R/p001', amountCents: 60_00 },
  { id: 'R/p002', amountCents: 25_00 },
  { id: 'R/p003', amountCents: 15_00 },
];
const funding = () =>
  fundingEntries({
    runId: 'R',
    source: 'provider',
    receivedCents: 115_00,
    people,
    feeReserveCents: 5_00,
    marginCents: 10_00,
  });

describe('ledger transactions', () => {
  it('funding: cash goes up and we owe each person, the fee reserve and the margin', () => {
    const balances = balancesOf(funding());
    expect(balances[account.cash('provider')]).toBe(115_00);
    expect(balances[account.payable('R/p001')]).toBe(-60_00);
    expect(balances[account.fees('R')]).toBe(-5_00);
    expect(balances[account.margin('R')]).toBe(-10_00);
  });

  it('refuses funding that does not cover payroll, fees and margin exactly', () => {
    expect(() =>
      fundingEntries({
        runId: 'R',
        source: 'provider',
        receivedCents: 100_00,
        people,
        feeReserveCents: 5_00,
        marginCents: 10_00,
      }),
    ).toThrow(/does not sum to zero/);
  });

  it('keeps simulated funding in its own cash account', () => {
    const entries = fundingEntries({
      runId: 'R',
      source: 'simulated',
      receivedCents: 100_00,
      people,
      feeReserveCents: 0,
      marginCents: 0,
    });
    expect(balancesOf(entries)[account.cash('simulated')]).toBe(100_00);
    expect(balancesOf(entries)[account.cash('provider')]).toBeUndefined();
    expect(entries.some((entry) => entry.amountCents === 0)).toBe(false);
  });

  it('payout: the people paid are owed nothing, and cash leaves with the fee', () => {
    const entries = [
      ...funding(),
      ...payoutEntries({
        runId: 'R',
        batchId: 'R/a1/b01',
        source: 'provider',
        paid: people.slice(0, 2),
        feeCents: 3_00,
      }),
    ];
    const balances = balancesOf(entries);
    expect(balances[account.payable('R/p001')]).toBe(0);
    expect(balances[account.payable('R/p003')]).toBe(-15_00);
    expect(balances[account.fees('R')]).toBe(-2_00);
    expect(balances[account.cash('provider')]).toBe(115_00 - 85_00 - 3_00);
  });

  it('cancel: money really received is owed back to the client', () => {
    const open = { [account.payable('R/p001')]: -60_00, [account.fees('R')]: -5_00, [account.margin('R')]: -10_00 };
    const balances = balancesOf(cancelEntries('R', 'provider', open));
    expect(balances[account.payable('R/p001')]).toBe(60_00);
    expect(balances[account.refundDue('R')]).toBe(-75_00);
  });

  it('cancel: simulated funding is undone, and nothing is owed to anyone', () => {
    const entries = fundingEntries({
      runId: 'R',
      source: 'simulated',
      receivedCents: 100_00,
      people,
      feeReserveCents: 0,
      marginCents: 0,
    });
    const open = Object.fromEntries(
      Object.entries(balancesOf(entries)).filter(([name]) => name.startsWith('payable:')),
    );
    const after = balancesOf([...entries, ...cancelEntries('R', 'simulated', open)]);
    expect(after[account.cash('simulated')]).toBe(0);
    expect(after[account.refundDue('R')]).toBeUndefined();
    expect(Object.values(after).every((cents) => cents === 0)).toBe(true);
  });

  it('every transaction sums to zero, for any payroll, and paying everyone leaves nothing owed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50_000_00 }), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 1_000_00 }),
        (amounts, feePerBatch, margin) => {
          const staff = amounts.map((amountCents, i) => ({ id: `R/p${i}`, amountCents }));
          const batches = chunk(staff);
          const payroll = amounts.reduce((a, b) => a + b, 0);
          const reserve = feePerBatch * batches.length;
          const all: Entry[] = fundingEntries({
            runId: 'R',
            source: 'provider',
            receivedCents: payroll + reserve + margin,
            people: staff,
            feeReserveCents: reserve,
            marginCents: margin,
          });
          batches.forEach((paid, i) => {
            const tx = payoutEntries({
              runId: 'R',
              batchId: `R/a1/b${i}`,
              source: 'provider',
              paid,
              feeCents: feePerBatch,
            });
            assertBalanced(tx);
            all.push(...tx);
          });
          const balances = balancesOf(all);
          expect(staff.every((p) => balances[account.payable(p.id)] === 0)).toBe(true);
          expect(balances[account.fees('R')] ?? 0).toBe(0);
          expect(balances[account.cash('provider')]).toBe(margin); // only the margin is left
          expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(0);
        },
      ),
    );
  });
});

describe('assertBalanced', () => {
  it('refuses an empty transaction, a fraction of a cent and a sum that is not zero', () => {
    expect(() => assertBalanced([])).toThrow(/needs entries/);
    expect(() => assertBalanced([{ txId: 't', account: 'a', amountCents: 0.5 }])).toThrow(/not whole cents/);
    expect(() => assertBalanced([{ txId: 't', account: 'a', amountCents: 1 }])).toThrow(/does not sum to zero/);
  });
});

describe('balances are a copy', () => {
  it('reports no drift when the stored balances match the entries', () => {
    expect(balanceDrift(balancesOf(funding()), funding())).toEqual([]);
  });

  it('reports each account whose stored balance is wrong or missing', () => {
    const stored = { ...balancesOf(funding()), [account.cash('provider')]: 1, 'ghost:account': 7 };
    delete stored[account.fees('R')];
    expect(balanceDrift(stored, funding())).toEqual([
      { account: 'cash:provider', stored: 1, expected: 115_00 },
      { account: 'fees:R', stored: 0, expected: -5_00 },
      { account: 'ghost:account', stored: 7, expected: 0 },
    ]);
  });
});
