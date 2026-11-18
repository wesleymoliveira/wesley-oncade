// The payment arrived and nobody told us. And cancelling, where a
// request is not yet a fact.

import { beforeEach, describe, expect, it } from 'vitest';
import { account } from '../../lib/core/ledger.ts';
import { executeCancel, requestCancel } from '../../lib/flows/cancel.ts';
import { simulateFunding } from '../../lib/flows/fund.ts';
import { sweep } from '../../lib/flows/sweep.ts';
import { viewRun } from '../../lib/flows/view.ts';
import { acceptWebhook } from '../../lib/flows/webhook.ts';
import { col, peopleCount } from '../../lib/infra/store.ts';
import {
  balance,
  batches,
  booksAreSound,
  clean,
  distributionsFor,
  invoicedRun,
  pay,
  run,
  sentRun,
  standIn,
  webhook,
  work,
} from './helpers.ts';

beforeEach(clean);

describe('the money arrives: webhook and pull end in the same step', () => {
  it('records the funding once when the webhook comes, comes again, and the pull runs too', async () => {
    const ref = await invoicedRun(20);
    await pay(ref);
    const hook = webhook('Platform.Invoice.Paid', { invoiceId: (await run(ref)).invoice!.id });

    expect(await acceptWebhook(hook.raw, hook.signature)).toMatchObject({ status: 200, body: { received: true } });
    expect((await acceptWebhook(hook.raw, hook.signature)).body).toMatchObject({ duplicate: true });
    await work();
    await sweep();
    await work();

    const funded = await run(ref);
    expect(funded.funding).toMatchObject({ source: 'provider', path: 'webhook', receivedCents: funded.invoiceCents });
    expect(await balance(account.cash('provider'))).toBe(funded.invoiceCents);
    expect(await col.ledger().countDocuments({ txId: `funding:${ref}`, account: account.cash('provider') })).toBe(1);
  });

  it('finds the payment by reading the provider when the webhook never comes', async () => {
    const ref = await invoicedRun(20);
    await pay(ref);
    await sweep();
    expect((await run(ref)).funding?.path).toBe('pull');
  });

  it('refuses a forged webhook and queues nothing', async () => {
    const ref = await invoicedRun(20);
    const before = await col.outbox().countDocuments();
    const hook = webhook('Platform.Invoice.Paid', { invoiceId: (await run(ref)).invoice!.id });
    expect((await acceptWebhook(hook.raw.replace('Paid', 'paid'), hook.signature)).status).toBe(401);
    expect(await acceptWebhook(hook.raw, null)).toMatchObject({ status: 401, body: { code: 'INVALID_SIGNATURE' } });
    expect(await col.outbox().countDocuments()).toBe(before);
    expect(await col.inbox().countDocuments()).toBe(0);
  });

  it('checks everything when an invoice event names an invoice we do not know', async () => {
    const ref = await invoicedRun(20);
    await pay(ref);
    const hook = webhook('Platform.Invoice.Paid', { somethingElse: true });
    expect((await acceptWebhook(hook.raw, hook.signature)).status).toBe(200);
    expect((await work()).map((m) => m.type)).toContain('check.all');
    expect((await run(ref)).funding).toBeDefined();
  });

  it('sends a payment of another amount to a person instead of accepting it', async () => {
    const ref = await invoicedRun(20);
    await pay(ref, { totalCents: 1 });
    await sweep();
    const waiting = await run(ref);
    expect(waiting.status).toBe('awaiting_funds');
    expect(waiting.review?.kind).toBe('amount_mismatch');
    expect(await col.ledger().countDocuments()).toBe(0);
  });

  it('keeps simulated funding apart from money received', async () => {
    const ref = await invoicedRun(20);
    expect(await simulateFunding(ref, 'a rehearsal: nobody pays this invoice')).toBe(true);
    const funded = await run(ref);
    expect(funded.funding).toMatchObject({ source: 'simulated', path: 'operator' });
    expect(await balance(account.cash('simulated'))).toBe(funded.invoiceCents);
    expect(await balance(account.cash('provider'))).toBe(0);
    expect((await viewRun(ref))!.funding!.label).toContain('SIMULATED');
    await expect(simulateFunding(ref, '   ')).rejects.toThrow(/reason/);
  });
});

