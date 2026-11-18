// NOT Oncade. A local imitation of the few Oncade calls this project makes,
// so the whole flow runs with no credentials and failures can be caused on
// purpose.
//
// Seen on the real test API (2026-11-16) and imitated here:
//  - the shape of an invoice, and of the invoice list with externalMetadata;
//  - a POST repeated with the same Idempotency-Key creates a SECOND invoice;
//  - `metadata` on an invoice answers 400; a second cancel answers 422
//    INVOICE_INVALID_STATUS;
//  - the shape of a distribution and of its list, with the memo and one line
//    item per person (no id of its own: the e-mail address identifies it);
//  - a POST repeated with the same Idempotency-Key creates a SECOND
//    distribution;
//  - 21 recipients answer 400 TOO_MANY_RECIPIENTS; reading one distribution
//    by id answers 410; a cancel answers the whole distribution, and a second
//    cancel answers 422 DISTRIBUTION_NOT_CANCELLABLE.
// From the documentation only, never seen: what "paid" and "completed" look
// like, and a distribution with a fee (the test account has no fee rules;
// the stand-in charges the example fee of the reference, so the fee reserve
// is exercised).
//
//   node stand-in/server.ts        listens on 127.0.0.1:3310
//
// /api/v1/platform/...   the imitated API
// /__control/...         switches for the drills (never part of Oncade)
// /__sink/webhooks       plays our customer's endpoint and records deliveries

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.STAND_IN_PORT ?? 3310);
const APP_WEBHOOK_URL = `${process.env.APP_URL ?? 'http://127.0.0.1:3300'}/api/webhooks/oncade`;
const WEBHOOK_SECRET = 'stand-in-webhook-secret';
const CUSTOMER_SECRET = process.env.CUSTOMER_WEBHOOK_SECRET ?? 'customer-webhook-secret';
// One service fee, as in the fee-preview example of the reference: a flat
// amount per person plus a percentage of the total.
const FEE = { label: 'Service Fee', percentage: 1, flat: 25, feeType: 'per_payout_plus_percentage' };

type Json = Record<string, unknown>;
interface Invoice extends Json {
  _id: string;
  status: string;
  total: number;
}
interface Distribution extends Json {
  _id: string;
  status: string;
  memo: string;
  lineItems: { email: string; name: string; percentage: number; amountCents: number; method: string; status: string }[];
}
interface Fault {
  path: string;
  /**
   * refuse: answer with `status`, create nothing.
   * lose_answer: create, then answer 503.
   * hold: create, then keep the caller waiting `holdMs` before answering.
   */
  mode: 'refuse' | 'lose_answer' | 'hold';
  holdMs?: number;
  status: number;
  code?: string;
  count: number;
}

const fresh = () => ({
  invoices: new Map<string, Invoice>(),
  distributions: new Map<string, Distribution>(),
  keys: new Map<string, number>(),
  faults: [] as Fault[],
  down: false,
  sink: { deliveries: [] as { id: string; event: string }[], repeats: 0, failNext: 0 },
});
let state = fresh();

const objectId = () => randomBytes(12).toString('hex');
const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

function send(res: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; json: Json }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { raw, json: raw ? (JSON.parse(raw) as Json) : {} };
  } catch {
    return { raw, json: {} };
  }
}

function page<T>(items: T[], url: URL): { slice: T[]; pagination: Json } {
  const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
  const current = Number(url.searchParams.get('page') ?? 1);
  const totalPages = Math.max(1, Math.ceil(items.length / limit));
  return {
    slice: items.slice((current - 1) * limit, current * limit),
    pagination: { total: items.length, page: current, limit, totalPages },
  };
}

async function deliverWebhook(
  event: string,
  data: Json,
  options: { repeat?: number; tamper?: boolean } = {},
): Promise<number[]> {
  const body = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  const signature = sign(body, WEBHOOK_SECRET);
  const statuses: number[] = [];
  for (let i = 0; i < (options.repeat ?? 1); i++) {
    const res = await fetch(APP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oncade-signature': signature, 'x-oncade-event': event },
      // Tampered: the signature was made for another body.
      body: options.tamper ? body.replace('"data":{', '"data":{"forged":true,') : body,
    }).catch(() => null);
    statuses.push(res?.status ?? 0);
  }
  return statuses;
}

