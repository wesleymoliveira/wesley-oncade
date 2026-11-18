// The documents this project keeps, and the few ways they may change.
// A state changes only through moveRun / moveBatch, with the expected state
// in the filter: if someone else moved it first, nothing is written.

import { ObjectId, type ClientSession, type Document, type Filter, type UpdateFilter } from 'mongodb';
import { assertBalanced, type Entry } from '../core/ledger.ts';
import type { FeeRule } from '../core/money.ts';
import {
  canMove,
  progress,
  type BatchStatus,
  type FundingSource,
  type PayeeStatus,
  type RunStatus,
} from '../core/run.ts';
import { currentTraceId, currentTraceparent } from '../telemetry/trace.ts';
import { db } from './db.ts';

interface Step<S> {
  at: Date;
  from: S | null;
  to: S;
  cause: string;
  /** The trace in which this change happened: from a run to its trace in one click. */
  traceId?: string;
}

export interface RunDoc {
  /** The run's reference, chosen by the client. */
  _id: string;
  status: RunStatus;
  client: { name: string; email: string };
  payrollCents: number;
  marginCents: number;
  /** Filled when the invoice is issued, from the provider's fee preview. */
  feeRules: FeeRule[];
  feeReserveCents: number;
  /** payroll + fee reserve + margin. 0 until the invoice is issued. */
  invoiceCents: number;
  invoice?: { id: string; url: string | null };
  /** Set before the call that creates the invoice, so a later attempt knows one may exist. */
  invoiceAttemptedAt?: Date;
  funding?: {
    source: FundingSource;
    receivedCents: number;
    path: 'webhook' | 'pull' | 'operator';
    at: Date;
    reason?: string;
  };
  /** Something a person must look at. The run does not move by itself while this is set. */
  review?: { kind: string; at: Date };
  cancel?: { requestedAt: Date; from: RunStatus; refused?: string };
  /** Counts "retry failed" rounds. Batches of round N are named a<N>. */
  attempt: number;
  /** Written by every progress check, so that two checks of one run at the same moment collide. */
  progressChecks?: number;
  history: Step<RunStatus>[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PayeeDoc {
  _id: string;
  runId: string;
  name: string;
  email: string;
  amountCents: number;
  status: PayeeStatus;
  /** The one live batch this person is in, if any. */
  batchId: string | null;
}

export interface BatchDoc {
  /** Also our reference for the send: it travels in the memo and makes the idempotency key. */
  _id: string;
  runId: string;
  status: BatchStatus;
  payeeIds: string[];
  totalCents: number;
  feeEstimateCents: number;
  /** While `sending`: until when the worker that claimed it may still be working. */
  leaseUntil: Date | null;
  distribution?: { id: string; status: string; feeCents: number };
  problem?: { reason: string; code: string | null };
  history: Step<BatchStatus>[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerDoc extends Entry {
  /** `${txId}#${n}`: unique, so one business event cannot post twice. */
  _id: string;
  runId: string;
  at: Date;
}

export interface BalanceDoc {
  /** The account name. */
  _id: string;
  runId: string | null;
  cents: number;
}

export type MessageType =
  'invoice.create' | 'funding.check' | 'batch.send' | 'batch.sync' | 'run.cancel' | 'customer.notify' | 'check.all';

export interface OutboxDoc {
  _id: ObjectId;
  type: MessageType;
  payload: Record<string, string | number | boolean | null>;
  traceparent: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface InboxDoc {
  /** Hash of the raw webhook body: a retry has the same id. */
  _id: string;
  event: string;
  receivedAt: Date;
}

export interface IdempotencyDoc {
  /** The client's Idempotency-Key. */
  _id: string;
  fingerprint: string;
  runId: string;
  createdAt: Date;
}

export const col = {
  runs: () => db().collection<RunDoc>('runs'),
  payees: () => db().collection<PayeeDoc>('payees'),
  batches: () => db().collection<BatchDoc>('batches'),
  ledger: () => db().collection<LedgerDoc>('ledger'),
  balances: () => db().collection<BalanceDoc>('balances'),
  outbox: () => db().collection<OutboxDoc>('outbox'),
  inbox: () => db().collection<InboxDoc>('webhook_inbox'),
  idempotency: () => db().collection<IdempotencyDoc>('idempotency_keys'),
};

export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    col.runs().createIndex({ status: 1 }),
    col.runs().createIndex({ 'invoice.id': 1 }),
    col.payees().createIndex({ runId: 1, status: 1 }),
    col.payees().createIndex({ batchId: 1 }),
    col.batches().createIndex({ runId: 1, status: 1 }),
    col.batches().createIndex({ status: 1, leaseUntil: 1 }),
    col.batches().createIndex({ 'distribution.id': 1 }),
    col.ledger().createIndex({ runId: 1 }),
    col.balances().createIndex({ runId: 1 }),
    col.outbox().createIndex({ publishedAt: 1, _id: 1 }),
  ]);
}

function step<S>(from: S | null, to: S, cause: string): Step<S> {
  return { at: new Date(), from, to, cause, traceId: currentTraceId() };
}

export function firstStep<S>(to: S, cause: string): Step<S> {
  return step<S>(null, to, cause);
}

/** Moves a run from one state to another. False when it was no longer in `from`. */
export async function moveRun(
  session: ClientSession,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  cause: string,
  set: Partial<RunDoc> = {},
  unset: (keyof RunDoc)[] = [],
): Promise<boolean> {
  if (!canMove('run', from, to)) throw new Error(`a run cannot go from ${from} to ${to}`);
  const update: UpdateFilter<RunDoc> = {
    $set: { ...set, status: to, updatedAt: new Date() },
    $push: { history: step(from, to, cause) },
  };
  if (unset.length > 0) update.$unset = Object.fromEntries(unset.map((key) => [key, ''])) as Document;
  const result = await col.runs().updateOne({ _id: runId, status: from }, update, { session });
  return result.modifiedCount === 1;
}

/** Moves a batch from one state to another. False when it was no longer in `from`. */
export async function moveBatch(
  session: ClientSession | undefined,
  batchId: string,
  from: BatchStatus,
  to: BatchStatus,
  cause: string,
  set: Partial<BatchDoc> = {},
  extraFilter: Filter<BatchDoc> = {},
): Promise<boolean> {
  if (!canMove('batch', from, to)) throw new Error(`a batch cannot go from ${from} to ${to}`);
  const result = await col
    .batches()
    .updateOne(
      { ...extraFilter, _id: batchId, status: from },
      { $set: { ...set, status: to, updatedAt: new Date() }, $push: { history: step(from, to, cause) } },
      { session },
    );
  return result.modifiedCount === 1;
}

/**
 * Moves people from one state to another. Like runs and batches, a person
 * changes state only if the core rules allow the move and only if they are
 * still in `from`: a person already paid can never be assigned again.
 */
async function movePeople(
  session: ClientSession,
  who: Filter<PayeeDoc>,
  from: PayeeStatus,
  to: PayeeStatus,
  batchId: string | null,
): Promise<void> {
  if (!canMove('payee', from, to)) throw new Error(`a person cannot go from ${from} to ${to}`);
  await col.payees().updateMany({ ...who, status: from }, { $set: { status: to, batchId } }, { session });
}

/** The people of a batch are free again: this batch will never pay them. */
export function releasePeople(session: ClientSession, batchId: string): Promise<void> {
  return movePeople(session, { batchId }, 'assigned', 'unpaid', null);
}

/** These people of a batch were paid. They keep the batch that paid them. */
export function markPaid(session: ClientSession, batchId: string, payeeIds: string[]): Promise<void> {
  return movePeople(session, { _id: { $in: payeeIds }, batchId }, 'assigned', 'paid', batchId);
}

/** Unpaid people go into a new batch. */
export function assignPeople(session: ClientSession, batchId: string, payeeIds: string[]): Promise<void> {
  return movePeople(session, { _id: { $in: payeeIds } }, 'unpaid', 'assigned', batchId);
}

export async function peopleCount(
  runId: string,
  session?: ClientSession,
): Promise<{ unpaid: number; assigned: number; paid: number }> {
  const rows = await col
    .payees()
    .aggregate<{ _id: PayeeStatus; n: number }>(
      [{ $match: { runId } }, { $group: { _id: '$status', n: { $sum: 1 } } }],
      { session },
    )
    .toArray();
  const count = (status: PayeeStatus) => rows.find((row) => row._id === status)?.n ?? 0;
  return { unpaid: count('unpaid'), assigned: count('assigned'), paid: count('paid') };
}

/** Posts one ledger transaction and updates the balances, which are a copy. */
export async function postLedger(session: ClientSession, runId: string, entries: Entry[]): Promise<void> {
  assertBalanced(entries);
  const at = new Date();
  await col.ledger().insertMany(
    entries.map((entry, i) => ({ ...entry, _id: `${entry.txId}#${i}`, runId, at })),
    { session },
  );
  await col.balances().bulkWrite(
    entries.map((entry) => ({
      updateOne: {
        filter: { _id: entry.account },
        update: {
          $inc: { cents: entry.amountCents },
          $setOnInsert: { runId: entry.account.startsWith('cash:') ? null : runId },
        },
        upsert: true,
      },
    })),
    { session },
  );
}

/** The balance of every account that belongs to one run (not cash). */
export async function runBalances(runId: string, session?: ClientSession): Promise<Record<string, number>> {
  const rows = await col.balances().find({ runId }, { session }).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.cents]));
}

