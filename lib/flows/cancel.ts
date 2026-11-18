// Cancelling a run. A cancel is a request, not a fact:
//  - the run goes to `cancelling` and stays there until the provider has
//    confirmed every part;
//  - the ledger is reversed only after that confirmation;
//  - if the provider refuses any part (the client already paid, a batch is
//    already being paid), the cancel loses and the run goes back to where it
//    was. Parts already cancelled stay cancelled: their people are unpaid
//    again, and "retry failed" pays them in new batches.
// Undo runs in the reverse order of doing, and only while it can be undone.

import { config } from '../config.ts';
import { account, cancelEntries } from '../core/ledger.ts';
import { mayCancel } from '../core/run.ts';
import { inTransaction } from '../infra/db.ts';
import {
  col,
  enqueue,
  moveBatch,
  moveRun,
  peopleCount,
  postLedger,
  refreshProgress,
  releasePeople,
  runBalances,
  type BatchDoc,
  type RunDoc,
} from '../infra/store.ts';
import { oncade } from '../oncade/client.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { Later } from './later.ts';

export type CancelAnswer =
  | { kind: 'accepted'; status: 'cancelling' | 'cancelled' }
  | { kind: 'refused'; reason: string }
  | { kind: 'not_found' };

/** Asking twice, one after the other or at the same moment, gets the same answer: the cancel is under way or done. */
export async function requestCancel(runId: string): Promise<CancelAnswer> {
  const run = await col.runs().findOne({ _id: runId });
  if (!run) return { kind: 'not_found' };
  if (run.status === 'cancelling' || run.status === 'cancelled') return { kind: 'accepted', status: run.status };
  const { paid } = await peopleCount(runId);
  if (!mayCancel(run.status, paid)) {
    return {
      kind: 'refused',
      reason:
        paid > 0
          ? 'people were already paid: a run only goes forward from here'
          : `a ${run.status} run cannot be cancelled`,
    };
  }
  const moved = await inTransaction(async (session) => {
    const cancel = { requestedAt: new Date(), from: run.status };
    if (!(await moveRun(session, runId, run.status, 'cancelling', 'cancel requested', { cancel }))) return false;
    await enqueue(session, 'run.cancel', { runId });
    return true;
  });
  if (moved) return { kind: 'accepted', status: 'cancelling' };
  const now = await col.runs().findOne({ _id: runId }, { projection: { status: 1 } });
  if (now?.status === 'cancelling' || now?.status === 'cancelled') return { kind: 'accepted', status: now.status };
  return { kind: 'refused', reason: 'the run changed while cancelling: ask again' };
}

async function cancelBatchLocally(batch: BatchDoc, from: 'pending' | 'sent', cause: string): Promise<boolean> {
  const moved = await inTransaction(async (session) => {
    if (!(await moveBatch(session, batch._id, from, 'cancelled', cause))) return false;
    await releasePeople(session, batch._id);
    return true;
  });
  if (moved) m.batchTransitions.add(1, { to: 'cancelled' });
  return moved;
}

/**
 * Returns a reason when this batch cannot be cancelled, null when it is cancelled.
 * A `pending` batch races with a worker claiming it: one conditional write wins. A `sent` one is read at the
 * provider before and after the cancel call. Before: after an unanswered cancel, "already cancelled" is not taken
 * for "cannot be cancelled". After: this message can be delivered twice, and the second call is then refused
 * (seen: 422) for a distribution the first one cancelled.
 */
async function cancelBatch(batch: BatchDoc): Promise<string | null> {
  switch (batch.status) {
    case 'failed':
    case 'cancelled':
      return null;
    case 'confirmed':
      return `${batch._id}: already paid`;
    case 'parked':
      return `${batch._id}: waiting for a person`;
    case 'sending':
      throw new Later(config.batchLeaseMs / 1000, 'a batch is being sent: wait for its result');
    case 'pending':
      if (await cancelBatchLocally(batch, 'pending', 'run cancelled')) return null;
      throw new Later(5, 'a batch was claimed while cancelling');
    case 'sent': {
      const id = batch.distribution!.id;
      const remote = await oncade.findDistribution(id);
      if (!remote.ok || !remote.value) throw new Later(10, 'distribution read failed while cancelling');
      let status = remote.value.status;
      if (status === 'pending' || status === 'draft') {
        const reply = await oncade.cancelDistribution(id);
        if (!reply.ok && reply.outcome.kind !== 'rejected')
          throw new Later(10, `distribution cancel: ${reply.outcome.kind}`);
        const after = await oncade.findDistribution(id);
        if (!after.ok || !after.value) throw new Later(10, 'distribution read failed while cancelling');
        status = after.value.status;
      }
      if (status !== 'cancelled') return `${batch._id}: the provider has it as ${status}`;
      await cancelBatchLocally(batch, 'sent', 'cancel confirmed by the provider');
      return null;
    }
  }
}

/**
 * Returns a reason when the invoice cannot be cancelled, null when it is cancelled or never existed.
 * If a create was attempted and its answer never seen, we wait for that attempt to end and then look the invoice
 * up by our reference. Like a distribution, it is read again after the cancel call.
 */