// ---- the imitated API -------------------------------------------------------

async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
  if (state.down) return send(res, 503, { error: 'stand-in is switched off', code: 'UNAVAILABLE' });
  if (!/^Bearer oncade_platform_test_/.test(req.headers.authorization ?? '')) {
    return send(res, 401, { error: 'Invalid API key', code: 'UNAUTHORIZED' });
  }
  const { json: body } = await readBody(req);
  const method = req.method ?? 'GET';
  const key = req.headers['idempotency-key'];

  const fault = method === 'POST' ? state.faults.find((f) => f.count > 0 && path.startsWith(`/${f.path}`)) : undefined;
  if (fault) fault.count -= 1;
  if (fault?.mode === 'refuse')
    return send(res, fault.status, { error: `stand-in fault ${fault.status}`, code: fault.code ?? 'FAULT' });
  // Created, but the answer is lost: the caller cannot know it happened.
  const answer = async (status: number, reply: Json, headers?: Record<string, string>) => {
    if (fault?.mode === 'lose_answer') return send(res, 503, { error: 'answer lost', code: 'UNAVAILABLE' });
    if (fault?.mode === 'hold') await new Promise((resolve) => setTimeout(resolve, fault.holdMs ?? 10_000));
    if (!res.destroyed) send(res, status, reply, headers);
  };

  // The real test API does not deduplicate on Idempotency-Key: a repeated
  // create makes a second object. So does this stand-in. The count of keys
  // seen more than once is kept, to prove our code never repeats a create.
  if (method === 'POST' && typeof key === 'string' && !/\/cancel$/.test(path)) {
    state.keys.set(key, (state.keys.get(key) ?? 0) + 1);
  }

  if (method === 'GET' && path === '/me') {
    return send(res, 200, {
      status: 'active',
      approvedScopes: ['invoice:create', 'distribution:create'],
      keyInfo: { environment: 'test' },
    });
  }
  if (method === 'GET' && path === '/distributions/fee-preview') return send(res, 200, { fees: [FEE] });

  if (method === 'POST' && path === '/invoices') {
    if ('metadata' in body)
      return send(res, 400, { error: 'metadata is not accepted; send caller data in externalMetadata' });
    const items = (body.items as { amount: number }[] | undefined) ?? [];
    const id = objectId();
    const total = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
    // The payer pays a fee on top: 0.5% in the reply recorded from the test API.
    const payerFee = Math.ceil(total * 0.5) / 100;
    const invoice: Invoice = {
      _id: id,
      receiverName: String(body.receiverName ?? 'Receiver'),
      receiverEmail: String(body.receiverEmail ?? 'receiver@example.com'),
      date: String(body.date ?? ''),
      payToTarget: 'BUSINESS',
      items,
      subtotal: total,
      tax: 0,
      total,
      balanceDue: total,
      paymentSummary: { invoiceAmount: total, payerFee, totalCharged: Number((total + payerFee).toFixed(2)) },
      currency: 'USD',
      status: body.status === 'sent' ? 'sent' : 'draft',
      environment: 'test',
      externalMetadata: body.externalMetadata ?? null,
      links: { invoice: `http://127.0.0.1:${PORT}/pay/${id}` },
    };
    state.invoices.set(id, invoice);
    return answer(201, invoice, { location: `/api/v1/platform/invoices/${id}` });
  }
  if (method === 'GET' && path === '/invoices') {
    const { slice, pagination } = page([...state.invoices.values()], url);
    return send(res, 200, { invoices: slice, pagination });
  }
  const invoiceMatch = /^\/invoices\/([0-9a-f]{24})(\/cancel)?$/.exec(path);
  if (invoiceMatch) {
    const invoice = state.invoices.get(invoiceMatch[1]!);
    if (!invoice) return send(res, 404, { error: 'Invoice not found', code: 'NOT_FOUND' });
    if (method === 'GET' && !invoiceMatch[2]) return send(res, 200, invoice);
    if (method === 'POST' && invoiceMatch[2]) {
      if (invoice.status !== 'draft' && invoice.status !== 'sent') {
        return send(res, 422, {
          error: `Cannot cancel invoice in '${invoice.status}' status`,
          code: 'INVOICE_INVALID_STATUS',
        });
      }
      invoice.status = 'cancelled';
      return answer(200, invoice);
    }
  }

  if (method === 'POST' && path === '/distributions') {
    const recipients = (body.recipients as { email: string; name: string; amount: number }[] | undefined) ?? [];
    if (recipients.length > 20) {
      return send(res, 400, {
        error: `A payout can have at most 20 recipients. This one has ${recipients.length}.`,
        code: 'TOO_MANY_RECIPIENTS',
      });
    }
    const cents = recipients.map((r) => Math.round(r.amount * 100));
    const total = cents.reduce((sum, amount) => sum + amount, 0);
    const lineItems = recipients.map((r, i) => ({
      email: r.email,
      name: r.name,
      percentage: total === 0 ? 0 : (cents[i]! / total) * 100,
      amountCents: cents[i]!,
      // Seen: "gift" for a person with no account at the provider yet.
      method: 'gift',
      status: 'pending',
    }));
    const feeCents = FEE.flat * recipients.length + Math.ceil((total * FEE.percentage) / 100);
    const now = new Date().toISOString();
    const distribution: Distribution = {
      _id: objectId(),
      businessId: '000000000000000000000000',
      totalAmountCents: total,
      totalFeeCents: feeCents,
      deductedFeeCents: 0,
      payerTotalCents: total + feeCents,
      currency: 'USD',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      feeLineItems: [
        {
          label: FEE.label,
          percentageRate: FEE.percentage,
          flatRateCents: FEE.flat,
          amountCents: feeCents,
          feeType: FEE.feeType,
          status: 'pending',
        },
      ],
      memo: String(body.memo ?? ''),
      payoutPath: String(body.payoutPath ?? 'partner'),
      environment: 'test',
      lineItems,
    };
    state.distributions.set(distribution._id, distribution);
    return answer(201, distribution, { location: `/api/v1/platform/distributions/${distribution._id}` });
  }
  if (method === 'GET' && path === '/distributions') {
    const status = url.searchParams.get('status');
    const all = [...state.distributions.values()].filter((d) => !status || d.status === status);
    const { slice, pagination } = page(all, url);
    return send(res, 200, { distributions: slice, pagination });
  }
  // Seen: the API has no call that reads one distribution.
  if (method === 'GET' && /^\/distributions\/[0-9a-f]{24}$/.test(path)) {
    return send(res, 410, { error: 'Endpoint not found.  Did you mean /api/v1/ for your api call?.' });
  }
  const cancelMatch = /^\/distributions\/([0-9a-f]{24})\/cancel$/.exec(path);
  if (method === 'POST' && cancelMatch) {
    const distribution = state.distributions.get(cancelMatch[1]!);
    if (!distribution) return send(res, 404, { error: 'Distribution not found', code: 'NOT_FOUND' });
    if (distribution.status !== 'draft' && distribution.status !== 'pending') {
      return send(res, 422, {
        error: `Cannot cancel distribution in '${distribution.status}' status`,
        code: 'DISTRIBUTION_NOT_CANCELLABLE',
      });
    }
    // Seen: the distribution becomes cancelled, its line items stay as they were.
    distribution.status = 'cancelled';
    distribution.cancelledAt = distribution.updatedAt = new Date().toISOString();
    return answer(200, distribution);
  }
  return send(res, 404, { error: `stand-in has no ${method} ${path}`, code: 'NOT_FOUND' });
}

