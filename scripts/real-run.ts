// One small run of three people through the whole pipeline: our API, the
// queue, the worker and the provider. Then the run is cancelled, and the
// script checks that nothing is left open at the provider.
//
//   npm run real-run               against the local stand-in: a rehearsal
//   npm run real-run:oncade        against the Oncade test API
//   ... -- --pay                   nothing simulated, nothing cancelled: a person pays the invoice
//                                  and the payout at the provider, and the run must end completed
//
// Against the Oncade test API it is the real thing: a real invoice sent to
// DEMO_CLIENT_EMAIL and a real distribution of three people (payoutPath
// "dashboard": we move no money). For that, the API and the worker must be
// running with `npm run start:oncade` and `npm run worker:oncade`, and .env
// must hold addresses you read.
//
// Without --pay the client's payment is SIMULATED: recorded by an operator
// command, with a reason, in its own cash account. It shows as simulated
// everywhere and is undone on cancel. With --pay the money is the
// provider's test money: USDC on Base Sepolia, from a public faucet.

import { config } from '../lib/config.ts';
import { batchId } from '../lib/core/batches.ts';
import { simulateFunding } from '../lib/flows/fund.ts';
import { closeDb } from '../lib/infra/db.ts';
import { oncade } from '../lib/oncade/client.ts';
import { addresses } from './lib/addresses.ts';
import { api, newReference, requireRunning, standIn, usd, view, waitFor } from './lib/app.ts';

const say = (step: string, detail = '') => console.log(`${step.padEnd(40)} ${detail}`);
const settled = (status: string) => status !== 'pending' && status !== 'sending';
const pay = process.argv.includes('--pay');

async function enter(prompt: string): Promise<void> {
  console.log(`\n${prompt} Enter goes on.`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));
  process.stdin.pause();
}

/** A step only a person can do at the provider. In a rehearsal the stand-in does it. */
async function person(prompt: string, standInAction: string, reference: string): Promise<void> {
  if (config.usingStandIn) await standIn(standInAction, { reference });
  else await enter(prompt);
}

await requireRunning({ worker: true });

const who = config.usingStandIn
  ? {
      client: 'ap@client.example.com',
      team: ['ana', 'bia', 'caio'].map((n) => `${n}@staff.example.com`),
      note: 'example addresses',
    }
  : addresses();

const reference = newReference('REAL');
// The run has one batch, and its id is known before anything is sent.
const reference1 = batchId(reference, 1, 1);
console.log(`provider: ${config.usingStandIn ? 'local stand-in (a rehearsal)' : 'Oncade test API'}`);
console.log(`addresses: ${who.note}\n`);

