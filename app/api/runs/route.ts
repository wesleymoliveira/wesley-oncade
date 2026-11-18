import { createRun } from '../../../lib/flows/create-run.ts';
import { guarded, json, refuse, tagRun } from '../../../lib/http/respond.ts';

export const dynamic = 'force-dynamic';

/**
 * Creates a payout run. It only writes to the database and answers: the
 * invoice and the payouts happen in the worker. Send an Idempotency-Key (any
 * text of up to 255 characters) and repeat the request as often as you like:
 * the same key and body always return the same run.
 */
export const POST = guarded(async (request) => {
  const key = request.headers.get('idempotency-key');
  if (!key) return refuse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'the Idempotency-Key header is required');
  if (key.length > 255)
    return refuse(400, 'IDEMPOTENCY_KEY_TOO_LONG', 'the Idempotency-Key takes up to 255 characters');
  const body: unknown = await request.json().catch(() => undefined);
  if (body === undefined) return refuse(400, 'INVALID_JSON', 'the body is not JSON');

  const result = await createRun(body, key);
  if (result.kind === 'invalid')
    return refuse(422, 'INVALID_BODY', 'the request is not valid', { issues: result.issues });
  if (result.kind === 'conflict') return refuse(409, result.code, result.reason);

  tagRun(result.run._id);
  const summary = { reference: result.run._id, status: result.run.status, payrollCents: result.run.payrollCents };
  const location = { location: `/api/runs/${result.run._id}` };
  return result.kind === 'created' ? json(summary, 201, location) : json({ ...summary, replayed: true }, 200, location);
});