/** Adds an event to the outbox, in the caller's transaction. A relay publishes it later. */
export async function enqueue(session: ClientSession, type: MessageType, payload: OutboxDoc['payload']): Promise<void> {
  await col.outbox().insertOne(
    {
      _id: new ObjectId(),
      type,
      payload,
      traceparent: currentTraceparent(),
      createdAt: new Date(),
      publishedAt: null,
    },
    { session },
  );
}

/**
 * After batches or people changed: where does the run stand now?
 * Moves it between processing, completed and partially_failed when needed
 * and returns the new state, or null when nothing changed. `funded` and
 * `partially_failed` can only become `processing`, so a move goes through it.
 * A run that reaches an end tells its customer, in the same transaction.
 *
 * It writes the run before it reads the batches. Two batches of one run can
 * end in two transactions at the same moment: each would read the other as
 * still live and leave the run in `processing` for good. With the write, the
 * database refuses one of the two, and the driver runs it again after the other.
 */
export async function refreshProgress(session: ClientSession, runId: string, cause: string): Promise<RunStatus | null> {
  const run = await col
    .runs()
    .findOneAndUpdate(
      { _id: runId, status: { $in: ['funded', 'processing', 'partially_failed'] } },
      { $inc: { progressChecks: 1 } },
      { session },
    );
  if (!run) return null;
  const batches = await col
    .batches()
    .find({ runId }, { session, projection: { status: 1 } })
    .toArray();
  const target = progress(
    batches.map((batch) => batch.status),
    await peopleCount(runId, session),
  );
  let current = run.status;
  if (current === target) return null;
  if (current !== 'processing') {
    await moveRun(session, runId, current, 'processing', cause);
    current = 'processing';
  }
  if (target !== 'processing') {
    await moveRun(session, runId, current, target, cause);
    await enqueue(session, 'customer.notify', { event: `run.${target}`, runId });
  }
  return target;
}