// ---- switches for the drills ------------------------------------------------

async function control(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
  const { json: body } = await readBody(req);
  const byReference = (reference: unknown) =>
    [...state.invoices.values()].find((i) => (i.externalMetadata as Json | null)?.runReference === reference);

  switch (action) {
    case 'reset':
      state = fresh();
      return send(res, 200, { ok: true });
    case 'down':
      state.down = body.on === true;
      return send(res, 200, { down: state.down });
    case 'unplug': {
      // Stops listening for a while: callers get "connection refused", as
      // when the provider is truly unreachable. Comes back by itself.
      const seconds = Number(body.seconds ?? 10);
      send(res, 200, { unpluggedForSeconds: seconds });
      server.close();
      server.closeAllConnections();
      setTimeout(() => server.listen(PORT, '127.0.0.1'), seconds * 1000);
      return;
    }
    case 'fault':
      state.faults.push({
        path: String(body.path),
        mode: body.mode === 'lose_answer' || body.mode === 'hold' ? body.mode : 'refuse',
        holdMs: typeof body.holdMs === 'number' ? body.holdMs : undefined,
        status: Number(body.status ?? 503),
        code: typeof body.code === 'string' ? body.code : undefined,
        count: Number(body.count ?? 1),
      });
      return send(res, 200, { faults: state.faults.length });
    case 'pay-invoice': {
      // The client pays. `webhook: false` loses the webhook on purpose.
      const invoice = byReference(body.reference);
      if (!invoice) return send(res, 404, { error: 'no invoice for that reference' });
      invoice.status = 'paid';
      if (typeof body.totalCents === 'number') invoice.total = body.totalCents / 100;
      const statuses =
        body.webhook === false
          ? []
          : await deliverWebhook(
              'Platform.Invoice.Paid',
              { invoiceId: invoice._id },
              { repeat: Number(body.repeat ?? 1), tamper: body.tamper === true },
            );
      return send(res, 200, { paid: invoice._id, webhookStatuses: statuses });
    }
    case 'cancel-invoice': {
      const invoice = byReference(body.reference);
      if (!invoice) return send(res, 404, { error: 'no invoice for that reference' });
      invoice.status = 'cancelled';
      return send(res, 200, { cancelled: invoice._id });
    }
    case 'pay-distributions': {
      // The business owner pays every pending distribution from "the dashboard".
      let paid = 0;
      for (const distribution of state.distributions.values()) {
        if (distribution.status !== 'pending') continue;
        if (typeof body.reference === 'string' && !distribution.memo.includes(body.reference)) continue;
        distribution.status = 'completed';
        for (const line of distribution.lineItems) line.status = 'sent';
        paid += 1;
      }
      return send(res, 200, { paid });
    }
    case 'sink':
      state.sink.failNext = Number(body.failNext ?? 0);
      return send(res, 200, { failNext: state.sink.failNext });
    case 'state': {
      const memos = [...state.distributions.values()].map((d) => d.memo);
      return send(res, 200, {
        invoices: [...state.invoices.values()].map((i) => ({ status: i.status, total: i.total })),
        distributions: [...state.distributions.values()].map((d) => ({
          memo: d.memo,
          status: d.status,
          people: d.lineItems.length,
        })),
        // The number that proves "nobody was paid twice": memos that appear more than once.
        duplicateMemos: memos.filter((memo, i) => memos.indexOf(memo) !== i),
        // Creates we sent more than once with the same key. Must stay empty.
        repeatedKeys: [...state.keys.values()].filter((times) => times > 1).length,
        // Distinct Idempotency-Keys received on creates: one per create, if the header arrives.
        distinctKeys: state.keys.size,
        sink: {
          delivered: state.sink.deliveries.length,
          repeats: state.sink.repeats,
          events: state.sink.deliveries.map((d) => d.event),
        },
      });
    }
    default:
      return send(res, 404, { error: `no control "${action}"` });
  }
}

