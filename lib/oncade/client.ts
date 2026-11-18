// The typed client for Oncade. Three rules live here:
//  1. Dollars exist only in this file. Everything else is cents.
//  2. A read is retried, with backoff and jitter. A call that creates or
//     cancels something is sent once: its caller decides what is safe next.
//  3. Every call passes the circuit breaker, so a provider that stopped
//     answering is left alone for a while.

import type { z } from 'zod';
import { config } from '../config.ts';
import { asNumber, ask, closed, settle, type BreakerState } from '../core/breaker.ts';
import { backoffMs, isProviderTrouble, nextStep, outcomeOf, type Outcome, type Transport } from '../core/failures.ts';
import { keyFor } from '../core/idempotency.ts';
import { fromDollars, toDollars, type FeeRule } from '../core/money.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';
import { withSpan } from '../telemetry/trace.ts';
import { assertTestKey, send, type OncadeCall } from './http.ts';
import * as shapes from './schemas.ts';

export type Failure = Exclude<Outcome, { kind: 'ok' }>;
export type Result<T> = { ok: true; value: T } | { ok: false; outcome: Failure; message: string };

export interface RemoteInvoice {
  id: string;
  status: string;
  totalCents: number;
  url: string | null;
}

export interface RemoteDistribution {
  id: string;
  status: string;
  totalCents: number;
  feeCents: number;
  memo: string;
  lines: { email: string; amountCents: number; status: string }[];
}

/** One breaker per process. */
let breaker: BreakerState = closed;

function setBreaker(next: BreakerState): void {
  if (next.mode !== breaker.mode) {
    m.breakerTransitions.add(1, { to: next.mode });
    log.warn('breaker.changed', { from: breaker.mode, to: next.mode });
  }
  breaker = next;
  m.breakerState.record(asNumber(next));
}

/** True while the breaker refuses calls. The worker stops taking work meanwhile. */
export function providerPaused(now = Date.now()): boolean {
  return breaker.mode === 'open' && now - breaker.since < config.breaker.coolDownMs;
}

export function resetBreaker(): void {
  setBreaker(closed);
}

const target = () => {
  assertTestKey(config.oncadeApiKey);
  return { baseUrl: config.oncadeBaseUrl, apiKey: config.oncadeApiKey, businessId: config.oncadeBusinessId };
};

/**
 * One request through the breaker, with its outcome classified. Two cases decide what is safe later:
 * "connection refused" means the request never left, so it may be tried again; a 2xx we cannot read means
 * something happened and we do not know what, so it is `unknown`, never `ok`.
 */
async function once<S extends z.ZodType>(
  operation: string,
  request: OncadeCall,
  shape: S,
): Promise<Result<z.infer<S>>> {
  return withSpan(`oncade ${operation}`, { 'oncade.operation': operation }, async (span) => {
    // A missing or wrong key is our mistake, not the provider's: it throws here, before the breaker is asked.
    const to = target();
    const gate = ask(breaker, Date.now(), config.breaker);
    setBreaker(gate.state);
    if (!gate.allowed) {
      span.setAttribute('oncade.outcome', 'blocked');
      return { ok: false, outcome: { kind: 'blocked' }, message: 'circuit breaker is open' };
    }

    const started = performance.now();
    let transport: Transport;
    let body: unknown;
    try {
      const reply = await send(to, { ...request, timeoutMs: config.oncadeTimeoutMs });
      body = reply.body;
      transport = { status: reply.status, code: shapes.ErrorReply.safeParse(body).data?.code ?? null };
      span.setAttribute('http.response.status_code', reply.status);
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      const neverSent = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
      transport = {
        error: neverSent ? 'refused' : err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
      };
    }

    let outcome = outcomeOf(transport);
    const parsed = outcome.kind === 'ok' ? shape.safeParse(body) : undefined;
    if (parsed && !parsed.success) outcome = { kind: 'unknown', reason: 'server_error' };

    setBreaker(settle(breaker, !isProviderTrouble(outcome), Date.now(), config.breaker));
    m.oncadeRequests.record((performance.now() - started) / 1000, { operation, outcome: outcome.kind });
    span.setAttribute('oncade.outcome', outcome.kind);

    if (outcome.kind === 'ok') return { ok: true, value: parsed!.data as z.infer<S> };
    const message = shapes.ErrorReply.safeParse(body).data?.error ?? outcome.kind;
    return { ok: false, outcome, message };
  });
}

