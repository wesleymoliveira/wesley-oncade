// A double-entry ledger of what is owed. This service never holds money: the
// ledger says who the BPO owes, from the moment the client pays until each
// person is paid.
//
// An entry is a signed number of cents: debit positive, credit negative.
// The entries of one transaction always sum to zero.

import type { FundingSource } from './run.ts';

export interface Entry {
  /** Unique per business event, so the same event can never post twice. */
  txId: string;
  account: string;
  amountCents: number;
}

export const account = {
  cash: (source: FundingSource) => `cash:${source}`,
  payable: (payeeId: string) => `payable:${payeeId}`,
  fees: (runId: string) => `fees:${runId}`,
  margin: (runId: string) => `margin:${runId}`,
  refundDue: (runId: string) => `refund_due:${runId}`,
};

/** Throws unless the entries are whole cents and sum to zero. */
export function assertBalanced(entries: readonly Entry[]): void {
  if (entries.length === 0) throw new Error('a ledger transaction needs entries');
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents)) throw new Error(`not whole cents in ${entry.account}`);
    total += entry.amountCents;
  }
  if (total !== 0) throw new Error(`ledger transaction ${entries[0]?.txId} does not sum to zero: ${total}`);
}

function balanced(entries: Entry[]): Entry[] {
  const kept = entries.filter((entry) => entry.amountCents !== 0);
  assertBalanced(kept);
  return kept;
}

/**
 * The client's money arrived: cash goes up, and we now owe each person their
 * pay, plus a reserve for Oncade's fees and the margin the BPO keeps.
 */
export function fundingEntries(input: {
  runId: string;
  source: FundingSource;
  receivedCents: number;
  people: readonly { id: string; amountCents: number }[];
  feeReserveCents: number;
  marginCents: number;
}): Entry[] {
  const txId = `funding:${input.runId}`;
  return balanced([
    { txId, account: account.cash(input.source), amountCents: input.receivedCents },
    ...input.people.map((p) => ({ txId, account: account.payable(p.id), amountCents: -p.amountCents })),
    { txId, account: account.fees(input.runId), amountCents: -input.feeReserveCents },
    { txId, account: account.margin(input.runId), amountCents: -input.marginCents },
  ]);
}

/** People in a batch were paid: we owe them nothing more, and the cash left. */
export function payoutEntries(input: {
  runId: string;
  batchId: string;
  source: FundingSource;
  paid: readonly { id: string; amountCents: number }[];
  feeCents: number;
}): Entry[] {
  const txId = `payout:${input.batchId}`;
  const out = input.paid.reduce((total, p) => total + p.amountCents, 0) + input.feeCents;
  return balanced([
    ...input.paid.map((p) => ({ txId, account: account.payable(p.id), amountCents: p.amountCents })),
    { txId, account: account.fees(input.runId), amountCents: input.feeCents },
    { txId, account: account.cash(input.source), amountCents: -out },
  ]);
}

/**
 * A funded run was cancelled and the provider confirmed it. `open` holds the
 * current balance of each account of the run (payables, fees, margin).
 *  - Money really received is now owed back to the client.
 *  - Simulated funding was never money: the simulation is simply undone, and
 *    nothing is owed to anyone.
 */
export function cancelEntries(runId: string, source: FundingSource, open: Readonly<Record<string, number>>): Entry[] {
  const txId = `cancel:${runId}`;
  const reversals = Object.entries(open).map(([name, balance]) => ({ txId, account: name, amountCents: -balance }));
  const released = reversals.reduce((total, entry) => total + entry.amountCents, 0);
  const against = source === 'provider' ? account.refundDue(runId) : account.cash('simulated');
  return balanced([...reversals, { txId, account: against, amountCents: -released }]);
}

/** Balances are a copy of the entries. This recomputes the copy from scratch. */
export function balancesOf(entries: readonly Entry[]): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const entry of entries) balances[entry.account] = (balances[entry.account] ?? 0) + entry.amountCents;
  return balances;
}

/** Accounts whose stored balance differs from what the entries say. Should be empty. */
export function balanceDrift(
  stored: Readonly<Record<string, number>>,
  entries: readonly Entry[],
): { account: string; stored: number; expected: number }[] {
  const expected = balancesOf(entries);
  const names = new Set([...Object.keys(stored), ...Object.keys(expected)]);
  return [...names]
    .map((name) => ({ account: name, stored: stored[name] ?? 0, expected: expected[name] ?? 0 }))
    .filter((row) => row.stored !== row.expected)
    .sort((a, b) => a.account.localeCompare(b.account));
}
