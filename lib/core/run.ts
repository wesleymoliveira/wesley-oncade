// The three state machines of a payout run, and the rules that decide when
// money may move. Every state change in the project goes through `canMove`.

/** The format of a run reference. It is part of batch ids, payee ids and ledger account names. */
export const REFERENCE = /^[A-Za-z0-9._-]{3,40}$/;

export type RunStatus =
  | 'created'
  | 'awaiting_funds'
  | 'funded'
  | 'processing'
  | 'partially_failed'
  | 'completed'
  | 'cancelling'
  | 'cancelled';

export type BatchStatus = 'pending' | 'sending' | 'sent' | 'confirmed' | 'failed' | 'parked' | 'cancelled';

export type PayeeStatus = 'unpaid' | 'assigned' | 'paid';

const RUN_MOVES: Record<RunStatus, readonly RunStatus[]> = {
  created: ['awaiting_funds', 'cancelling'],
  awaiting_funds: ['funded', 'cancelling', 'cancelled'],
  funded: ['processing', 'cancelling'],
  processing: ['completed', 'partially_failed', 'cancelling'],
  partially_failed: ['processing', 'cancelling'],
  // A cancel is a request: when the provider refuses, the run goes back to where it was.
  cancelling: ['cancelled', 'created', 'awaiting_funds', 'funded', 'processing'],
  completed: [],
  cancelled: [],
};

const BATCH_MOVES: Record<BatchStatus, readonly BatchStatus[]> = {
  pending: ['sending', 'cancelled'],
  // Back to pending only when the provider refused before creating anything.
  sending: ['sent', 'failed', 'parked', 'pending'],
  sent: ['confirmed', 'cancelled', 'parked'],
  // A person looked at it and decided.
  parked: ['sent', 'failed', 'cancelled'],
  confirmed: [],
  failed: [],
  cancelled: [],
};

const PAYEE_MOVES: Record<PayeeStatus, readonly PayeeStatus[]> = {
  unpaid: ['assigned'],
  assigned: ['paid', 'unpaid'],
  paid: [],
};

const MOVES = { run: RUN_MOVES, batch: BATCH_MOVES, payee: PAYEE_MOVES } as const;

export function canMove(kind: 'run', from: RunStatus, to: RunStatus): boolean;
export function canMove(kind: 'batch', from: BatchStatus, to: BatchStatus): boolean;
export function canMove(kind: 'payee', from: PayeeStatus, to: PayeeStatus): boolean;
export function canMove(kind: keyof typeof MOVES, from: string, to: string): boolean {
  const allowed = (MOVES[kind] as Record<string, readonly string[]>)[from];
  return allowed !== undefined && allowed.includes(to);
}

/** A batch that may still pay someone. Its people are not free for another batch. */
export function isLive(status: BatchStatus): boolean {
  return status === 'pending' || status === 'sending' || status === 'sent' || status === 'parked';
}

export type FundingSource = 'provider' | 'simulated';

/**
 * May this run send batches? Only when it is funded, and simulated funding
 * (typed in by an operator) counts only where it was explicitly allowed,
 * which is never production.
 */
export function maySend(
  run: { status: RunStatus; funding?: { source: FundingSource } },
  allowSimulated: boolean,
): boolean {
  if (run.status !== 'funded' && run.status !== 'processing') return false;
  if (!run.funding) return false;
  return run.funding.source === 'provider' || allowSimulated;
}

/**
 * Where a funded run stands, from its batches and people:
 * work still in flight → processing; everyone paid → completed;
 * nothing in flight and someone unpaid → partially_failed.
 */
export function progress(
  batches: readonly BatchStatus[],
  people: { unpaid: number; assigned: number; paid: number },
): 'processing' | 'completed' | 'partially_failed' {
  if (batches.some(isLive)) return 'processing';
  if (people.unpaid === 0 && people.assigned === 0) return 'completed';
  return 'partially_failed';
}

/** A run can be cancelled until the first person is paid. After that, only forward. */
export function mayCancel(status: RunStatus, paidPeople: number): boolean {
  if (paidPeople > 0) return false;
  return canMove('run', status, 'cancelling');
}
