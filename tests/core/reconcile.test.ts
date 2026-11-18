import { describe, expect, it } from 'vitest';
import { compareBatch, compareFunding } from '../../lib/core/reconcile.ts';

describe('is the money in? (our run against the provider invoice)', () => {
  const waiting = { status: 'awaiting_funds' as const, invoiceCents: 100_00 };

  it('has nothing to say unless the run is waiting for money', () => {
    expect(
      compareFunding({ status: 'funded', invoiceCents: 100_00 }, { status: 'paid', totalCents: 100_00 }),
    ).toBeNull();
  });

  it('records funding by itself when the invoice is paid for the amount billed', () => {
    expect(compareFunding(waiting, { status: 'paid', totalCents: 100_00 })).toEqual({
      kind: 'funding_missed',
      repair: 'auto',
    });
  });

  it('sends any other amount to a person', () => {
    expect(compareFunding(waiting, { status: 'paid', totalCents: 99_99 })).toEqual({
      kind: 'amount_mismatch',
      repair: 'manual',
    });
  });

  it('follows a cancel made at the provider', () => {
    expect(compareFunding(waiting, { status: 'cancelled', totalCents: 100_00 })).toEqual({
      kind: 'cancelled_at_provider',
      repair: 'auto',
    });
  });

  it('sends an invoice the provider does not have to a person', () => {
    expect(compareFunding(waiting, null)).toEqual({ kind: 'missing_at_provider', repair: 'manual' });
  });

  it('waits while the invoice is still open', () => {
    expect(compareFunding(waiting, { status: 'sent', totalCents: 100_00 })).toBeNull();
    expect(compareFunding(waiting, { status: 'processing', totalCents: 100_00 })).toBeNull();
  });
});

describe('was the batch paid? (our batch against the provider distribution, person by person)', () => {
  const people = [
    { id: 'p1', email: 'Ana@Example.com', amountCents: 60_00 },
    { id: 'p2', email: 'bia@example.com', amountCents: 40_00 },
  ];
  const sent = { status: 'sent' as const, people };
  const lines = (status1: string, status2: string) => [
    { email: 'ana@example.com ', amountCents: 60_00, status: status1 },
    { email: 'bia@example.com', amountCents: 40_00, status: status2 },
  ];

  it('has nothing to say unless the batch was sent', () => {
    expect(
      compareBatch({ status: 'pending', people }, { status: 'completed', lines: lines('sent', 'sent') }).difference,
    ).toBeNull();
  });

  it('confirms everyone when the distribution completed and every line is sent', () => {
    expect(compareBatch(sent, { status: 'completed', lines: lines('sent', 'sent') })).toEqual({
      difference: { kind: 'completion_missed', repair: 'auto' },
      paid: ['p1', 'p2'],
      released: [],
    });
  });

  it('releases nobody when a completed distribution did not pay everyone: a person decides', () => {
    expect(compareBatch(sent, { status: 'completed', lines: lines('sent', 'pending') })).toEqual({
      difference: { kind: 'partial_payout', repair: 'manual' },
      paid: ['p1'],
      released: [],
    });
  });

  it('releases everyone when the provider confirms the distribution was cancelled', () => {
    expect(compareBatch(sent, { status: 'cancelled', lines: lines('pending', 'pending') })).toEqual({
      difference: { kind: 'cancelled_at_provider', repair: 'auto' },
      paid: [],
      released: ['p1', 'p2'],
    });
  });

  it('releases nobody when a cancelled distribution shows a paid line: a person decides', () => {
    expect(compareBatch(sent, { status: 'cancelled', lines: lines('sent', 'pending') })).toEqual({
      difference: { kind: 'partial_payout', repair: 'manual' },
      paid: ['p1'],
      released: [],
    });
  });

  it('waits while the distribution is still open', () => {
    expect(compareBatch(sent, { status: 'pending', lines: lines('pending', 'pending') }).difference).toBeNull();
  });

  it('sends a distribution the provider does not have to a person', () => {
    expect(compareBatch(sent, null).difference).toEqual({ kind: 'missing_at_provider', repair: 'manual' });
  });

  it('sends a different amount, a different person or a different count to a person', () => {
    const manual = { kind: 'amount_mismatch', repair: 'manual' };
    const otherAmount = [{ ...lines('sent', 'sent')[0]!, amountCents: 1 }, lines('sent', 'sent')[1]!];
    const otherPerson = [{ ...lines('sent', 'sent')[0]!, email: 'x@example.com' }, lines('sent', 'sent')[1]!];
    expect(compareBatch(sent, { status: 'completed', lines: otherAmount }).difference).toEqual(manual);
    expect(compareBatch(sent, { status: 'completed', lines: otherPerson }).difference).toEqual(manual);
    expect(compareBatch(sent, { status: 'completed', lines: lines('sent', 'sent').slice(0, 1) }).difference).toEqual(
      manual,
    );
  });
});