let failure: unknown;
try {
  const created = await api('/api/runs', {
    method: 'POST',
    key: `real-run-${reference}`,
    body: {
      reference,
      client: { name: 'Payout run check', email: who.client },
      marginCents: 0,
      people: who.team.map((email, i) => ({ name: `Person ${i + 1}`, email, amountCents: (i + 1) * 100 })),
    },
  });
  if (created.status !== 201) throw new Error(`create run answered ${created.status}: ${JSON.stringify(created.body)}`);
  say('1. run created through our API', `${reference}, 3 people, ${usd(created.body.payrollCents)}`);

  const invoiced = await waitFor(
    'the invoice',
    () => view(reference),
    (v) => v.status !== 'created' || v.review !== null,
    90_000,
  );
  if (invoiced.status !== 'awaiting_funds')
    throw new Error(`the invoice was not issued: ${invoiced.review?.kind ?? invoiced.status}`);
  say('2. invoice issued at the provider', `${usd(invoiced.money.invoiceCents)}, sent to the client address`);

  if (pay) await person('Pay the invoice at the provider, from the test balance.', 'pay-invoice', reference);
  else await simulateFunding(reference, 'test mode: the invoice was not paid');
  const funded = await waitFor(
    'the funding',
    () => view(reference),
    (v) => v.funding !== null,
    pay ? 600_000 : undefined,
  );
  say('3. client payment', `${funded.funding!.label}, found by: ${funded.funding!.path}`);

  const sent = await waitFor(
    'the batch',
    () => view(reference),
    (v) => v.batches.every((b) => settled(b.status)),
    120_000,
  );
  const batch = sent.batches[0]!;
  say(
    '4. batch at the provider',
    `${batch.status}${batch.problem ? `: ${batch.problem}` : ''}, fee ${usd(batch.feeCents ?? 0)}`,
  );
  const atProvider = await oncade.findDistributions(batch.id);
  say(
    '   found there by our reference',
    atProvider.ok
      ? atProvider.value.map((d) => `${d.status}, ${d.lines.length} people, ${usd(d.totalCents)}`).join(' | ') || 'none'
      : `could not read: ${atProvider.outcome.kind}`,
  );

  if (pay) {
    await person('Pay the payout at the provider, from the test balance.', 'pay-distributions', reference);
    const done = await waitFor(
      'the payout',
      () => view(reference),
      (v) => v.status === 'completed' || v.batches.some((b) => b.status === 'parked'),
      600_000,
    );
    say('5. payout', `run ${done.status}, ${done.people.paid} of ${who.team.length} people paid`);
    say('   books', `owed to people ${usd(done.ledger.owedToPeopleCents)}`);
    if (done.status !== 'completed')
      throw new Error('the run did not complete: its timeline says why (the `where` script)');
    await closeDb();
    process.exit(0);
  }

  const cancel = await api(`/api/runs/${reference}/cancel`, { method: 'POST' });
  say('5. cancel requested', `answered ${cancel.status}`);
  const ended = await waitFor(
    'the cancel',
    () => view(reference),
    (v) => v.status !== 'cancelling',
    120_000,
  );
  say('   run', `${ended.status}${ended.cancel?.refused ? `, cancel refused: ${ended.cancel.refused}` : ''}`);
  say(
    '   books',
    `owed to people ${usd(ended.ledger.owedToPeopleCents)}, refund due ${usd(ended.ledger.refundDueCents)}`,
  );
} catch (err) {
  failure = err;
  console.error(`\nstopped: ${err instanceof Error ? err.message : String(err)}`);
  const asked = await api(`/api/runs/${reference}/cancel`, { method: 'POST' }).catch(() => null);
  say('   cancel asked of our own API', asked ? `answered ${asked.status}` : 'no answer');
}

// Last resort, whatever happened above: if the pipeline left something
// open, cancel it by a direct call, so a failed run never leaves a sent
// invoice or a live distribution.
const leftInvoices = await oncade.findInvoices(reference);
for (const invoice of leftInvoices.ok ? leftInvoices.value : []) {
  const undone = await oncade.cancelInvoice(invoice.id);
  say('   direct cancel of an open invoice', undone.ok ? undone.value.status : undone.outcome.kind);
}
const leftDistributions = await oncade.findDistributions(reference1);
for (const distribution of leftDistributions.ok ? leftDistributions.value : []) {
  if (distribution.status !== 'pending' && distribution.status !== 'draft') continue;
  const undone = await oncade.cancelDistribution(distribution.id);
  say('   direct cancel of an open distribution', undone.ok ? undone.value.status : undone.outcome.kind);
}

// What is left open at the provider? Asked of the provider, not of our database.
const invoices = await oncade.findInvoices(reference);
const distributions = await oncade.findDistributions(reference1);
say(
  '6. open invoices at the provider',
  invoices.ok ? String(invoices.value.length) : `could not read: ${invoices.outcome.kind}`,
);
say(
  '   the distribution at the provider',
  distributions.ok
    ? distributions.value.map((d) => d.status).join(', ') || 'not found by our reference'
    : `could not read: ${distributions.outcome.kind}`,
);
await closeDb();
const stillOpen =
  !invoices.ok ||
  invoices.value.length > 0 ||
  !distributions.ok ||
  distributions.value.some((d) => d.status === 'pending' || d.status === 'draft');
if (failure || stillOpen) process.exit(1);