/** A read: safe to repeat, so it is, up to three times. */
async function read<S extends z.ZodType>(operation: string, path: string, shape: S): Promise<Result<z.infer<S>>> {
  for (let attempt = 1; ; attempt++) {
    const result = await once(operation, { method: 'GET', path }, shape);
    if (result.ok || attempt === 3 || result.outcome.kind === 'blocked') return result;
    if (nextStep(result.outcome, { creates: false }) !== 'retry') return result;
    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt, { baseMs: 200, capMs: 2_000 })));
  }
}

/** A call that changes something at the provider: sent once, never repeated here. */
function write<S extends z.ZodType>(operation: string, path: string, reference: string, body: unknown, shape: S) {
  return once(operation, { method: 'POST', path, body, idempotencyKey: keyFor(reference) }, shape);
}

function map<A, B>(result: Result<A>, convert: (value: A) => B): Result<B> {
  return result.ok ? { ok: true, value: convert(result.value) } : result;
}

const toInvoice = (raw: z.infer<typeof shapes.Invoice>): RemoteInvoice => ({
  id: raw._id,
  status: raw.status,
  totalCents: fromDollars(raw.total),
  url: raw.links?.invoice ?? null,
});

const toDistribution = (raw: z.infer<typeof shapes.Distribution>): RemoteDistribution => ({
  id: raw._id,
  status: raw.status,
  totalCents: raw.totalAmountCents,
  feeCents: raw.totalFeeCents,
  memo: raw.memo ?? '',
  lines: raw.lineItems,
});

/** The memo carries our reference, so we can find our distribution in the list. */
export const memoFor = (reference: string) => `Payroll ${reference}`;

const MAX_PAGES = 20;

/**
 * Walks a list page by page and keeps what `keep` accepts, once per id: an object created during the walk can
 * show on two pages. A list longer than the walk throws: unread pages cannot answer "not found".
 */
async function walk<Raw extends { _id: string }>(
  what: string,
  page: (n: number) => Promise<Result<{ items: Raw[]; totalPages: number }>>,
  keep: (raw: Raw) => boolean,
  firstIsEnough = false,
): Promise<Result<Raw[]>> {
  const found = new Map<string, Raw>();
  for (let n = 1; n <= MAX_PAGES; n++) {
    const result = await page(n);
    if (!result.ok) return result;
    for (const raw of result.value.items) if (keep(raw)) found.set(raw._id, raw);
    if ((firstIsEnough && found.size > 0) || n >= result.value.totalPages)
      return { ok: true, value: [...found.values()] };
  }
  throw new Error(`the provider lists more than ${MAX_PAGES} pages of ${what}: this look-up cannot say "not found"`);
}

const invoicePage = async (n: number) =>
  map(await read('invoice_list', `/platform/invoices?page=${n}&limit=100`, shapes.InvoiceList), (list) => ({
    items: list.invoices,
    totalPages: list.pagination.totalPages,
  }));

const distributionPage = async (n: number) =>
  map(
    await read('distribution_list', `/platform/distributions?page=${n}&limit=100`, shapes.DistributionList),
    (list) => ({
      items: list.distributions,
      totalPages: list.pagination.totalPages,
    }),
  );

