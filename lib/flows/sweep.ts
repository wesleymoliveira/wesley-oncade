// The periodic check: the safety net under everything else. It assumes
// that any message or webhook may have been lost, reads the provider, and
// moves forward whatever can safely move. It also measures what is stuck.

import { balanceDrift } from '../core/ledger.ts';
import { queueDepth } from '../infra/queue.ts';
import { col } from '../infra/store.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { withSpan } from '../telemetry/trace.ts';
import { syncBatch } from './confirm.ts';
import { recordFunding } from './fund.ts';
import { issueInvoice } from './invoice.ts';
import { Later } from './later.ts';
import { sendBatch } from './send-batch.ts';

const ageSeconds = (date: Date | undefined) => (date ? Math.max(0, (Date.now() - date.getTime()) / 1000) : 0);

/**
 * Runs one step. "Not now" is normal and counts as done: while the provider is down every step says it, and the
 * breaker's own alert reports that. A real error is logged with what it was about, and the check goes on.
 */
async function attempt(about: Record<string, string>, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (err) {
    if (err instanceof Later) return true;
    const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
    log.error('sweep.step_failed', { ...about, reason });
    return false;
  }
}

const ofRun = (runId: string) => ({ run_reference: runId });
const ofBatch = (batchId: string) => ({ run_reference: batchId.split('/')[0]!, batch: batchId });

/**
 * The gauges behind the alerts. It reads the whole ledger: fine at this size; at volume, one run at a time.
 * The queue is read last, on its own: when the queue is down, the outbox gauge is the one that must still move.
 */
async function measure(): Promise<void> {
  const [oldestUnfunded, oldestSending, parked, unpublished, balances, entries] = await Promise.all([
    col.runs().findOne({ status: 'awaiting_funds' }, { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }),
    col.batches().findOne({ status: 'sending' }, { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }),
    col.batches().countDocuments({ status: 'parked' }),
    col.outbox().countDocuments({ publishedAt: null }),
    col.balances().find().toArray(),
    col
      .ledger()
      .find({}, { projection: { txId: 1, account: 1, amountCents: 1 } })
      .toArray(),
  ]);
  m.oldestUnfundedAge.record(ageSeconds(oldestUnfunded?.updatedAt));
  m.oldestSendingAge.record(ageSeconds(oldestSending?.updatedAt));
  m.parkedBatches.record(parked);
  m.outboxUnpublished.record(unpublished);
  const stored = Object.fromEntries(balances.map((row) => [row._id, row.cents]));
  m.ledgerDrift.record(balanceDrift(stored, entries).length);

  const depth = await queueDepth();
  m.queueMessages.record(depth.waiting, { state: 'waiting' });
  m.queueMessages.record(depth.inFlight, { state: 'in_flight' });
  m.queueMessages.record(depth.deadLetters, { state: 'dead_letter' });
}

/**
 * One pass, in the order of a run's life: invoices never issued, money that arrived, batches that were paid, and
 * batches stuck in `sending` or `pending` because a worker died or a message was lost. Only a complete pass
 * updates the "last success" gauge, so its alert catches a net with a hole.
 */
export async function sweep(): Promise<void> {
  await withSpan('reconcile.sweep', {}, async () => {
    const stale = new Date(Date.now() - 30_000);
    const results: boolean[] = [];

    const unbilled = await col
      .runs()
      .find({ status: 'created', review: { $exists: false }, updatedAt: { $lt: stale } })
      .limit(50)
      .toArray();
    for (const run of unbilled) results.push(await attempt(ofRun(run._id), () => issueInvoice(run._id)));

    const waiting = await col
      .runs()
      .find({ status: 'awaiting_funds', review: { $exists: false } })
      .limit(100)
      .toArray();
    for (const run of waiting) results.push(await attempt(ofRun(run._id), () => recordFunding(run._id, 'pull')));

    const sent = await col
      .batches()
      .find({ status: 'sent' }, { projection: { _id: 1 } })
      .limit(200)
      .toArray();
    for (const batch of sent) results.push(await attempt(ofBatch(batch._id), () => syncBatch(batch._id)));

    const stuck = await col
      .batches()
      .find(
        {
          $or: [
            { status: 'sending', leaseUntil: { $lt: new Date() } },
            { status: 'pending', updatedAt: { $lt: stale } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .limit(200)
      .toArray();
    for (const batch of stuck) results.push(await attempt(ofBatch(batch._id), () => sendBatch(batch._id)));

    results.push(await attempt({ step: 'gauges' }, measure));
    if (results.every(Boolean)) m.reconcileLastSuccess.record(Math.floor(Date.now() / 1000));
  });
}
