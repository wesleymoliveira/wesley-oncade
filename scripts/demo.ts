// The whole story against the local stand-in: a BPO bills its client and
// pays 300 people in 15 batches.
//
//   npm run demo            300 people
//   npm run demo -- 45      another size

import { closeDb } from '../lib/infra/db.ts';
import { api, newReference, payroll, requireRunning, standIn, startClean, usd, view, waitFor } from './lib/app.ts';

const count = Number(process.argv[2] ?? 300);
if (!Number.isInteger(count) || count < 1 || count > 2_000) {
  console.error('usage: npm run demo [-- <people, 1 to 2000>]');
  process.exit(2);
}
const reference = newReference();
const say = (step: string, detail = '') => console.log(`${step.padEnd(32)} ${detail}`);

await requireRunning({ worker: true });
await startClean(); // empty stand-in and local database, so the counts below are this run's
const body = payroll(reference, count);
const created = await api('/api/runs', { method: 'POST', body, key: `demo-${reference}` });
if (created.status !== 201) throw new Error(`create run answered ${created.status}: ${JSON.stringify(created.body)}`);
say('1. run created', `${reference}: ${count} people, payroll ${usd(created.body.payrollCents)}`);

const again = await api('/api/runs', { method: 'POST', body, key: `demo-${reference}` });
say('   same request again', `${again.status}, replayed: ${again.body.replayed === true}`);

const invoiced = await waitFor(
  'invoice issued',
  () => view(reference),
  (v) => v.status === 'awaiting_funds',
);
say(
  '2. invoice sent to the client',
  `${usd(invoiced.money.invoiceCents)} = payroll + ${usd(invoiced.money.feeReserveCents)} fee reserve + ${usd(invoiced.money.marginCents)} margin`,
);

await standIn('pay-invoice', { reference });
const funded = await waitFor(
  'funding recorded',
  () => view(reference),
  (v) => v.funding !== null,
);
say('3. client paid', `${funded.funding!.label}, found by: ${funded.funding!.path}`);

const sent = await waitFor(
  'every batch sent',
  () => view(reference),
  (v) => v.batches.every((b) => b.status === 'sent'),
  120_000,
);
say(
  '4. batches at the provider',
  `${sent.batches.length} distributions of up to 20 people, owed to people: ${usd(sent.ledger.owedToPeopleCents)}`,
);

await standIn('pay-distributions', { reference });
const done = await waitFor(
  'run completed',
  () => view(reference),
  (v) => v.status === 'completed',
  120_000,
);
say(
  '5. everyone paid',
  `${done.people.paid} of ${count} people, owed to people: ${usd(done.ledger.owedToPeopleCents)}`,
);

const provider = await waitFor(
  'the customer to be told',
  () => standIn('state'),
  (s) => s.sink.events.includes('run.completed'),
  20_000,
);
await closeDb();
say('   paid twice?', `${provider.duplicateMemos.length} duplicate distributions at the provider`);
say('   customer told', `${provider.sink.delivered} signed webhooks: ${[...new Set(provider.sink.events)].join(', ')}`);
console.log(`\nTimeline:  npm run where -- ${reference}`);
