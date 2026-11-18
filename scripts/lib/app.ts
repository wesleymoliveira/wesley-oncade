// Shared by the scripts: talk to our API, to the stand-in's switches, and wait.

import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { config } from '../../lib/config.ts';
import { formatUsd } from '../../lib/core/money.ts';
import { ack, receive, receiveDeadLetters } from '../../lib/infra/queue.ts';
import { col } from '../../lib/infra/store.ts';
import type { RunView } from '../../lib/flows/view.ts';

type Setup = typeof config.setup;

/** The worker of this folder, if one is alive. It leaves its process id and its setup in a file. */
function runningWorker(): { pid: number; setup: Setup } | null {
  const pidFile = '.local/worker.pid';
  if (!existsSync(pidFile)) return null;
  try {
    const worker = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; setup: Setup };
    process.kill(worker.pid, 0); // signal 0 only asks "are you there?"
    return worker;
  } catch {
    return null; // a stale file: that worker is gone
  }
}

/** What the running API says it is pointed at. Null when it does not answer, or answers something that is not JSON. */
const apiHealth = (): Promise<{ setup?: Setup } | null> =>
  fetch(`${config.appUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.json() as Promise<{ setup?: Setup }>)
    .catch(() => null);

const describe = (setup: Setup | undefined): string =>
  setup ? `${setup.provider}, database ${setup.database}, queue ${setup.queue}` : 'an older build: restart it';

const sameSetup = (other: Setup | undefined): boolean =>
  other?.provider === config.setup.provider &&
  other.database === config.setup.database &&
  other.queue === config.setup.queue;

const answers = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );

const listens = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 2_000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

/**
 * Before a script touches anything: is every part it needs running? If
 * not, name what is missing and the command that starts it, and stop.
 * `worker: true` needs one running; `worker: false` needs none (the drills
 * start their own). Then: is this script pointed at the same provider,
 * database and queue as the API and the worker? A script set for the
 * stand-in must never drive an API that is talking to Oncade.
 */
export async function requireRunning(needs: { worker?: boolean } = {}): Promise<void> {
  const mongo = new URL(config.mongoUrl);
  const [mongoUp, queueUp, standInUp, health] = await Promise.all([
    listens(mongo.hostname, Number(mongo.port || 27017)),
    answers(config.queueEndpoint),
    config.usingStandIn ? answers(config.standInUrl) : true,
    apiHealth(),
  ]);
  const worker = runningWorker();
  const missing: [string, string][] = [];
  if (!mongoUp || !queueUp) missing.push(['MongoDB and the queue', 'docker compose up -d --wait']);
  if (!standInUp) missing.push([`the stand-in, ${new URL(config.standInUrl).host}`, 'npm run stand-in']);
  const oncade = config.usingStandIn ? '' : ':oncade';
  if (!health) missing.push([`the API, ${new URL(config.appUrl).host}`, `npm run build && npm run start${oncade}`]);
  if (needs.worker === true && !worker) missing.push(['the worker', `npm run worker${oncade}`]);
  if (needs.worker === false && worker) {
    console.error('A worker is already running. Stop it first: the drills run their own.');
    process.exit(2);
  }
  if (missing.length > 0) {
    const width = Math.max(...missing.map(([what]) => what.length));
    console.error('Not running yet:');
    for (const [what, command] of missing) console.error(`  ${what.padEnd(width)}   ${command}`);
    console.error('Start each one in its own terminal, then run this again.');
    process.exit(1);
  }

  const others: [string, Setup | undefined][] = [['the API', health?.setup]];
  if (worker) others.push(['the worker', worker.setup]);
  if (others.every(([, setup]) => sameSetup(setup))) return;
  console.error('This script is not pointed at what is running:');
  console.error(`  this script     ${describe(config.setup)}`);
  for (const [what, setup] of others) console.error(`  ${what.padEnd(13)}   ${describe(setup)}`);
  console.error('The stand-in: `npm run start`, `npm run worker` and the plain script.');
  console.error('The Oncade test API: the same three with `:oncade` after the name. Nothing was created.');
  process.exit(1);
}

export async function api(
  path: string,
  init: { method?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${config.appUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${config.appToken}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.key ? { 'idempotency-key': init.key } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A switch of the stand-in. Refuses to run against anything else. */
export async function standIn(action: string, body: unknown = {}): Promise<any> {
  if (!config.usingStandIn) throw new Error('this script only works with the local stand-in');
  const res = await fetch(`${config.standInUrl}/__control/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * An empty stand-in, an empty local database and empty queues, so the
 * numbers a script prints are its own. Local demo data only.
 */
export async function startClean(): Promise<void> {
  if (!config.usingStandIn || !config.mongoUrl.includes('127.0.0.1')) {
    throw new Error('refusing to wipe anything that is not the local demo');
  }
  await standIn('reset');
  await Promise.all(Object.values(col).map((collection) => collection().deleteMany({})));
  for (let batch = await receive(0); batch.length > 0; batch = await receive(0)) for (const m of batch) await ack(m);
  for (const m of await receiveDeadLetters()) await ack(m, 'deadLetter');
}

export const view = async (reference: string): Promise<RunView> =>
  (await api(`/api/runs/${reference}`)).body as RunView;

export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** A payroll of `count` made-up people. example.com never receives mail. */
export function payroll(reference: string, count: number) {
  return {
    reference,
    client: { name: 'Acme Outsourcing Client', email: 'ap@client.example.com' },
    marginCents: 500_00,
    people: Array.from({ length: count }, (_, i) => ({
      name: `Staff ${String(i + 1).padStart(3, '0')}`,
      email: `staff${String(i + 1).padStart(3, '0')}@staff.example.com`,
      amountCents: 400_00 + ((i * 37) % 200) * 100,
    })),
  };
}

export const newReference = (prefix = 'PR') =>
  `${prefix}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export const usd = (cents: number) => `$${formatUsd(cents)}`;