export const oncade = {
  async feeRules(): Promise<Result<FeeRule[]>> {
    const result = await read('fee_preview', '/platform/distributions/fee-preview', shapes.FeePreview);
    return map(result, ({ fees }) =>
      fees.map((fee) => ({ label: fee.label, percentage: fee.percentage, flatCents: fee.flat, feeType: fee.feeType })),
    );
  },

  /** Created as `sent`. Our reference travels in `externalMetadata`, so we can find the invoice again. */
  async createInvoice(input: {
    runId: string;
    client: { name: string; email: string };
    amountCents: number;
  }): Promise<Result<RemoteInvoice>> {
    const dollars = toDollars(input.amountCents);
    const body = {
      receiverName: input.client.name,
      receiverEmail: input.client.email,
      date: new Date().toISOString().slice(0, 10),
      payToTarget: 'BUSINESS',
      status: 'sent',
      items: [{ description: `Payroll run ${input.runId}`, quantity: 1, rate: dollars, amount: dollars }],
      externalMetadata: { runReference: input.runId },
    };
    return map(
      await write('invoice_create', '/platform/invoices', `invoice:${input.runId}`, body, shapes.Invoice),
      toInvoice,
    );
  },

  async getInvoice(id: string): Promise<Result<RemoteInvoice>> {
    return map(await read('invoice_get', `/platform/invoices/${encodeURIComponent(id)}`, shapes.Invoice), toInvoice);
  },

  /**
   * "Ask the source": every invoice that carries this run's reference and is
   * not cancelled. More than one means a create was repeated: seen on the
   * test API, a second POST with the same Idempotency-Key makes a second invoice.
   */
  async findInvoices(runId: string): Promise<Result<RemoteInvoice[]>> {
    const ours = (invoice: z.infer<typeof shapes.Invoice>) =>
      invoice.externalMetadata?.runReference === runId && invoice.status !== 'cancelled';
    return map(await walk('invoices', invoicePage, ours), (all) => all.map(toInvoice));
  },

  async cancelInvoice(id: string): Promise<Result<{ status: string }>> {
    const path = `/platform/invoices/${encodeURIComponent(id)}/cancel`;
    return write('invoice_cancel', path, `invoice-cancel:${id}`, undefined, shapes.Cancelled);
  },

  /** `payoutPath: "dashboard"`: the business owner pays from the Oncade dashboard. This code never moves money. */
  async createDistribution(input: {
    reference: string;
    people: readonly { email: string; name: string; amountCents: number }[];
    totalCents: number;
  }): Promise<Result<RemoteDistribution>> {
    const body = {
      mode: 'fixed',
      totalAmountCents: input.totalCents,
      recipients: input.people.map((p) => ({ email: p.email, name: p.name, amount: toDollars(p.amountCents) })),
      memo: memoFor(input.reference),
      payoutPath: 'dashboard',
    };
    const result = await write(
      'distribution_create',
      '/platform/distributions',
      `distribution:${input.reference}`,
      body,
      shapes.Distribution,
    );
    return map(result, toDistribution);
  },

  /**
   * The distribution with this id. The API has no call that reads one
   * distribution (seen: GET by id answers 410), so we walk the list.
   */
  async findDistribution(id: string): Promise<Result<RemoteDistribution | null>> {
    const found = await walk('distributions', distributionPage, (d) => d._id === id, true);
    return map(found, (all) => (all[0] ? toDistribution(all[0]) : null));
  },

  /**
   * "Ask the source": every distribution whose memo carries our reference,
   * cancelled ones included. More than one means a create was repeated: seen
   * on the test API, a second POST with the same Idempotency-Key makes a
   * second distribution.
   */
  async findDistributions(reference: string): Promise<Result<RemoteDistribution[]>> {
    const found = await walk('distributions', distributionPage, (d) => d.memo === memoFor(reference));
    return map(found, (all) => all.map(toDistribution));
  },

  async cancelDistribution(id: string): Promise<Result<{ status: string }>> {
    const path = `/platform/distributions/${encodeURIComponent(id)}/cancel`;
    return write('distribution_cancel', path, `distribution-cancel:${id}`, undefined, shapes.Cancelled);
  },
};