describe('cancelling: asked is not cancelled', () => {
  it('cancels the invoice at the provider first when nothing was funded', async () => {
    const ref = await invoicedRun(20);
    expect(await requestCancel(ref)).toEqual({ kind: 'accepted', status: 'cancelling' });
    expect((await run(ref)).status).toBe('cancelling');
    await work();
    expect((await run(ref)).status).toBe('cancelled');
    expect(await requestCancel(ref)).toEqual({ kind: 'accepted', status: 'cancelled' });
    expect((await standIn('state')).invoices).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect((await batches(ref)).every((b) => b.status === 'cancelled')).toBe(true);
  });

  it('gives up the cancel when the client paid in the meantime, and goes on to pay people', async () => {
    const ref = await invoicedRun(20);
    await pay(ref);
    await requestCancel(ref);
    await work();
    const after = await run(ref);
    expect(after.cancel?.refused).toContain('already paid');
    expect(after.funding?.source).toBe('provider');
    expect((await batches(ref))[0]!.status).toBe('sent');
  });

  it('reverses the books only after every distribution is cancelled at the provider', async () => {
    const ref = await sentRun(45);
    const { invoiceCents } = await run(ref);
    await requestCancel(ref);
    expect(await balance(account.refundDue(ref))).toBe(0); // asked, nothing reversed yet
    await work();

    expect((await run(ref)).status).toBe('cancelled');
    expect((await distributionsFor(ref)).every((d) => d.status === 'cancelled')).toBe(true);
    expect(await balance(account.refundDue(ref))).toBe(-invoiceCents);
    expect(await peopleCount(ref)).toEqual({ unpaid: 45, assigned: 0, paid: 0 });
    expect(await booksAreSound()).toBe(true);
  });

  it('loses to a payment already made at the provider: nothing is reversed and the run completes', async () => {
    const ref = await sentRun(20);
    await standIn('pay-distributions', { reference: ref }); // paid, and we have not read it yet
    expect((await requestCancel(ref)).kind).toBe('accepted');
    await work();

    const refused = await run(ref);
    expect(refused.status).toBe('processing');
    expect(refused.cancel?.refused).toContain('completed');
    expect(await balance(account.refundDue(ref))).toBe(0);

    await sweep();
    expect((await run(ref)).status).toBe('completed');
    expect(await booksAreSound()).toBe(true);
  });

  it('takes a cancel that is delivered twice at the same moment as one cancel', async () => {
    const ref = await sentRun(45);
    const { invoiceCents } = await run(ref);
    await requestCancel(ref);
    await Promise.all([executeCancel(ref), executeCancel(ref)]);

    expect((await run(ref)).status).toBe('cancelled');
    expect((await distributionsFor(ref)).every((d) => d.status === 'cancelled')).toBe(true);
    expect(await balance(account.refundDue(ref))).toBe(-invoiceCents);
    expect(await booksAreSound()).toBe(true);
  });

  it('cancels a funded run whose batches all failed, and owes the money back', async () => {
    const ref = await invoicedRun(20);
    const { invoiceCents } = await run(ref);
    await standIn('fault', { path: 'distributions', mode: 'refuse', status: 400, code: 'INVALID_RECIPIENT', count: 1 });
    await pay(ref);
    await sweep();
    await work();
    expect((await run(ref)).status).toBe('partially_failed');

    expect(await requestCancel(ref)).toEqual({ kind: 'accepted', status: 'cancelling' });
    await work();
    expect((await run(ref)).status).toBe('cancelled');
    expect(await balance(account.refundDue(ref))).toBe(-invoiceCents);
    expect(await booksAreSound()).toBe(true);
  });

  it('tells the customer when a run completes right after its cancel was refused', async () => {
    const ref = await sentRun(20);
    await standIn('pay-distributions', { reference: ref });
    await requestCancel(ref);
    await sweep(); // the payment is read while the run is still cancelling
    await work(); // the cancel is refused: the batch is already paid

    expect((await run(ref)).status).toBe('completed');
    const told = { type: 'customer.notify' as const, 'payload.event': 'run.completed' };
    expect(await col.outbox().countDocuments(told)).toBe(1);
  });

  it('undoes simulated funding on cancel: the open invoice is cancelled and nothing is owed back', async () => {
    const ref = await invoicedRun(20);
    await simulateFunding(ref, 'a rehearsal: nobody pays this invoice');
    await work(); // the batch is sent
    expect((await batches(ref))[0]!.status).toBe('sent');

    await requestCancel(ref);
    await work();

    expect((await run(ref)).status).toBe('cancelled');
    expect((await distributionsFor(ref)).every((d) => d.status === 'cancelled')).toBe(true);
    expect((await standIn('state')).invoices).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(await balance(account.cash('simulated'))).toBe(0);
    expect(await balance(account.refundDue(ref))).toBe(0);
    expect(await balance(account.cash('provider'))).toBe(0);
    expect(await booksAreSound()).toBe(true);
  });

  it('refuses at once when someone was already paid', async () => {
    const ref = await sentRun(20);
    await standIn('pay-distributions', { reference: ref });
    await sweep();
    expect(await requestCancel(ref)).toMatchObject({ kind: 'refused' });
    expect((await requestCancel('no-such-run')).kind).toBe('not_found');
  });
});
