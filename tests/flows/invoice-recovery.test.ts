// What the real test API showed on 2026-11-16: a POST repeated with the same
// Idempotency-Key creates a second invoice. So a create is never repeated,
// and after a lost answer the code looks before it does anything.

import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../lib/config.ts';
import { requestCancel } from '../../lib/flows/cancel.ts';
import { createRun } from '../../lib/flows/create-run.ts';
import { issueInvoice } from '../../lib/flows/invoice.ts';
import { Later } from '../../lib/flows/later.ts';
import { sweep } from '../../lib/flows/sweep.ts';
import { col } from '../../lib/infra/store.ts';
import { send } from '../../lib/oncade/http.ts';
import { clean, pay, payroll, reference, run, standIn, work } from './helpers.ts';

beforeEach(clean);

async function createdRun(): Promise<string> {
  const ref = reference();
  await createRun(payroll(ref, 20), `key-${ref}`);
  return ref;
}

/** A second invoice for the same run, as a blind retry would leave at the provider. */
const strayInvoice = (ref: string) =>
  fetch(`${config.standInUrl}/api/v1/platform/invoices`, {
    method: 'POST',
    headers: { authorization: 'Bearer oncade_platform_test_00000000', 'content-type': 'application/json' },
    body: JSON.stringify({
      receiverEmail: 'ap@client.example.com',
      status: 'sent',
      items: [{ amount: 1 }],
      externalMetadata: { runReference: ref },
    }),
  });

const invoicesAtProvider = async () => ((await standIn('state')).invoices as unknown[]).length;

/** The execution that tried is gone: its lease is over. Set, not slept. */
const expireAttempt = (ref: string) =>
  col.runs().updateOne({ _id: ref }, { $set: { invoiceAttemptedAt: new Date(0) } });

describe('the answer to "create invoice" is lost', () => {
  it('finds the invoice by our reference and adopts it, instead of creating another', async () => {
    const ref = await createdRun();
    await standIn('fault', { path: 'invoices', mode: 'lose_answer', count: 1 });

    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later);
    expect((await run(ref)).status).toBe('created');
    expect(await invoicesAtProvider()).toBe(1); // it did reach the provider

    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later); // the first execution may still be at it
    await expireAttempt(ref);
    await issueInvoice(ref);
    expect((await run(ref)).status).toBe('awaiting_funds');
    expect(await invoicesAtProvider()).toBe(1);
  });

  it('parks the run when the provider has no such invoice: it never creates a second time on its own', async () => {
    const ref = await createdRun();
    await standIn('fault', { path: 'invoices', mode: 'refuse', status: 503, count: 1 });

    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later);
    await expireAttempt(ref);
    await issueInvoice(ref);
    await issueInvoice(ref);

    expect((await run(ref)).review?.kind).toBe('invoice_outcome_unknown');
    expect(await invoicesAtProvider()).toBe(0);
  });

  it('parks the run when two invoices exist for it at the provider', async () => {
    const ref = await createdRun();
    await standIn('fault', { path: 'invoices', mode: 'lose_answer', count: 1 });
    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later);
    await strayInvoice(ref);
    await expireAttempt(ref);

    await issueInvoice(ref);
    const parked = await run(ref);
    expect(parked.status).toBe('created');
    expect(parked.review?.kind).toBe('duplicate_invoices_at_provider');
  });

  it('puts a refused cancel back where the run was: created, and still waiting for a person', async () => {
    const ref = await createdRun();
    await standIn('fault', { path: 'invoices', mode: 'lose_answer', count: 1 });
    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later);
    await strayInvoice(ref);
    await expireAttempt(ref);
    await issueInvoice(ref); // two invoices at the provider: parked

    expect((await requestCancel(ref)).kind).toBe('accepted');
    await work();
    const after = await run(ref);
    expect(after.status).toBe('created');
    expect(after.cancel?.refused).toContain('more than one invoice');
    expect(after.review?.kind).toBe('duplicate_invoices_at_provider');
  });

  it('gives the run back untouched when the provider throttles: that call never happened', async () => {
    const ref = await createdRun();
    await standIn('fault', { path: 'invoices', mode: 'refuse', status: 429, count: 1 });
    await expect(issueInvoice(ref)).rejects.toBeInstanceOf(Later);
    expect((await run(ref)).invoiceAttemptedAt).toBeUndefined();
    await issueInvoice(ref);
    expect((await run(ref)).status).toBe('awaiting_funds');
  });
});

describe('the queue and the periodic check reach "create invoice" together', () => {
  it('lets one of them create it, and the run stands on that invoice', async () => {
    const ref = await createdRun();
    const outcomes = await Promise.allSettled([issueInvoice(ref), issueInvoice(ref), issueInvoice(ref)]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await invoicesAtProvider()).toBe(1);
    const invoiced = await run(ref);
    expect(invoiced.status).toBe('awaiting_funds');
    // The invoice the run stands on is still open: nobody "took it back".
    expect((await standIn('state')).invoices).toEqual([expect.objectContaining({ status: 'sent' })]);
  });
});

describe('a whole run', () => {
  it('never sends the same create twice', async () => {
    const ref = await createdRun();
    await work();
    await pay(ref);
    await sweep();
    await work();
    await standIn('pay-distributions', { reference: ref });
    await sweep();

    expect((await run(ref)).status).toBe('completed');
    // The stand-in counts keys it saw more than once. Like the real API, it
    // would have created a second object for each.
    const provider = await standIn('state');
    expect(provider.repeatedKeys).toBe(0);
    // One invoice and one distribution were created, each with its own key:
    // the header does arrive, so "none repeated" is not an empty claim.
    expect(provider.distinctKeys).toBe(2);
  });

  it('really sends the Idempotency-Key header; the stand-in, like the test API, makes a second invoice', async () => {
    const target = { baseUrl: config.standInUrl, apiKey: 'oncade_platform_test_00000000' };
    const call = {
      method: 'POST' as const,
      path: '/platform/invoices',
      body: { items: [{ amount: 1 }] },
      idempotencyKey: 'key-1',
    };
    const first = await send(target, call);
    const second = await send(target, call);
    const provider = await standIn('state');
    expect(provider.distinctKeys).toBe(1); // the same key arrived twice
    expect(provider.repeatedKeys).toBe(1);
    // The stand-in imitates what the real test API did: a second invoice.
    expect((first.body as { _id: string })._id).not.toBe((second.body as { _id: string })._id);
    expect(provider.invoices).toHaveLength(2);
  });
});
