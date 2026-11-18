// Helpers for the flow tests. No mocks: real MongoDB, real queue, the stand-in.

import { config } from '../../lib/config.ts';
import { balanceDrift } from '../../lib/core/ledger.ts';
import { sign } from '../../lib/core/webhook.ts';
import { createRun } from '../../lib/flows/create-run.ts';
import { Later } from '../../lib/flows/later.ts';
import { handle, relay, type Message } from '../../lib/flows/work.ts';
import { ack, receive, receiveDeadLetters } from '../../lib/infra/queue.ts';
import { col, ensureIndexes } from '../../lib/infra/store.ts';
import { resetBreaker } from '../../lib/oncade/client.ts';

export async function standIn(action: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${config.standInUrl}/__control/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** An empty database, an empty queue, a fresh stand-in. */
export async function clean(): Promise<void> {
  await standIn('reset');
  resetBreaker();
  await ensureIndexes();
  await Promise.all(Object.values(col).map((collection) => collection().deleteMany({})));
  for (let batch = await receive(0); batch.length > 0; batch = await receive(0)) for (const m of batch) await ack(m);
  for (const m of await receiveDeadLetters()) await ack(m, 'deadLetter');
}

/**
 * Plays the worker once: publishes the outbox and runs every message that
 * is on the queue now. A step that says "later" is dropped, so each test
 * decides when to try it again. Returns what was handled.
 */
export async function work(): Promise<{ type: string; later: boolean }[]> {
  const handled: { type: string; later: boolean }[] = [];
  for (let round = 0; round < 20; round++) {
    const published = await relay();
    const deliveries = await receive(0);
    if (published === 0 && deliveries.length === 0) break;
    for (const delivery of deliveries) {
      const message = JSON.parse(delivery.body) as Message;
      let later = false;
      try {
        await handle(message);
      } catch (err) {
        if (!(err instanceof Later)) throw err;
        later = true;
      }
      await ack(delivery);
      handled.push({ type: message.type, later });
    }
  }
  return handled;
}

let counter = 0;
export const reference = () => `T-${Date.now().toString(36)}-${++counter}`;

export function payroll(ref: string, count: number, marginCents = 0) {
  return {
    reference: ref,
    client: { name: 'Client', email: 'ap@client.example.com' },
    marginCents,
    people: Array.from({ length: count }, (_, i) => ({
      name: `Person ${i + 1}`,
      email: `p${i + 1}.${ref.toLowerCase()}@staff.example.com`,
      amountCents: 100_00 + i * 100,
    })),
  };
}

/** A run that was created and invoiced: it is waiting for the client's money. */
export async function invoicedRun(count: number): Promise<string> {
  const ref = reference();
  const created = await createRun(payroll(ref, count), `key-${ref}`);
  if (created.kind !== 'created') throw new Error(`could not create the run: ${created.kind}`);
  await work();
  return ref;
}

/** The client pays at the provider. No webhook is delivered: tests send their own. */
export const pay = (ref: string, extra: Record<string, unknown> = {}) =>
  standIn('pay-invoice', { reference: ref, webhook: false, ...extra });

/** A funded run with every batch sent to the provider. */
export async function sentRun(count: number): Promise<string> {
  const ref = await invoicedRun(count);
  await pay(ref);
  const { sweep } = await import('../../lib/flows/sweep.ts');
  await sweep();
  await work();
  return ref;
}

export function webhook(event: string, data: Record<string, unknown>): { raw: string; signature: string } {
  const raw = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  return { raw, signature: sign(raw, config.oncadeWebhookSecret) };
}

export const run = async (ref: string) => (await col.runs().findOne({ _id: ref }))!;
export const batches = (ref: string) => col.batches().find({ runId: ref }).sort({ _id: 1 }).toArray();
export const distributionsFor = async (ref: string): Promise<{ memo: string; status: string }[]> =>
  ((await standIn('state')).distributions as { memo: string; status: string }[]).filter((d) => d.memo.includes(ref));

/** The books: every balance equals its entries, and everything sums to zero. */
export async function booksAreSound(): Promise<boolean> {
  const [balances, entries] = await Promise.all([col.balances().find().toArray(), col.ledger().find().toArray()]);
  const stored = Object.fromEntries(balances.map((row) => [row._id, row.cents]));
  return (
    balanceDrift(stored, entries).length === 0 && entries.reduce((total, entry) => total + entry.amountCents, 0) === 0
  );
}

export const balance = async (name: string) => (await col.balances().findOne({ _id: name }))?.cents ?? 0;
