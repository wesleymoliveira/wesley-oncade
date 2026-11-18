// The schemas of lib/oncade read the replies the real test API gave, and
// the webhook code reads the deliveries Oncade really sent. Both were
// recorded on 2026-11-16 and 17 and scrubbed with `npm run fixtures`: real
// structure, no real ids or addresses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outcomeOf } from '../../lib/core/failures.ts';
import { compareBatch, compareFunding } from '../../lib/core/reconcile.ts';
import { hintOf, parseEvent } from '../../lib/core/webhook.ts';
import * as shapes from '../../lib/oncade/schemas.ts';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', `${name}.json`);
const load = (name: string) => JSON.parse(readFileSync(fixture(name), 'utf8')) as { status: number; body: unknown };

describe('invoices, as the test API answered', () => {
  it('reads a created invoice: id, status, total in dollars, link, our reference', () => {
    const { status, body } = load('invoice-created');
    const invoice = shapes.Invoice.parse(body);
    expect(status).toBe(201);
    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(1);
    expect(invoice.links?.invoice).toBeDefined();
    expect(invoice.externalMetadata).toHaveProperty('runReference');
  });

  it('reads one invoice and the list, and the list carries externalMetadata', () => {
    expect(shapes.Invoice.safeParse(load('invoice-get').body).success).toBe(true);
    const list = shapes.InvoiceList.parse(load('invoice-list').body);
    expect(list.pagination.totalPages).toBeGreaterThanOrEqual(1);
    expect(list.invoices[0]?.externalMetadata).toHaveProperty('runReference');
  });

  it('reads a cancel, and a second cancel as a refusal with a code', () => {
    expect(shapes.Cancelled.parse(load('invoice-cancelled').body).status).toBe('cancelled');
    const twice = load('invoice-cancel-twice');
    const error = shapes.ErrorReply.parse(twice.body);
    expect(outcomeOf({ status: twice.status, code: error.code })).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'INVOICE_INVALID_STATUS',
    });
  });

  it('reads an error that has no code: the `metadata` field', () => {
    const rejected = load('invoice-rejected-metadata');
    const error = shapes.ErrorReply.parse(rejected.body);
    expect(rejected.status).toBe(400);
    expect(error.code).toBeUndefined();
    expect(error.error).toContain('externalMetadata');
  });
});

describe('fees, as the test API answered', () => {
  it('reads a fee preview, also when no fee is configured', () => {
    expect(shapes.FeePreview.parse(load('fee-preview').body).fees).toEqual([]);
  });
});

describe('distributions, as the test API answered', () => {
  it('reads a created distribution: total in cents, our memo, and a line per person with its own status', () => {
    const { status, body } = load('distribution-created');
    const distribution = shapes.Distribution.parse(body);
    expect(status).toBe(201);
    expect(distribution.status).toBe('pending');
    expect(distribution.memo).toBeTruthy();
    expect(distribution.lineItems.map((line) => line.amountCents)).toEqual([100, 200, 300]);
    expect(distribution.lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(distribution.totalAmountCents);
    expect(distribution.lineItems.every((line) => line.status === 'pending')).toBe(true);
    expect(distribution.totalFeeCents).toBe(0);
  });

  it('reads the list, which carries the memo: that is how we find our own distribution', () => {
    const list = shapes.DistributionList.parse(load('distribution-list').body);
    expect(list.pagination.totalPages).toBeGreaterThanOrEqual(1);
    expect(list.distributions[0]?.memo).toBeTruthy();
    expect(list.distributions[0]?.lineItems.length).toBeGreaterThan(0);
  });

  it('has no call that reads one distribution', () => {
    expect(load('distribution-get-by-id').status).toBe(410);
  });

  it('reads a cancel, and a second cancel as a refusal with a code', () => {
    expect(shapes.Cancelled.parse(load('distribution-cancelled').body).status).toBe('cancelled');
    const twice = load('distribution-cancel-twice');
    expect(outcomeOf({ status: twice.status, code: shapes.ErrorReply.parse(twice.body).code })).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'DISTRIBUTION_NOT_CANCELLABLE',
    });
  });

  it('refuses 21 recipients, with a code', () => {
    const tooMany = load('distribution-too-many');
    expect(outcomeOf({ status: tooMany.status, code: shapes.ErrorReply.parse(tooMany.body).code })).toEqual({
      kind: 'rejected',
      status: 400,
      code: 'TOO_MANY_RECIPIENTS',
    });
  });
});

