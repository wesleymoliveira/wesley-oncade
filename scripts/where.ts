// "Where is my payment?" The timeline of one run, as a support engineer needs it.
//
//   npm run where -- <reference>

import { requireRunning, usd, view } from './lib/app.ts';

const reference = process.argv[2];
if (!reference) {
  console.error('usage: npm run where -- <reference>');
  process.exit(2);
}
await requireRunning();
const run = await view(reference);
if (!run?.reference) {
  console.error(`no run "${reference}"`);
  process.exit(1);
}
const grafana = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3301';
const explore = (datasource: string, query: Record<string, string>) =>
  `${grafana}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify({ a: { datasource, queries: [{ refId: 'A', ...query }], range: { from: 'now-6h', to: 'now' } } }))}`;

console.log(`\n${run.reference}   ${run.status.toUpperCase()}`);
if (run.review) console.log(`  NEEDS A PERSON: ${run.review.kind}`);
if (run.cancel?.refused) console.log(`  cancel refused: ${run.cancel.refused}`);

console.log('\n  Money');
console.log(
  `    invoice     ${usd(run.money.invoiceCents)}  (payroll ${usd(run.money.payrollCents)} + fee reserve ${usd(run.money.feeReserveCents)} + margin ${usd(run.money.marginCents)})`,
);
const funding = run.funding
  ? `${run.funding.label}, ${usd(run.funding.receivedCents)}, found by ${run.funding.path}`
  : 'not yet';
console.log(`    funding     ${funding}`);
if (run.funding?.reason) console.log(`                reason: ${run.funding.reason}`);
console.log(
  `    still owed  ${usd(run.ledger.owedToPeopleCents)} to people, ${usd(run.ledger.feeReserveLeftCents)} fee reserve left`,
);
if (run.ledger.refundDueCents)
  console.log(`    REFUND DUE  ${usd(run.ledger.refundDueCents)} to the client: send it back by hand`);

console.log(`\n  People    ${run.people.paid} paid, ${run.people.assigned} in a batch, ${run.people.unpaid} unpaid`);
const byStatus = new Map<string, number>();
for (const batch of run.batches) byStatus.set(batch.status, (byStatus.get(batch.status) ?? 0) + 1);
console.log(`  Batches   ${[...byStatus].map(([status, n]) => `${n} ${status}`).join(', ') || 'none'}`);
for (const batch of run.batches.filter((b) => b.problem))
  console.log(`    ${batch.id}  ${batch.status}: ${batch.problem}`);

console.log('\n  Timeline');
for (const step of run.history) {
  console.log(`    ${step.at.slice(11, 19)}  ${(step.from ?? '·').padEnd(16)} → ${step.to.padEnd(16)}  ${step.cause}`);
}

console.log('\n  In Grafana');
console.log(
  `    traces  ${explore('tempo', { queryType: 'traceql', query: `{ span.run.reference = "${run.reference}" }` })}`,
);
console.log(
  `    logs    ${explore('loki', { expr: `{service_namespace="payout-runs"} | run_reference="${run.reference}"` })}`,
);
console.log('');
