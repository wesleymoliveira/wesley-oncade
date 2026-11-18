// Reconciliation: compare what we believe with what the provider says, name
// the difference, and say who repairs it. Only differences that are safe and
// unambiguous repair themselves. Anything about an amount goes to a person.

import type { BatchStatus, RunStatus } from './run.ts';

export type DifferenceKind =
  | 'funding_missed'
  | 'completion_missed'
  | 'cancelled_at_provider'
  | 'missing_at_provider'
  | 'amount_mismatch'
  | 'partial_payout';

export interface Difference {
  kind: DifferenceKind;
  repair: 'auto' | 'manual';
}

const auto = (kind: DifferenceKind): Difference => ({ kind, repair: 'auto' });
const manual = (kind: DifferenceKind): Difference => ({ kind, repair: 'manual' });

/** Our run is waiting for money. What does the provider's invoice say? */
export function compareFunding(
  local: { status: RunStatus; invoiceCents: number },
  remote: { status: string; totalCents: number } | null,
): Difference | null {
  if (local.status !== 'awaiting_funds') return null;
  if (remote === null) return manual('missing_at_provider');
  if (remote.status === 'cancelled') return auto('cancelled_at_provider');
  if (remote.status !== 'paid') return null;
  return remote.totalCents === local.invoiceCents ? auto('funding_missed') : manual('amount_mismatch');
}

export interface LocalPerson {
  id: string;
  email: string;
  amountCents: number;
}

export interface RemoteLine {
  email: string;
  amountCents: number;
  status: string;
}

export interface BatchVerdict {
  difference: Difference | null;
  /** People the provider says were paid. */
  paid: string[];
  /** People who are certainly not paid by this batch and may go in a new one. */
  released: string[];
}

const nothing: BatchVerdict = { difference: null, paid: [], released: [] };
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Our batch was sent. What does the provider's distribution say, person by
 * person? A person is released for a new batch only when the provider
 * confirmed that this one will never pay them.
 */
export function compareBatch(
  local: { status: BatchStatus; people: readonly LocalPerson[] },
  remote: { status: string; lines: readonly RemoteLine[] } | null,
): BatchVerdict {
  if (local.status !== 'sent') return nothing;
  if (remote === null) return { ...nothing, difference: manual('missing_at_provider') };

  const matches = local.people.map((person) => ({
    person,
    line: remote.lines.find((line) => sameEmail(line.email, person.email)),
  }));
  const sameShape =
    remote.lines.length === local.people.length &&
    matches.every(({ person, line }) => line !== undefined && line.amountCents === person.amountCents);
  if (!sameShape) return { ...nothing, difference: manual('amount_mismatch') };

  const paid = matches.filter(({ line }) => line?.status === 'sent').map(({ person }) => person.id);
  if (remote.status === 'cancelled') {
    // Cancelled, yet a line shows as paid: these people cannot be called free. A person decides.
    if (paid.length > 0) return { difference: manual('partial_payout'), paid, released: [] };
    return { difference: auto('cancelled_at_provider'), paid: [], released: local.people.map((p) => p.id) };
  }
  if (remote.status !== 'completed') return nothing;

  if (paid.length === local.people.length) return { difference: auto('completion_missed'), paid, released: [] };
  // Completed, but not everyone shows as paid. We cannot tell "will be paid
  // later" from "never": nobody is released, a person decides.
  return { difference: manual('partial_payout'), paid, released: [] };
}