async function cancelInvoice(run: RunDoc): Promise<string | null> {
  let invoiceId = run.invoice?.id;
  if (!invoiceId && run.invoiceAttemptedAt) {
    const wait = run.invoiceAttemptedAt.getTime() + config.batchLeaseMs - Date.now();
    if (wait > 0) throw new Later(wait / 1000, 'an invoice is being created: wait for its result');
    const found = await oncade.findInvoices(run._id);
    if (!found.ok) throw new Later(10, `invoice lookup: ${found.outcome.kind}`);
    if (found.value.length > 1) return 'more than one invoice exists for this run at the provider';
    invoiceId = found.value[0]?.id;
  }
  if (!invoiceId) return null;
  const remote = await oncade.getInvoice(invoiceId);
  if (!remote.ok) throw new Later(10, `invoice read: ${remote.outcome.kind}`);
  let status = remote.value.status;
  if (status !== 'cancelled' && status !== 'paid' && status !== 'processing') {
    const reply = await oncade.cancelInvoice(invoiceId);
    if (!reply.ok && reply.outcome.kind !== 'rejected') throw new Later(10, `invoice cancel: ${reply.outcome.kind}`);
    const after = await oncade.getInvoice(invoiceId);
    if (!after.ok) throw new Later(10, `invoice read: ${after.outcome.kind}`);
    status = after.value.status;
  }
  if (status === 'cancelled') return null;
  if (status === 'paid' || status === 'processing') return 'the client already paid the invoice';
  return `the provider has the invoice as ${status}`;
}

/**
 * The cancel lost: the run goes back to where it was, and whatever moves it from there is queued again.
 * A partially failed run goes back through `processing`, as every move out of that state does.
 */
async function giveUp(run: RunDoc, reason: string): Promise<void> {
  const from = run.cancel!.from;
  const back = from === 'partially_failed' ? 'processing' : from;
  const outcome = await inTransaction(async (session) => {
    const cancel = { ...run.cancel!, refused: reason };
    if (!(await moveRun(session, run._id, 'cancelling', back, `cancel refused: ${reason}`, { cancel }))) return null;
    if (back === 'created') await enqueue(session, 'invoice.create', { runId: run._id });
    if (back === 'awaiting_funds') await enqueue(session, 'funding.check', { runId: run._id, path: 'pull' });
    return { run: await refreshProgress(session, run._id, 'cancel refused') };
  });
  if (!outcome) return;
  m.runTransitions.add(1, { to: outcome.run ?? back });
  log.warn('run.cancel_refused', { run_reference: run._id, reason });
}

/**
 * Undoes a run in the reverse order of doing. The books change only when every part is confirmed cancelled.
 * Not funded: only the invoice exists at the provider. Funded: every batch must cancel, and one refusal means the
 * cancel loses. Simulated funding takes the invoice back too, since the client never paid, and is undone. Money
 * really received becomes "refund due": the provider's reference has no refund call, so a person sends it back.
 */
export async function executeCancel(runId: string): Promise<void> {
  const run = await col.runs().findOne({ _id: runId });
  if (!run || run.status !== 'cancelling' || !run.cancel) return;
  const batches = await col.batches().find({ runId }).toArray();

  if (!run.funding) {
    const refusal = await cancelInvoice(run);
    if (refusal) return giveUp(run, refusal);
    for (const batch of batches)
      if (batch.status === 'pending') await cancelBatchLocally(batch, 'pending', 'run cancelled');
    const done = await inTransaction(async (session) => {
      if (!(await moveRun(session, runId, 'cancelling', 'cancelled', 'cancel confirmed by the provider'))) return false;
      await enqueue(session, 'customer.notify', { event: 'run.cancelled', runId });
      return true;
    });
    if (done) m.runTransitions.add(1, { to: 'cancelled' });
    return;
  }

  const refusals: string[] = [];
  for (const batch of batches) {
    const refusal = await cancelBatch(batch);
    if (refusal) refusals.push(refusal);
  }
  if (refusals.length > 0) return giveUp(run, refusals.join('; '));

  const simulated = run.funding.source === 'simulated';
  if (simulated) {
    const refusal = await cancelInvoice(run);
    if (refusal) return giveUp(run, refusal);
  }

  const source = run.funding.source;
  const done = await inTransaction(async (session) => {
    const balances = await runBalances(runId, session);
    const open = Object.fromEntries(
      Object.entries(balances).filter(([name, cents]) => cents !== 0 && name !== account.refundDue(runId)),
    );
    if (!(await moveRun(session, runId, 'cancelling', 'cancelled', 'every part cancelled at the provider')))
      return false;
    if (Object.keys(open).length > 0) await postLedger(session, runId, cancelEntries(runId, source, open));
    await enqueue(session, 'customer.notify', { event: 'run.cancelled', runId, refundDue: !simulated });
    return true;
  });
  if (done) {
    m.runTransitions.add(1, { to: 'cancelled' });
    log.warn(simulated ? 'run.cancelled_simulation_undone' : 'run.cancelled_refund_due', { run_reference: runId });
  }
}
