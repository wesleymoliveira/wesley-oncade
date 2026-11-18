// A payout run that can be repeated without paying anyone twice.
// Each test is one row of the "what fails" table in docs/design.md.

import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../lib/config.ts';
import { createRun } from '../../lib/flows/create-run.ts';
import { Later } from '../../lib/flows/later.ts';
import { retryFailed } from '../../lib/flows/retry-failed.ts';
import { sendBatch } from '../../lib/flows/send-batch.ts';
import { sweep } from '../../lib/flows/sweep.ts';
import { mongo } from '../../lib/infra/db.ts';
import { publish } from '../../lib/infra/queue.ts';
import { col, peopleCount, refreshProgress } from '../../lib/infra/store.ts';
import { memoFor } from '../../lib/oncade/client.ts';
import {
  batches,
  booksAreSound,
  clean,
  distributionsFor,
  invoicedRun,
  pay,
  payroll,
  reference,
  run,
  sentRun,
  standIn,
  work,
} from './helpers.ts';

beforeEach(clean);

const expireLease = (batchId: string) =>
  col.batches().updateOne({ _id: batchId }, { $set: { leaseUntil: new Date(0) } });
const providerCall = (path: string, body?: unknown) =>
  fetch(`${config.standInUrl}/api/v1/platform${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer oncade_platform_test_00000000', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** A second distribution with the same memo, as a blind retry would leave at the provider. */
const strayDistribution = (batchId: string) =>
  providerCall('/distributions', {
    mode: 'fixed',
    payoutPath: 'dashboard',
    memo: memoFor(batchId),
    recipients: [{ email: 'someone@staff.example.com', name: 'Someone', amount: 1 }],
  });
const cancelAtProvider = (distributionId: string) => providerCall(`/distributions/${distributionId}/cancel`);
const fundedRun = async (count: number) => {
  const ref = await invoicedRun(count);
  await pay(ref);
  await sweep(); // records the funding and queues the batches; nothing is sent yet
  return ref;
};

describe('the client repeats the request', () => {
  it('returns the same run for the same key and body, and creates it once', async () => {
    const ref = reference();
    const body = payroll(ref, 45);
    expect((await createRun(body, 'key-1')).kind).toBe('created');
    expect((await createRun(body, 'key-1')).kind).toBe('replayed');
    expect(await col.runs().countDocuments()).toBe(1);
    expect(await col.payees().countDocuments()).toBe(45);
    expect((await batches(ref)).map((b) => b.payeeIds.length)).toEqual([20, 20, 5]);
    expect(await col.outbox().countDocuments()).toBe(1);
  });

  it('refuses the same key with another body, and another key with the same reference', async () => {
    const body = payroll(reference(), 3);
    await createRun(body, 'key-1');
    expect(await createRun({ ...body, marginCents: 1 }, 'key-1')).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await createRun(body, 'key-2')).toMatchObject({ kind: 'conflict', code: 'REFERENCE_EXISTS' });
  });

  it('creates one run when two identical requests race', async () => {
    const body = payroll(reference(), 30);
    const kinds = (await Promise.all([createRun(body, 'key-1'), createRun(body, 'key-1')])).map((r) => r.kind).sort();
    expect(kinds).toEqual(['created', 'replayed']);
    expect(await col.runs().countDocuments()).toBe(1);
  });

  it('refuses a payroll it cannot accept: one e-mail twice, or an amount above the limit', async () => {
    const twice = payroll(reference(), 2);
    twice.people[1]!.email = twice.people[0]!.email.toUpperCase();
    expect((await createRun(twice, 'key-1')).kind).toBe('invalid');

    const tooMuch = payroll(reference(), 2);
    for (const person of tooMuch.people) person.amountCents = Number.MAX_SAFE_INTEGER;
    expect((await createRun(tooMuch, 'key-2')).kind).toBe('invalid');
  });
});

describe('two workers take the same batch', () => {
  it('lets only one of them send it', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await Promise.all([sendBatch(batch!._id), sendBatch(batch!._id), sendBatch(batch!._id)]);
    expect((await batches(ref))[0]!.status).toBe('sent');
    expect(await distributionsFor(ref)).toHaveLength(1);
  });

  it('does nothing when the same message is delivered again', async () => {
    const ref = await sentRun(20);
    const [batch] = await batches(ref);
    await publish(JSON.stringify({ id: 'repeat', type: 'batch.send', payload: { batchId: batch!._id } }));
    await work();
    expect(await distributionsFor(ref)).toHaveLength(1);
  });
});

describe('the worker gets no answer after sending', () => {
  it('keeps the batch in sending, then finds the distribution by our reference instead of sending again', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await standIn('fault', { path: 'distributions', mode: 'lose_answer', count: 1 });

    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later);
    expect((await batches(ref))[0]!.status).toBe('sending');
    expect(await distributionsFor(ref)).toHaveLength(1); // it did reach the provider

    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later); // the lease is still held
    await expireLease(batch!._id);
    await sendBatch(batch!._id);

    const after = (await batches(ref))[0]!;
    expect(after.status).toBe('sent');
    expect(after.history.at(-1)!.cause).toContain('recovered');
    expect(await distributionsFor(ref)).toHaveLength(1);
  });

  it('parks the batch for a person when the provider does not have it: no answer is not a failure', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await standIn('fault', { path: 'distributions', mode: 'refuse', status: 503, count: 1 });

    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later);
    await expireLease(batch!._id);
    await sendBatch(batch!._id);
    await sendBatch(batch!._id);

    const after = (await batches(ref))[0]!;
    expect(after.status).toBe('parked');
    expect(after.problem?.reason).toBe('outcome_unknown_not_found_at_provider');
    expect(await distributionsFor(ref)).toHaveLength(0);
  });

  it('parks the batch when two live distributions carry its reference: it adopts neither', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await standIn('fault', { path: 'distributions', mode: 'lose_answer', count: 1 });
    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later);
    // What a blind retry would leave behind: seen on the test API, the same
    // key sent again makes a second distribution.
    await strayDistribution(batch!._id);
    expect(await distributionsFor(ref)).toHaveLength(2);

    await expireLease(batch!._id);
    await sendBatch(batch!._id);

    const after = (await batches(ref))[0]!;
    expect(after.status).toBe('parked');
    expect(after.problem?.reason).toBe('duplicate_distributions_at_provider');
    expect(await peopleCount(ref)).toMatchObject({ paid: 0 });
  });

  it('adopts the live one when the other distribution with its reference is cancelled', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await standIn('fault', { path: 'distributions', mode: 'lose_answer', count: 1 });
    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later);
    const stray = (await (await strayDistribution(batch!._id)).json()) as { _id: string };
    await cancelAtProvider(stray._id);

    await expireLease(batch!._id);
    await sendBatch(batch!._id);

    const after = (await batches(ref))[0]!;
    expect(after.status).toBe('sent');
    expect(after.distribution?.id).not.toBe(stray._id);
  });

  it('gives the batch back when the provider throttles: that call never happened', async () => {
    const ref = await fundedRun(20);
    const [batch] = await batches(ref);
    await standIn('fault', { path: 'distributions', mode: 'refuse', status: 429, count: 1 });
    await expect(sendBatch(batch!._id)).rejects.toBeInstanceOf(Later);
    expect((await batches(ref))[0]!.status).toBe('pending');
    await sendBatch(batch!._id);
    expect((await batches(ref))[0]!.status).toBe('sent');
  });
});

describe('some batches fail', () => {
  it('ends partially failed, then pays only the people who were not paid', async () => {
    const ref = await invoicedRun(45);
    await standIn('fault', { path: 'distributions', mode: 'refuse', status: 400, code: 'INVALID_RECIPIENT', count: 1 });
    await pay(ref);
    await sweep();
    await work();
    expect((await batches(ref)).map((b) => b.status).sort()).toEqual(['failed', 'sent', 'sent']);

    await standIn('pay-distributions', { reference: ref });
    await sweep();
    expect((await run(ref)).status).toBe('partially_failed');
    const unpaid = (await peopleCount(ref)).unpaid;
    expect(unpaid).toBeGreaterThan(0);

    const answer = await retryFailed(ref);
    expect(answer).toMatchObject({ kind: 'accepted', batches: 1, people: unpaid });
    await work();
    await standIn('pay-distributions', { reference: ref });
    await sweep();

    expect((await run(ref)).status).toBe('completed');
    expect(await peopleCount(ref)).toEqual({ unpaid: 0, assigned: 0, paid: 45 });
    const provider = await distributionsFor(ref);
    expect(provider).toHaveLength(3); // two from the first round, one retry; the refused one was never created
    expect(new Set(provider.map((d) => d.memo)).size).toBe(3);
    expect(await booksAreSound()).toBe(true);
    expect(
      (
        await col
          .balances()
          .find({ _id: /^payable:/ })
          .toArray()
      ).every((row) => row.cents === 0),
    ).toBe(true);
  });

  it('does not leave the run behind when two batches end at the same moment', async () => {
    const ref = await fundedRun(40);
    const first = mongo().startSession();
    const second = mongo().startSession();
    first.startTransaction();
    second.startTransaction();
    try {
      await refreshProgress(first, ref, 'one batch ended');
      // The database refuses the second check of the same run. In a flow, the driver then runs it again.
      await expect(refreshProgress(second, ref, 'another batch ended')).rejects.toMatchObject({
        codeName: 'WriteConflict',
      });
    } finally {
      await first.abortTransaction();
      await first.endSession();
      await second.endSession();
    }

    const refuse = { path: 'distributions', mode: 'refuse', status: 400, code: 'INVALID_RECIPIENT', count: 2 };
    await standIn('fault', refuse);
    await Promise.all((await batches(ref)).map((batch) => sendBatch(batch._id)));
    expect((await batches(ref)).map((b) => b.status)).toEqual(['failed', 'failed']);
    expect((await run(ref)).status).toBe('partially_failed');
  });

  it('refuses "retry failed" for a run that is not partially failed', async () => {
    const ref = await sentRun(20);
    expect((await retryFailed(ref)).kind).toBe('refused');
    expect((await retryFailed('no-such-run')).kind).toBe('not_found');
  });
});
