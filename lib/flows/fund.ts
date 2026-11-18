// Step 3: the client's money arrives. Two ways in, one function:
//  - the webhook says "look at this invoice";
//  - the periodic check looks at every invoice still open.
// Both read the invoice from Oncade and record the funding once. Whichever
// comes second finds the run already funded and does nothing.

import { config } from '../config.ts';
import { fundingEntries } from '../core/ledger.ts';
import { compareFunding } from '../core/reconcile.ts';
import type { FundingSource } from '../core/run.ts';
import { inTransaction } from '../infra/db.ts';
import { col, enqueue, moveBatch, moveRun, postLedger, releasePeople, type RunDoc } from '../infra/store.ts';
import { oncade } from '../oncade/client.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { Later } from './later.ts';

type Path = NonNullable<RunDoc['funding']>['path'];

async function fund(
  run: RunDoc,
  source: FundingSource,
  path: Path,
  receivedCents: number,
  reason?: string,
): Promise<boolean> {
  const people = await col.payees().find({ runId: run._id }).toArray();
  const moved = await inTransaction(async (session) => {
    const funding = { source, receivedCents, path, at: new Date(), ...(reason ? { reason } : {}) };
    if (
      !(await moveRun(session, run._id, 'awaiting_funds', 'funded', `funding recorded (${source}, ${path})`, {
        funding,
      }))
    ) {
      return false;
    }
    await postLedger(
      session,
      run._id,
      fundingEntries({
        runId: run._id,
        source,
        receivedCents,
        people: people.map((person) => ({ id: person._id, amountCents: person.amountCents })),
        feeReserveCents: run.feeReserveCents,
        marginCents: run.marginCents,
      }),
    );
    const batches = await col.batches().find({ runId: run._id, status: 'pending' }, { session }).toArray();
    for (const batch of batches) await enqueue(session, 'batch.send', { batchId: batch._id });
    await enqueue(session, 'customer.notify', {
      event: 'run.funded',
      runId: run._id,
      simulated: source === 'simulated',
    });
    return true;
  });
  if (moved) {
    const invoicedAt = run.history.findLast((step) => step.to === 'awaiting_funds')?.at ?? run.createdAt;
    m.runTransitions.add(1, { to: 'funded' });
    m.fundingRecorded.add(1, { path, source });
    m.timeToFunded.record((Date.now() - invoicedAt.getTime()) / 1000);
    log.info('run.funded', { run_reference: run._id, source, path, received_cents: receivedCents });
  }
  return moved;
}

/** The invoice was cancelled at the provider: nothing will be paid, so nothing is owed. */
async function followCancel(run: RunDoc): Promise<void> {
  const moved = await inTransaction(async (session) => {
    if (!(await moveRun(session, run._id, 'awaiting_funds', 'cancelled', 'invoice cancelled at the provider')))
      return false;
    const batches = await col.batches().find({ runId: run._id, status: 'pending' }, { session }).toArray();
    for (const batch of batches) {
      await moveBatch(session, batch._id, 'pending', 'cancelled', 'run cancelled');
      await releasePeople(session, batch._id);
    }
    await enqueue(session, 'customer.notify', { event: 'run.cancelled', runId: run._id });
    return true;
  });
  if (moved) m.runTransitions.add(1, { to: 'cancelled' });
}

/** The one function both paths call. A difference found by the periodic check is counted: the webhook missed it. */
export async function recordFunding(runId: string, path: 'webhook' | 'pull'): Promise<void> {
  const run = await col.runs().findOne({ _id: runId });
  if (!run || run.status !== 'awaiting_funds' || !run.invoice || run.review) return;

  const reply = await oncade.getInvoice(run.invoice.id);
  const notThere = !reply.ok && reply.outcome.kind === 'rejected' && reply.outcome.status === 404;
  if (!reply.ok && !notThere) throw new Later(15, `invoice read: ${reply.outcome.kind}`);

  const difference = compareFunding(run, reply.ok ? reply.value : null);
  if (!difference) return; // still open: keep waiting
  if (path === 'pull') m.differences.add(1, { kind: difference.kind, repair: difference.repair });

  if (difference.kind === 'funding_missed' && reply.ok) {
    await fund(run, 'provider', path, reply.value.totalCents);
  } else if (difference.kind === 'cancelled_at_provider') {
    await followCancel(run);
  } else {
    await col
      .runs()
      .updateOne(
        { _id: runId, status: 'awaiting_funds' },
        { $set: { review: { kind: difference.kind, at: new Date() } } },
      );
    log.error('run.needs_review', { run_reference: runId, kind: difference.kind });
  }
}

/**
 * An operator says "treat this run as funded" without money from Oncade.
 * It exists to exercise the payout side in test. It is refused without
 * the stand-in or a test key, the ledger books it in its own cash
 * account, and every report shows it as simulated.
 */
export async function simulateFunding(runId: string, reason: string): Promise<boolean> {
  if (!config.allowSimulatedFunding) throw new Error('simulated funding needs the stand-in or a test key');
  if (reason.trim() === '') throw new Error('simulated funding needs a reason');
  const run = await col.runs().findOne({ _id: runId });
  if (!run || run.status !== 'awaiting_funds') return false;
  log.warn('run.funding_simulated', { run_reference: runId });
  return fund(run, 'simulated', 'operator', run.invoiceCents, reason);
}
