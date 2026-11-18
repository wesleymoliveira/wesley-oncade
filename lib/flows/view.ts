// What a person needs to answer "where is my payment?": the run, its money,
// its people (counted, never named), its batches and its history.

import { account } from '../core/ledger.ts';
import { col, peopleCount, runBalances } from '../infra/store.ts';

export async function viewRun(runId: string) {
  const run = await col.runs().findOne({ _id: runId });
  if (!run) return null;
  const [batches, people, balances] = await Promise.all([
    col.batches().find({ runId }).sort({ _id: 1 }).toArray(),
    peopleCount(runId),
    runBalances(runId),
  ]);
  const owedToPeople = Object.entries(balances)
    .filter(([name]) => name.startsWith('payable:'))
    .reduce((total, [, cents]) => total - cents, 0);
  return {
    reference: run._id,
    status: run.status,
    // Simulated funding is never shown as money received.
    funding: run.funding
      ? {
          label:
            run.funding.source === 'provider'
              ? 'received, confirmed by the provider'
              : 'SIMULATED by an operator, not received',
          source: run.funding.source,
          path: run.funding.path,
          receivedCents: run.funding.receivedCents,
          reason: run.funding.reason ?? null,
        }
      : null,
    review: run.review ?? null,
    cancel: run.cancel ?? null,
    money: {
      payrollCents: run.payrollCents,
      feeReserveCents: run.feeReserveCents,
      marginCents: run.marginCents,
      invoiceCents: run.invoiceCents,
    },
    ledger: {
      owedToPeopleCents: owedToPeople,
      feeReserveLeftCents: -(balances[account.fees(runId)] ?? 0),
      marginCents: -(balances[account.margin(runId)] ?? 0),
      refundDueCents: -(balances[account.refundDue(runId)] ?? 0),
    },
    people,
    batches: batches.map((batch) => ({
      id: batch._id,
      status: batch.status,
      people: batch.payeeIds.length,
      totalCents: batch.totalCents,
      feeCents: batch.distribution?.feeCents ?? null,
      problem: batch.problem?.reason ?? null,
      traceId: batch.history.at(-1)?.traceId ?? null,
    })),
    history: run.history.map((step) => ({
      at: step.at.toISOString(),
      from: step.from,
      to: step.to,
      cause: step.cause,
      traceId: step.traceId ?? null,
    })),
  };
}

export type RunView = NonNullable<Awaited<ReturnType<typeof viewRun>>>;
