// Step 5: was the batch paid? There is no webhook for a completed
// distribution, so we read it from Oncade and decide person by person.

import { payoutEntries } from '../core/ledger.ts';
import { compareBatch } from '../core/reconcile.ts';
import { inTransaction } from '../infra/db.ts';
import { col, markPaid, moveBatch, postLedger, refreshProgress, releasePeople } from '../infra/store.ts';
import { oncade } from '../oncade/client.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { Later } from './later.ts';

/**
 * Compares one sent batch with its distribution at the provider and acts on the difference. "Paid there" is the
 * normal path, and is not counted as a difference, because no webhook reports it.
 */
export async function syncBatch(batchId: string): Promise<void> {
  const batch = await col.batches().findOne({ _id: batchId });
  if (!batch || batch.status !== 'sent' || !batch.distribution) return;
  const run = await col.runs().findOne({ _id: batch.runId });
  if (!run?.funding) return;

  const found = await oncade.findDistribution(batch.distribution.id);
  if (!found.ok) throw new Later(15, `distribution read: ${found.outcome.kind}`);
  const people = await col
    .payees()
    .find({ _id: { $in: batch.payeeIds } })
    .toArray();
  const verdict = compareBatch(
    { status: batch.status, people: people.map((p) => ({ id: p._id, email: p.email, amountCents: p.amountCents })) },
    found.value ? { status: found.value.status, lines: found.value.lines } : null,
  );
  const difference = verdict.difference;
  if (!difference) return; // still open at the provider
  if (difference.kind !== 'completion_missed')
    m.differences.add(1, { kind: difference.kind, repair: difference.repair });

  if (difference.repair === 'manual') {
    const problem = { reason: difference.kind, code: null };
    if (await moveBatch(undefined, batchId, 'sent', 'parked', difference.kind, { problem })) {
      m.batchTransitions.add(1, { to: 'parked' });
      log.error('batch.parked', { run_reference: batch.runId, batch: batchId, reason: difference.kind });
    }
    return;
  }

  const source = run.funding.source;
  const feeCents = batch.distribution.feeCents;
  const outcome = await inTransaction(async (session) => {
    if (difference.kind === 'completion_missed') {
      if (!(await moveBatch(session, batchId, 'sent', 'confirmed', 'paid at the provider'))) return null;
      await markPaid(session, batchId, verdict.paid);
      const paid = people
        .filter((p) => verdict.paid.includes(p._id))
        .map((p) => ({ id: p._id, amountCents: p.amountCents }));
      await postLedger(session, batch.runId, payoutEntries({ runId: batch.runId, batchId, source, paid, feeCents }));
    } else {
      if (!(await moveBatch(session, batchId, 'sent', 'cancelled', 'cancelled at the provider'))) return null;
      await releasePeople(session, batchId);
    }
    const cause =
      difference.kind === 'completion_missed' ? 'batch paid at the provider' : 'batch cancelled at the provider';
    const status = await refreshProgress(session, batch.runId, cause);
    return { to: difference.kind === 'completion_missed' ? 'confirmed' : 'cancelled', run: status };
  });
  if (!outcome) return;
  m.batchTransitions.add(1, { to: outcome.to });
  if (outcome.run) m.runTransitions.add(1, { to: outcome.run });
  log.info(`batch.${outcome.to}`, { run_reference: batch.runId, batch: batchId, people: verdict.paid.length });
}