/** Plays our customer: verifies the signature and drops a delivery it already has. */
async function sink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { raw, json: body } = await readBody(req);
  const received = Buffer.from(String(req.headers['x-payout-signature'] ?? ''), 'utf8');
  const expected = Buffer.from(sign(raw, CUSTOMER_SECRET), 'utf8');
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    return send(res, 401, { error: 'invalid signature' });
  if (state.sink.failNext > 0) {
    state.sink.failNext -= 1;
    return send(res, 500, { error: 'customer endpoint is failing on purpose' });
  }
  const id = String(req.headers['x-payout-delivery'] ?? '');
  if (state.sink.deliveries.some((d) => d.id === id)) state.sink.repeats += 1;
  else state.sink.deliveries.push({ id, event: String(body.event) });
  return send(res, 200, { received: true });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname.startsWith('/api/v1/platform')
    ? api(req, res, url, url.pathname.slice('/api/v1/platform'.length))
    : url.pathname.startsWith('/__control/')
      ? control(req, res, url.pathname.slice('/__control/'.length))
      : url.pathname === '/__sink/webhooks'
        ? sink(req, res)
        : Promise.resolve(send(res, 404, { error: 'not found' }));
  route.catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : 'stand-in error' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`stand-in (not Oncade) on http://127.0.0.1:${PORT}`));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
