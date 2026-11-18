// Step 1: the client asks for a run. One transaction saves the idempotency
// key, the run, every person and every batch, plus the event that will make
// the worker issue the invoice. Nothing here calls Oncade.

import { z } from 'zod';
import { batchId, chunk, payeeId } from '../core/batches.ts';
import { decide, fingerprint } from '../core/idempotency.ts';
import { sum } from '../core/money.ts';
import { REFERENCE } from '../core/run.ts';
import { inTransaction } from '../infra/db.ts';
import { col, enqueue, firstStep, type BatchDoc, type PayeeDoc, type RunDoc } from '../infra/store.ts';
import { m } from '../telemetry/metrics.ts';

/** US$ 1,000,000.00. With a limit on each amount, no sum of a run can leave the safe integers. */
const MAX_CENTS = 100_000_000;

const Input = z.object({
  reference: z.string().regex(REFERENCE, 'letters, digits, dot, dash or underscore, 3 to 40'),
  client: z.object({ name: z.string().min(1).max(120), email: z.email() }),
  marginCents: z.number().int().min(0).max(MAX_CENTS).default(0),
  people: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        email: z.email(),
        amountCents: z.number().int().positive().max(MAX_CENTS),
      }),
    )
    .min(1)
    .max(2_000),
});

export type CreateRunResult =
  | { kind: 'created' | 'replayed'; run: RunDoc }
  | { kind: 'conflict'; code: 'IDEMPOTENCY_KEY_REUSED' | 'REFERENCE_EXISTS'; reason: string }
  | { kind: 'invalid'; issues: string[] };

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11_000;

/**
 * Same key and body: the first run again. Same key, another body: a conflict. Two requests racing on one key: the
 * loser of the unique insert runs again and gets the replay. One e-mail is one person, as at the provider.
 */
export async function createRun(body: unknown, idempotencyKey: string): Promise<CreateRunResult> {
  const parsed = Input.safeParse(body);
  if (!parsed.success) {
    return { kind: 'invalid', issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }
  const input = parsed.data;
  const emails = new Set(input.people.map((person) => person.email.toLowerCase()));
  if (emails.size !== input.people.length)
    return { kind: 'invalid', issues: ['people: the same e-mail appears twice'] };

  const print = fingerprint(input);
  const attempt = () =>
    inTransaction<CreateRunResult>(async (session) => {
      const stored = await col.idempotency().findOne({ _id: idempotencyKey }, { session });
      const decision = decide(stored?.fingerprint ?? null, print);
      if (decision === 'conflict') {
        const reason = 'this Idempotency-Key was already used with a different body';
        return { kind: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED', reason };
      }
      if (decision === 'replay') {
        const existing = await col.runs().findOne({ _id: stored!.runId }, { session });
        return { kind: 'replayed', run: existing! };
      }
      if (await col.runs().findOne({ _id: input.reference }, { session, projection: { _id: 1 } })) {
        return { kind: 'conflict', code: 'REFERENCE_EXISTS', reason: 'a run with this reference already exists' };
      }

      const now = new Date();
      const runId = input.reference;
      const people = input.people.map((person, i) => ({ ...person, _id: payeeId(runId, i + 1) }));
      const batches: BatchDoc[] = chunk(people).map((group, i) => ({
        _id: batchId(runId, 1, i + 1),
        runId,
        status: 'pending',
        payeeIds: group.map((person) => person._id),
        totalCents: sum(group.map((person) => person.amountCents)),
        feeEstimateCents: 0,
        leaseUntil: null,
        history: [firstStep('pending', 'run created')],
        createdAt: now,
        updatedAt: now,
      }));
      const payees: PayeeDoc[] = batches.flatMap((batch) =>
        people
          .filter((person) => batch.payeeIds.includes(person._id))
          .map((person) => ({ ...person, runId, status: 'assigned' as const, batchId: batch._id })),
      );
      const run: RunDoc = {
        _id: runId,
        status: 'created',
        client: input.client,
        payrollCents: sum(input.people.map((person) => person.amountCents)),
        marginCents: input.marginCents,
        feeRules: [],
        feeReserveCents: 0,
        invoiceCents: 0,
        attempt: 1,
        history: [firstStep('created', 'client request')],
        createdAt: now,
        updatedAt: now,
      };

      await col
        .idempotency()
        .insertOne({ _id: idempotencyKey, fingerprint: print, runId, createdAt: now }, { session });
      await col.runs().insertOne(run, { session });
      await col.payees().insertMany(payees, { session });
      await col.batches().insertMany(batches, { session });
      await enqueue(session, 'invoice.create', { runId });
      return { kind: 'created', run };
    });

  let result: CreateRunResult;
  try {
    result = await attempt();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    result = await attempt();
  }
  if (result.kind === 'created') m.runTransitions.add(1, { to: 'created' });
  return result;
}
