// "Retry failed": pay the people who are still unpaid, in new batches.
// It never resends an old batch. A person is unpaid only when the batch
// that held them ended without paying them, and that was confirmed.

import { batchId, chunk } from '../core/batches.ts';
import { account } from '../core/ledger.ts';
import { estimateFees, sum } from '../core/money.ts';
import { inTransaction } from '../infra/db.ts';
import { assignPeople, col, enqueue, firstStep, moveRun, runBalances, type BatchDoc } from '../infra/store.ts';
import { m } from '../telemetry/metrics.ts';

export type RetryAnswer =
  { kind: 'accepted'; batches: number; people: number } | { kind: 'refused'; reason: string } | { kind: 'not_found' };

/**
 * New batches for the unpaid people only. Refused when their fees do not fit in what is left of the fee reserve:
 * a run never pays more than was funded.
 */
export async function retryFailed(runId: string): Promise<RetryAnswer> {
  const answer = await inTransaction<RetryAnswer>(async (session) => {
    const run = await col.runs().findOne({ _id: runId }, { session });
    if (!run) return { kind: 'not_found' };
    if (run.status !== 'partially_failed')
      return { kind: 'refused', reason: `the run is ${run.status}, not partially_failed` };

    const unpaid = await col.payees().find({ runId, status: 'unpaid' }, { session }).sort({ _id: 1 }).toArray();
    const attempt = run.attempt + 1;
    const now = new Date();
    const batches: BatchDoc[] = chunk(unpaid).map((group, i) => {
      const totalCents = sum(group.map((person) => person.amountCents));
      return {
        _id: batchId(runId, attempt, i + 1),
        runId,
        status: 'pending',
        payeeIds: group.map((person) => person._id),
        totalCents,
        feeEstimateCents: estimateFees(run.feeRules, totalCents, group.length),
        leaseUntil: null,
        history: [firstStep('pending', 'retry of unpaid people')],
        createdAt: now,
        updatedAt: now,
      };
    });

    const reserveLeft = -((await runBalances(runId, session))[account.fees(runId)] ?? 0);
    if (sum(batches.map((batch) => batch.feeEstimateCents)) > reserveLeft) {
      return { kind: 'refused', reason: 'the fee reserve does not cover another round: a person must decide' };
    }

    await col.batches().insertMany(batches, { session });
    for (const batch of batches) {
      await assignPeople(session, batch._id, batch.payeeIds);
      await enqueue(session, 'batch.send', { batchId: batch._id });
    }
    await col.runs().updateOne({ _id: runId }, { $set: { attempt } }, { session });
    await moveRun(session, runId, 'partially_failed', 'processing', 'retry of unpaid people');
    return { kind: 'accepted', batches: batches.length, people: unpaid.length };
  });
  if (answer.kind === 'accepted') m.runTransitions.add(1, { to: 'processing' });
  return answer;
}
