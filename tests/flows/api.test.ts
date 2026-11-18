// The service's own API, asked the questions this project asks of Oncade: is a repeated key honoured, does
// a bad request get a 4xx with a code, does the code tell the client what to change, does an answer say what is true.

import { beforeEach, describe, expect, it } from 'vitest';
import { POST as cancel } from '../../app/api/runs/[reference]/cancel/route.ts';
import { GET as read } from '../../app/api/runs/[reference]/route.ts';
import { POST as create } from '../../app/api/runs/route.ts';
import { POST as webhookRoute } from '../../app/api/webhooks/oncade/route.ts';
import { config } from '../../lib/config.ts';
import { guarded } from '../../lib/http/respond.ts';
import { col } from '../../lib/infra/store.ts';
import { clean, payroll, reference, webhook, work } from './helpers.ts';

beforeEach(clean);

const token = { authorization: `Bearer ${config.appToken}` };
const post = (body: unknown, headers: Record<string, string> = { 'idempotency-key': 'key-1' }) =>
  create(
    new Request('http://api/api/runs', {
      method: 'POST',
      headers: { ...token, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    undefined,
  );
const at = (ref: string) => ({ params: Promise.resolve({ reference: ref }) });
const call = (route: typeof read, ref: string) => route(new Request('http://api/', { headers: token }), at(ref));
/** The HTTP status next to the body: a body has a `status` of its own (the run's). */
const answer = async (response: Response) => ({ http: response.status, ...((await response.json()) as object) });

describe('creating a run over HTTP', () => {
  it('returns the first run for a repeated key, and one code for each way a request can collide', async () => {
    const body = payroll(reference(), 3);
    expect(await answer(await post(body))).toMatchObject({ http: 201, reference: body.reference });
    expect(await answer(await post(body))).toMatchObject({ http: 200, replayed: true });
    expect(await col.runs().countDocuments()).toBe(1);

    expect(await answer(await post({ ...body, marginCents: 1 }))).toMatchObject({
      http: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await answer(await post(body, { 'idempotency-key': 'key-2' }))).toMatchObject({
      http: 409,
      code: 'REFERENCE_EXISTS',
    });
  });

  it('answers a bad request with a 4xx and a code, never a 500', async () => {
    const body = payroll(reference(), 2);
    const huge = { ...body, people: body.people.map((p) => ({ ...p, amountCents: Number.MAX_SAFE_INTEGER })) };
    expect(await answer(await post(body, {}))).toMatchObject({ http: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await answer(await post(body, { 'idempotency-key': 'k'.repeat(256) }))).toMatchObject({
      http: 400,
      code: 'IDEMPOTENCY_KEY_TOO_LONG',
    });
    expect(await answer(await post('{not json'))).toMatchObject({ http: 400, code: 'INVALID_JSON' });
    expect(await answer(await post(huge))).toMatchObject({ http: 422, code: 'INVALID_BODY' });
    expect(await col.runs().countDocuments()).toBe(0);
  });

  it('refuses a request without the token before it reads anything', async () => {
    const request = new Request('http://api/api/runs', { method: 'POST', body: '{}' });
    expect(await answer(await create(request, undefined))).toMatchObject({ http: 401, code: 'UNAUTHORIZED' });
  });
});

describe('reading and cancelling over HTTP', () => {
  it('answers 404 for a run that does not exist, and for a path that cannot be a reference', async () => {
    expect(await answer(await call(read, 'no-such-run'))).toMatchObject({ http: 404, code: 'NOT_FOUND' });
    expect(await answer(await call(read, 'x'.repeat(3000)))).toMatchObject({ http: 404, code: 'NOT_FOUND' });
    expect(await answer(await call(cancel, 'a/b'))).toMatchObject({ http: 404, code: 'NOT_FOUND' });
  });

  it('says "cancelling" while the cancel is under way and "cancelled" once it is done', async () => {
    const body = payroll(reference(), 3);
    await post(body);
    await work();
    for (const asked of [1, 2]) {
      expect(await answer(await call(cancel, body.reference)), `asked ${asked}`).toEqual({
        http: 202,
        reference: body.reference,
        status: 'cancelling',
      });
    }
    const together = await Promise.all([1, 2, 3].map(() => call(cancel, body.reference)));
    expect(together.map((response) => response.status)).toEqual([202, 202, 202]);
    await work();
    const done = await call(cancel, body.reference);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ reference: body.reference, status: 'cancelled' });
  });
});

describe('what no client should ever see, and what it sees then', () => {
  it('answers 500 in the shape of every other error, without the text of what was thrown', async () => {
    const broken = guarded(() => Promise.reject(new Error('a secret detail')));
    const response = await broken(new Request('http://api/', { headers: token }), undefined);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'unexpected error', code: 'INTERNAL_ERROR' });
  });

  it('gives the webhook route the raw bytes and the signature header, and a code when it refuses', async () => {
    const hook = webhook('Platform.Something.Else', {});
    const send = (signature: string) =>
      webhookRoute(
        new Request('http://api/api/webhooks/oncade', {
          method: 'POST',
          headers: { 'x-oncade-signature': signature },
          body: hook.raw,
        }),
      );
    expect(await answer(await send(hook.signature))).toMatchObject({ http: 200, received: true });
    expect(await answer(await send(`sha256=${hook.signature}`))).toMatchObject({
      http: 401,
      code: 'INVALID_SIGNATURE',
    });
  });
});
