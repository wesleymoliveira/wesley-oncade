// Failure drills: cause a failure in the running system, then read from
// Prometheus the number that moved and the state of the alert that watches
// it. A signal nobody saw arrive is not observability.
//
//   npm run drill            all five
//   npm run drill -- 2 4     only some
//
// Needs: `docker compose up -d`, `npm run stand-in`, and the API
// (`npm run dev` or `npm run start`). Stop `npm run worker` first: the
// drills start, kill and restart their own worker.

import { spawn, type ChildProcess } from 'node:child_process';
import { ack, publish, receiveDeadLetters } from '../lib/infra/queue.ts';
import { closeDb } from '../lib/infra/db.ts';
import { api, newReference, payroll, requireRunning, standIn, startClean, view, waitFor } from './lib/app.ts';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9091';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Prometheus -------------------------------------------------------------

async function prom(query: string): Promise<number> {
  const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(query)}`);
  const body = (await res.json()) as { data: { result: { value: [number, string] }[] } };
  return Number(body.data.result[0]?.value[1] ?? 0);
}

async function alertState(name: string): Promise<string> {
  const res = await fetch(`${PROMETHEUS}/api/v1/rules`);
  const body = (await res.json()) as { data: { groups: { rules: { name: string; state: string }[] }[] } };
  return body.data.groups.flatMap((group) => group.rules).find((rule) => rule.name === name)?.state ?? 'unknown';
}

const alertBecomes = (name: string, state: string, timeoutMs = 60_000) =>
  waitFor(
    `alert ${name} to be ${state}`,
    () => alertState(name),
    (now) => now === state,
    timeoutMs,
  ).then(
    () => true,
    () => false,
  );

/** Metrics travel for a few seconds before Prometheus has them: wait before reading. */
const settle = () => sleep(10_000);

/** How much a counter grew since `since`, read from Prometheus. */
const grew = (selector: string, since: number) =>
  prom(`sum(increase(${selector}[${Math.ceil((Date.now() - since) / 1000) + 15}s]))`).then(Math.round);

// ---- the worker the drills own ---------------------------------------------

let worker: ChildProcess | undefined;

function startWorker(): void {
  worker = spawn(process.execPath, ['--env-file-if-exists=.env', 'worker/main.ts'], {
    env: {
      ...process.env,
      SWEEP_INTERVAL_MS: '2000',
      BATCH_LEASE_MS: '4000',
      BREAKER_THRESHOLD: '3',
      BREAKER_COOL_DOWN_MS: '4000',
      METRIC_INTERVAL_MS: '2000',
      ONCADE_TIMEOUT_MS: '60000',
    },
    stdio: 'ignore',
  });
}

async function stopWorker(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const child = worker;
  worker = undefined;
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  await gone;
}

// ---- reporting --------------------------------------------------------------

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}
const check = (label: string, ok: boolean, detail: string | number = ''): Check => ({
  label,
  ok,
  detail: String(detail),
});

/** State of every alert just before a drill starts. */
let alertsBefore: Record<string, string> = {};

async function readAlerts(): Promise<Record<string, string>> {
  const res = await fetch(`${PROMETHEUS}/api/v1/rules`);
  const body = (await res.json()) as { data: { groups: { rules: { name: string; state: string }[] }[] } };
  return Object.fromEntries(body.data.groups.flatMap((group) => group.rules).map((rule) => [rule.name, rule.state]));
}

/** An alert proves something only if it was quiet before the failure and fired after it. */
function alertCheck(name: string, fired: boolean): Check {
  const before = alertsBefore[name] ?? 'unknown';
  const hint = before === 'inactive' ? '' : ' (it was not quiet before the drill: wait two minutes and run again)';
  return check(
    `alert ${name}: ${before} → ${fired ? 'firing' : 'not firing'}`,
    fired && before === 'inactive',
    hint.trim(),
  );
}

async function newRun(people: number): Promise<string> {
  const reference = newReference('DRILL');
  const created = await api('/api/runs', {
    method: 'POST',
    body: payroll(reference, people),
    key: `drill-${reference}`,
  });
  if (created.status !== 201) throw new Error(`create run answered ${created.status}`);
  return reference;
}
const untilStatus = (reference: string, status: string, timeoutMs = 60_000) =>
  waitFor(
    `${reference} to be ${status}`,
    () => view(reference),
    (v) => v.status === status,
    timeoutMs,
  );
const atProvider = async (reference: string) =>
  ((await standIn('state')).distributions as { memo: string; status: string }[]).filter((d) =>
    d.memo.includes(reference),
  );

// ---- the drills -------------------------------------------------------------

/** 1. The worker dies after the provider received the batch and before we saved the answer. */
async function workerDiesAfterSending(): Promise<Check[]> {
  const started = Date.now();
  const reference = await newRun(20);
  await untilStatus(reference, 'awaiting_funds');
  // The provider creates the distribution, then keeps us waiting for the answer.
  await standIn('fault', { path: 'distributions', mode: 'hold', holdMs: 120_000, count: 1 });
  await standIn('pay-invoice', { reference });
  await waitFor(
    'the distribution to exist at the provider',
    () => atProvider(reference),
    (d) => d.length === 1,
  );
  await stopWorker('SIGKILL'); // dies with the call in flight

  const stuck = (await view(reference)).batches[0]!.status;
  const alertFired = await alertBecomes('CheckStopped', 'firing');
  startWorker();
  const recovered = await waitFor(
    'the batch to be recovered',
    () => view(reference),
    (v) => v.batches[0]!.status === 'sent',
    60_000,
  );
  const provider = await atProvider(reference);
  const alertCleared = await alertBecomes('CheckStopped', 'inactive');
  await settle();
  return [
    check('batch left in "sending" when the worker died', stuck === 'sending', stuck),
    alertCheck('CheckStopped', alertFired),
    check(
      'batch recovered without sending again',
      recovered.batches[0]!.status === 'sent',
      'found at the provider by our reference',
    ),
    check('distributions at the provider for this batch', provider.length === 1, provider.length),
    check(
      'batches_transitions_total{to="sent"} grew by',
      (await grew('batches_transitions_total{to="sent"}', started)) === 1,
      await grew('batches_transitions_total{to="sent"}', started),
    ),
    check('alert CheckStopped cleared after the restart', alertCleared, alertCleared ? 'inactive' : 'still firing'),
  ];
}

/** 2. The provider is unreachable for longer than three redeliveries. */
async function providerUnreachable(): Promise<Check[]> {
  const started = Date.now();
  await standIn('unplug', { seconds: 60 });
  const reference = await newRun(20); // our API still answers: it never calls the provider
  const fired = await alertBecomes('ProviderBreakerOpen', 'firing', 40_000);
  const whileDown = (await view(reference)).status;
  const invoiced = await untilStatus(reference, 'awaiting_funds', 120_000).then(
    () => true,
    () => false,
  );
  await alertBecomes('ProviderBreakerOpen', 'inactive', 30_000);
  const later = await grew('queue_handled_total{outcome="later"}', started);
  const deadLetters = await prom(
    `max_over_time(queue_messages{state="dead_letter"}[${Math.ceil((Date.now() - started) / 1000) + 5}s])`,
  );
  await settle();
  return [
    check('run accepted while the provider was down', whileDown === 'created', whileDown),
    alertCheck('ProviderBreakerOpen', fired),
    // The dead-letter limit is 3 receives. The message was put back at least
    // 3 times and then handled: left on the queue as one message, that last
    // receive would have dead-lettered it.
    check('put back as "later" during the outage (3 or more), then handled', later >= 3 && invoiced, later),
    check('dead letters during the outage', deadLetters === 0, deadLetters),
    check('run went on by itself when the provider came back', invoiced, (await view(reference)).status),
    check('breaker closed again', (await prom('max(breaker_state)')) === 0, await prom('max(breaker_state)')),
  ];
}

/** 3. The provider refuses one of three batches. */
async function someBatchesFail(): Promise<Check[]> {
  const started = Date.now();
  const reference = await newRun(60);
  await untilStatus(reference, 'awaiting_funds');
  await standIn('fault', { path: 'distributions', mode: 'refuse', status: 400, code: 'INVALID_RECIPIENT', count: 1 });
  await standIn('pay-invoice', { reference });
  await waitFor(
    'two batches sent and one failed',
    () => view(reference),
    (v) => v.batches.filter((b) => b.status === 'sent').length === 2 && v.batches.some((b) => b.status === 'failed'),
  );
  await standIn('pay-distributions', { reference });
  const partial = await untilStatus(reference, 'partially_failed');

  const retry = await api(`/api/runs/${reference}/retry-failed`, { method: 'POST' });
  await waitFor(
    'the retry batch to be sent',
    () => view(reference),
    (v) => v.batches.some((b) => b.id.includes('/a2/') && b.status === 'sent'),
  );
  await standIn('pay-distributions', { reference });
  const done = await untilStatus(reference, 'completed');
  const provider = await atProvider(reference);
  await settle();
  return [
    check(
      'run ended partially_failed',
      partial.status === 'partially_failed',
      `${partial.people.paid} paid, ${partial.people.unpaid} unpaid`,
    ),
    check(
      'batches_transitions_total{to="failed"} grew by',
      (await grew('batches_transitions_total{to="failed"}', started)) === 1,
      await grew('batches_transitions_total{to="failed"}', started),
    ),
    check(
      '"retry failed" made a new batch for the unpaid people only',
      retry.status === 202 && retry.body.people === 20,
      `${retry.body.batches} batch, ${retry.body.people} people`,
    ),
    check(
      'everyone paid exactly once',
      done.people.paid === 60 && done.ledger.owedToPeopleCents === 0,
      `${done.people.paid} paid, owed ${done.ledger.owedToPeopleCents}`,
    ),
    check(
      'distributions at the provider (2 + 1 retry, no repeat)',
      provider.length === 3 && new Set(provider.map((d) => d.memo)).size === 3,
      provider.length,
    ),
  ];
}

/** 4. Webhooks: one never arrives, one arrives twice, one is forged. */
async function webhooksMisbehave(): Promise<Check[]> {
  const started = Date.now();
  const [lost, twice, forged] = [await newRun(20), await newRun(20), await newRun(20)];
  for (const reference of [lost, twice, forged]) await untilStatus(reference, 'awaiting_funds');

  await standIn('pay-invoice', { reference: lost, webhook: false });
  const found = await waitFor(
    'the lost payment to be found',
    () => view(lost),
    (v) => v.funding !== null,
  );

  const repeated = await standIn('pay-invoice', { reference: twice, repeat: 2 });
  await waitFor(
    'the repeated payment to be recorded',
    () => view(twice),
    (v) => v.funding !== null,
  );

  const tampered = await standIn('pay-invoice', { reference: forged, tamper: true });
  const pathAlert = await alertBecomes('WebhookPathBroken', 'firing');
  const forgedAlert = await alertBecomes('ForgedWebhook', 'firing');
  await settle();
  return [
    check('lost webhook: payment found by reading the provider', found.funding!.path === 'pull', found.funding!.path),
    check(
      'funding_recorded_total{path="pull"} grew by at least',
      (await grew('funding_recorded_total{path="pull"}', started)) >= 1,
      await grew('funding_recorded_total{path="pull"}', started),
    ),
    alertCheck('WebhookPathBroken', pathAlert),
    check(
      'repeated webhook: both answered 200',
      String(repeated.webhookStatuses) === '200,200',
      repeated.webhookStatuses,
    ),
    check(
      'webhooks_received_total{outcome="duplicate"} grew by',
      (await grew('webhooks_received_total{outcome="duplicate"}', started)) === 1,
      await grew('webhooks_received_total{outcome="duplicate"}', started),
    ),
    check('forged webhook answered 401', String(tampered.webhookStatuses) === '401', tampered.webhookStatuses),
    check(
      'webhooks_received_total{outcome="bad_signature"} grew by',
      (await grew('webhooks_received_total{outcome="bad_signature"}', started)) === 1,
      await grew('webhooks_received_total{outcome="bad_signature"}', started),
    ),
    alertCheck('ForgedWebhook', forgedAlert),
  ];
}

/** 5. A message that can never succeed. */
async function poisonMessage(): Promise<Check[]> {
  await publish(JSON.stringify({ id: 'drill', type: 'no.such.step', payload: {} }));
  const healthy = await newRun(20); // good work must keep flowing meanwhile
  const fired = await alertBecomes('DeadLetters', 'firing', 90_000);
  const depth = await prom('max(queue_messages{state="dead_letter"})');
  const flowed = await untilStatus(healthy, 'awaiting_funds').then(
    () => true,
    () => false,
  );
  const dead = await receiveDeadLetters();
  for (const message of dead) await ack(message, 'deadLetter'); // a person looked at it and dropped it
  const cleared = await alertBecomes('DeadLetters', 'inactive');
  await settle();
  return [
    check(
      'message moved to the dead-letter queue after 3 receives',
      depth === 1,
      `queue_messages{state="dead_letter"} = ${depth}`,
    ),
    alertCheck('DeadLetters', fired),
    check('other work kept flowing', flowed, (await view(healthy)).status),
    check('dead letter inspected and dropped', dead.length === 1, dead[0]?.body.slice(0, 60) ?? ''),
    check('alert DeadLetters cleared', cleared, cleared ? 'inactive' : 'still firing'),
  ];
}

// ---- main -------------------------------------------------------------------

const drills: [string, () => Promise<Check[]>][] = [
  ['1. The worker dies after sending a batch, before saving the answer', workerDiesAfterSending],
  ['2. The provider is unreachable', providerUnreachable],
  ['3. The provider refuses one of three batches', someBatchesFail],
  ['4. Webhooks: one lost, one repeated, one forged', webhooksMisbehave],
  ['5. A poison message', poisonMessage],
];

const wanted = process.argv.slice(2).map(Number);
if (wanted.some((n) => !Number.isInteger(n) || n < 1 || n > drills.length)) {
  console.error(`usage: npm run drill [-- <numbers from 1 to ${drills.length}>]`);
  process.exit(2);
}
await requireRunning({ worker: false });

let failed = 0;
await startClean();
startWorker();
await sleep(8_000); // let the fresh worker report its zero counters to Prometheus
try {
  for (const [index, [title, run]] of drills.entries()) {
    if (wanted.length > 0 && !wanted.includes(index + 1)) continue;
    console.log(`\n${title}`);
    alertsBefore = await readAlerts();
    const checks = await run().catch((err: unknown) => [
      check('drill ran to the end', false, err instanceof Error ? err.message : 'error'),
    ]);
    for (const c of checks) {
      console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
      if (!c.ok) failed += 1;
    }
    if (!worker) startWorker();
  }
} finally {
  await stopWorker();
  await closeDb();
}
console.log(failed === 0 ? '\nAll drills passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
