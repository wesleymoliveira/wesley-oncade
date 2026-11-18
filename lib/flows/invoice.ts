// Step 2: bill the client. The amount is decided once and saved; only then
// is the invoice created at Oncade. If an earlier attempt may have reached
// Oncade, we look for its invoice before creating another.

import { config } from '../config.ts';
import { neverHappened, nextStep } from '../core/failures.ts';
import { estimateFees, sum } from '../core/money.ts';
import { inTransaction } from '../infra/db.ts';
import { col, moveRun, type RunDoc } from '../infra/store.ts';
import { oncade, type RemoteInvoice } from '../oncade/client.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { Later } from './later.ts';

async function park(runId: string, kind: string): Promise<void> {
  await col.runs().updateOne({ _id: runId, status: 'created' }, { $set: { review: { kind, at: new Date() } } });
  log.error('run.needs_review', { run_reference: runId, kind });
}

/** Invoice = payroll + a reserve for Oncade's fee on every batch + the margin. */
async function decideAmount(run: RunDoc): Promise<RunDoc> {
  const rules = await oncade.feeRules();
  if (!rules.ok) throw new Later(10, `fee preview: ${rules.outcome.kind}`);
  const batches = await col.batches().find({ runId: run._id }).toArray();
  const estimates = batches.map((batch) => ({
    id: batch._id,
    cents: estimateFees(rules.value, batch.totalCents, batch.payeeIds.length),
  }));
  const reserve = sum(estimates.map((estimate) => estimate.cents));
  await inTransaction(async (session) => {
    for (const estimate of estimates) {
      await col.batches().updateOne({ _id: estimate.id }, { $set: { feeEstimateCents: estimate.cents } }, { session });
    }
    await col.runs().updateOne(
      { _id: run._id, status: 'created', invoiceCents: 0 },
      {
        $set: {
          feeRules: rules.value,
          feeReserveCents: reserve,
          invoiceCents: run.payrollCents + reserve + run.marginCents,
        },
      },
      { session },
    );
  });
  return (await col.runs().findOne({ _id: run._id }))!;
}

/**
 * Creates the invoice at most once, though the queue and the periodic check can both reach this step.
 * An earlier attempt with no result is never repeated: while its lease lasts we wait; after it, we look for the
 * invoice by our reference. Two found, or none: a person decides, because "not found" is not proof that the
 * first request will never land.
 * Otherwise one conditional write claims the create, and only the winner calls the provider.
 * If the run moved meanwhile and nobody waits for the invoice (the run was cancelled), it is taken back. If
 * that fails, the invoice is still payable for a run that is over: an error names it, for a person to cancel.
 */
export async function issueInvoice(runId: string): Promise<void> {
  let run = await col.runs().findOne({ _id: runId });
  if (!run || run.status !== 'created' || run.review) return;
  if (run.invoiceCents === 0) run = await decideAmount(run);

  let invoice: RemoteInvoice | null = null;
  if (run.invoiceAttemptedAt) {
    const wait = run.invoiceAttemptedAt.getTime() + config.batchLeaseMs - Date.now();
    if (wait > 0) throw new Later(wait / 1000, 'another execution may still be creating this invoice');
    const found = await oncade.findInvoices(runId);
    if (!found.ok) throw new Later(10, `invoice lookup: ${found.outcome.kind}`);
    if (found.value.length > 1) return park(runId, 'duplicate_invoices_at_provider');
    invoice = found.value[0] ?? null;
    if (!invoice) return park(runId, 'invoice_outcome_unknown');
  }

  if (!invoice) {
    const claim = await col
      .runs()
      .updateOne(
        { _id: runId, status: 'created', invoiceAttemptedAt: run.invoiceAttemptedAt ?? { $exists: false } },
        { $set: { invoiceAttemptedAt: new Date() } },
      );
    if (claim.modifiedCount !== 1) throw new Later(5, 'another execution claimed this invoice');

    const created = await oncade.createInvoice({ runId, client: run.client, amountCents: run.invoiceCents });
    if (!created.ok) {
      if (nextStep(created.outcome, { creates: true }) === 'give_up') return park(runId, 'invoice_rejected');
      if (neverHappened(created.outcome)) {
        await col.runs().updateOne({ _id: runId, status: 'created' }, { $unset: { invoiceAttemptedAt: '' } });
      }
      throw new Later(10, `invoice create: ${created.outcome.kind}`);
    }
    invoice = created.value;
  }

  const issued = invoice;
  const moved = await inTransaction((session) =>
    moveRun(session, runId, 'created', 'awaiting_funds', 'invoice issued', {
      invoice: { id: issued.id, url: issued.url },
    }),
  );
  if (moved) {
    m.runTransitions.add(1, { to: 'awaiting_funds' });
    log.info('run.invoiced', { run_reference: runId, invoice_cents: run.invoiceCents });
    return;
  }

  const now = await col.runs().findOne({ _id: runId }, { projection: { invoice: 1 } });
  if (now?.invoice?.id === issued.id) return;
  const undone = await oncade.cancelInvoice(issued.id);
  if (undone.ok && undone.value.status === 'cancelled') log.warn('run.invoice_undone', { run_reference: runId });
  else log.error('run.invoice_left_open', { run_reference: runId, invoice: issued.id });
}