// The fact the recovery design stands on. If this fails after the fixtures
// are recorded again, the provider now returns the first object for a
// repeated key: read docs/context/oncade-contract.md before changing anything.
describe('the same Idempotency-Key sent twice, as recorded', () => {
  const idOf = (name: string) => (load(name).body as { _id: string })._id;

  it('made a second invoice', () => {
    expect(load('invoice-created-same-key').status).toBe(201);
    expect(idOf('invoice-created-same-key')).not.toBe(idOf('invoice-created'));
  });

  it('made a second distribution', () => {
    expect(load('distribution-created-same-key').status).toBe(201);
    expect(idOf('distribution-created-same-key')).not.toBe(idOf('distribution-created'));
  });
});

// Recorded on 2026-11-17, after a person paid an invoice and a payout from a
// test balance. Until then both rules below stood on the documentation.
describe('money that really moved, as the test API reported it', () => {
  it('a paid invoice is what the funding rule waits for', () => {
    const invoice = shapes.Invoice.parse(load('invoice-paid').body);
    expect(invoice.status).toBe('paid');
    const remote = { status: invoice.status, totalCents: Math.round(invoice.total * 100) };
    const local = { status: 'awaiting_funds', invoiceCents: remote.totalCents } as const;
    expect(compareFunding(local, remote)).toEqual({ kind: 'funding_missed', repair: 'auto' });
  });

  it('a paid payout is completed, with every line sent: what the batch rule waits for', () => {
    const [paid] = shapes.DistributionList.parse(load('distribution-list-paid').body).distributions;
    expect(paid?.status).toBe('completed');
    const people = paid!.lineItems.map((line, i) => ({
      id: `p${i}`,
      email: line.email,
      amountCents: line.amountCents,
    }));
    // The scrubbed fixture gives every line the same address, so match one person at a time.
    for (const [i, person] of people.entries()) {
      const verdict = compareBatch(
        { status: 'sent', people: [person] },
        { status: paid!.status, lines: [paid!.lineItems[i]!] },
      );
      expect(verdict).toEqual({
        difference: { kind: 'completion_missed', repair: 'auto' },
        paid: [person.id],
        released: [],
      });
    }
  });
});

describe('webhooks, as Oncade delivered them', () => {
  const delivered = (name: string) => parseEvent(JSON.stringify(load(name).body))!;
  const anId = expect.stringMatching(/^[0-9a-f]{24}$/);

  it('an invoice event names its invoice, and carries none of our own data', () => {
    // "Created" carries the status the invoice was created with: both were seen.
    for (const [name, event, statuses] of [
      ['webhook-invoice-created', 'Platform.Invoice.Created', ['draft', 'sent']],
      ['webhook-invoice-updated', 'Platform.Invoice.Updated', ['draft']],
      ['webhook-invoice-sent', 'Platform.Invoice.Sent', ['sent']],
      ['webhook-invoice-paid', 'Platform.Invoice.Paid', ['paid']],
      ['webhook-invoice-cancelled', 'Platform.Invoice.Cancelled', ['cancelled']],
    ] as const) {
      const delivery = delivered(name);
      expect(delivery.event).toBe(event);
      expect(statuses).toContain(delivery.data.status);
      expect(hintOf(delivery)).toEqual({ kind: 'invoice', invoiceId: anId });
      expect(delivery.data).not.toHaveProperty('externalMetadata');
    }
  });

  it('an event about something else is not a hint to move money', () => {
    const delivery = delivered('webhook-link-started');
    expect(delivery.event).toBe('Platform.Link.Started');
    expect(hintOf(delivery)).toEqual({ kind: 'ignored' });
  });

  it('a distribution event names its distribution, and carries the memo with our reference', () => {
    for (const [name, event, status] of [
      ['webhook-distribution-created', 'Platform.Distribution.Created', 'pending'],
      ['webhook-distribution-cancelled', 'Platform.Distribution.Cancelled', 'cancelled'],
    ] as const) {
      const delivery = delivered(name);
      expect(delivery.event).toBe(event);
      expect(delivery.data.status).toBe(status);
      expect(hintOf(delivery)).toEqual({ kind: 'distribution', distributionId: anId });
      expect(delivery.data).toHaveProperty('memo');
    }
  });
});
