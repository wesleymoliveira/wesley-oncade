// Step 4: send one batch, which creates one distribution at Oncade.
//
// The order is what makes it safe:
//   1. claim the batch: pending → sending, in one conditional write. Only
//      the worker that wins sends. The batch id is our reference for the
//      send, and it is in the database before the call.
//   2. call Oncade once.
//   3. write what happened.
// If the worker dies between 2 and 3 the batch stays in `sending`. Nobody
// resends it: the next worker asks Oncade whether that send exists.

import { config } from '../config.ts';
import { neverHappened, nextStep } from '../core/failures.ts';
import { maySend } from '../core/run.ts';
import { inTransaction } from '../infra/db.ts';
import { col, moveBatch, refreshProgress, releasePeople, type BatchDoc } from '../infra/store.ts';
import { oncade, type RemoteDistribution } from '../oncade/client.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { Later } from './later.ts';

const lease = () => new Date(Date.now() + config.batchLeaseMs);

/** Records what exists at the provider. Another amount, or a fee above the reserve, parks the batch for a person. */
async function sent(batch: BatchDoc, distribution: RemoteDistribution, cause: string): Promise<void> {
  const info = { id: distribution.id, status: distribution.status, feeCents: distribution.feeCents };
  const reason =
    distribution.totalCents !== batch.totalCents
      ? 'amount_differs_from_request'
      : distribution.feeCents > batch.feeEstimateCents
        ? 'fee_above_reserve'
        : null;
  if (reason) {
    await moveBatch(undefined, batch._id, 'sending', 'parked', reason, {
      distribution: info,
      problem: { reason, code: null },
      leaseUntil: null,
    });
    m.batchTransitions.add(1, { to: 'parked' });
    log.error('batch.parked', { run_reference: batch.runId, batch: batch._id, reason });
    return;
  }
  if (await moveBatch(undefined, batch._id, 'sending', 'sent', cause, { distribution: info, leaseUntil: null })) {
    m.batchTransitions.add(1, { to: 'sent' });
    log.info('batch.sent', { run_reference: batch.runId, batch: batch._id, total_cents: batch.totalCents });
  }
}

async function park(batch: BatchDoc, reason: string): Promise<void> {
  if (
    await moveBatch(undefined, batch._id, 'sending', 'parked', reason, {
      problem: { reason, code: null },
      leaseUntil: null,
    })
  ) {
    m.batchTransitions.add(1, { to: 'parked' });
    log.error('batch.parked', { run_reference: batch.runId, batch: batch._id, reason });
  }
}

/** The provider refused the batch: nothing was created, so its people are free again. */
async function failed(batch: BatchDoc, code: string | null, message: string): Promise<void> {
  const outcome = await inTransaction(async (session) => {
    const problem = { reason: message.slice(0, 200), code };
    if (
      !(await moveBatch(session, batch._id, 'sending', 'failed', 'refused by the provider', {
        problem,
        leaseUntil: null,
      }))
    ) {
      return null;
    }
    await releasePeople(session, batch._id);
    return { run: await refreshProgress(session, batch.runId, 'batch failed') };
  });
  if (outcome) {
    m.batchTransitions.add(1, { to: 'failed' });
    if (outcome.run) m.runTransitions.add(1, { to: outcome.run });
    log.warn('batch.failed', { run_reference: batch.runId, batch: batch._id, code: code ?? 'none' });
  }
}

/**
 * One call to the provider, never repeated here. `nextStep` in lib/core/failures.ts decides what is safe after it:
 * refused, the batch fails; never sent, it goes back to `pending`; no answer, it stays in `sending` for `recover`.
 */
async function create(batch: BatchDoc): Promise<void> {
  const people = await col
    .payees()
    .find({ _id: { $in: batch.payeeIds } })
    .toArray();
  const result = await oncade.createDistribution({ reference: batch._id, people, totalCents: batch.totalCents });
  if (result.ok) return sent(batch, result.value, 'distribution created');

  if (nextStep(result.outcome, { creates: true }) === 'give_up') {
    const code = result.outcome.kind === 'rejected' ? result.outcome.code : null;
    return failed(batch, code, result.message);
  }
  if (neverHappened(result.outcome)) {
    await moveBatch(undefined, batch._id, 'sending', 'pending', `not sent: ${result.outcome.kind}`, {
      leaseUntil: null,
    });
    throw new Later(5, `distribution create: ${result.outcome.kind}`);
  }
  log.warn('batch.outcome_unknown', { run_reference: batch.runId, batch: batch._id });
  throw new Later(config.batchLeaseMs / 1000, 'distribution create: no answer');
}

/**
 * A batch found in `sending` after its lease ran out. We ask the provider, by our reference, what really happened:
 * two live distributions, a person decides (adopting either could pay twice); one, or only cancelled ones, it is
 * ours; none, a person decides too, because "not found" is not proof that the first request will never land.
 */
async function recover(batch: BatchDoc): Promise<void> {
  const found = await oncade.findDistributions(batch._id);
  if (!found.ok) throw new Later(10, `distribution lookup: ${found.outcome.kind}`);
  const live = found.value.filter((d) => d.status !== 'cancelled');
  if (live.length > 1) return park(batch, 'duplicate_distributions_at_provider');
  const ours = live[0] ?? found.value[0];
  if (ours) return sent(batch, ours, 'recovered: found at the provider by our reference');
  return park(batch, 'outcome_unknown_not_found_at_provider');
}

export async function sendBatch(batchId: string): Promise<void> {
  const batch = await col.batches().findOne({ _id: batchId });
  if (!batch) return;

  if (batch.status === 'sending') {
    const wait = (batch.leaseUntil?.getTime() ?? 0) - Date.now();
    if (wait > 0) throw new Later(wait / 1000, 'another worker may still hold this batch');
    return recover(batch);
  }
  if (batch.status !== 'pending') return; // already handled: this message is a repeat

  const run = await col.runs().findOne({ _id: batch.runId });
  if (!run || !maySend(run, config.allowSimulatedFunding)) return;

  const claimed = await moveBatch(undefined, batchId, 'pending', 'sending', 'claimed by a worker', {
    leaseUntil: lease(),
  });
  if (!claimed) return; // another worker won
  m.batchTransitions.add(1, { to: 'sending' });
  await inTransaction((session) => refreshProgress(session, batch.runId, 'first batch claimed'));
  await create(batch);
}
