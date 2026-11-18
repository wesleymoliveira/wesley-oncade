import { describe, expect, it } from 'vitest';
import { deliveryKey, hintOf, parseEvent, sign, verify } from '../../lib/core/webhook.ts';

const secret = 'test-secret';
// The spacing is deliberate: it is what breaks a body that was parsed and re-serialized.
const body = '{"event":"Platform.Invoice.Paid", "data":{"invoiceId":"inv_1"}, "timestamp":"2026-11-16T12:00:00.000Z"}';

describe('verifying a webhook', () => {
  it('accepts the exact bytes that were signed', () => {
    expect(verify(body, sign(body, secret), secret)).toBe(true);
  });

  it('refuses a body changed after signing', () => {
    expect(verify(body.replace('inv_1', 'inv_2'), sign(body, secret), secret)).toBe(false);
  });

  it('refuses a body that was parsed and re-serialized: same data, other bytes', () => {
    expect(verify(JSON.stringify(JSON.parse(body)), sign(body, secret), secret)).toBe(false);
  });

  it('says no, without throwing, to a missing or malformed signature', () => {
    expect(verify(body, undefined, secret)).toBe(false);
    expect(verify(body, ['x'], secret)).toBe(false);
    expect(verify(body, 'not-hex', secret)).toBe(false);
    expect(verify(body, '', secret)).toBe(false);
  });

  it('refuses everything when no secret is configured', () => {
    expect(verify(body, sign(body, ''), '')).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(body, sign(body, 'other'), secret)).toBe(false);
  });
});

describe('delivery key', () => {
  it('is the same for a retry and different for another event', () => {
    expect(deliveryKey(body)).toBe(deliveryKey(body));
    expect(deliveryKey(body)).not.toBe(deliveryKey(body.replace('inv_1', 'inv_2')));
  });
});

describe('parsing an event', () => {
  it('reads the event name and its data', () => {
    expect(parseEvent(body)).toEqual({ event: 'Platform.Invoice.Paid', data: { invoiceId: 'inv_1' } });
  });

  it('returns null for anything that is not an event', () => {
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent('null')).toBeNull();
    expect(parseEvent('"text"')).toBeNull();
    expect(parseEvent('{"data":{}}')).toBeNull();
  });

  it('treats missing or odd data as empty', () => {
    expect(parseEvent('{"event":"X"}')).toEqual({ event: 'X', data: {} });
    expect(parseEvent('{"event":"X","data":"text"}')).toEqual({ event: 'X', data: {} });
    expect(parseEvent('{"event":"X","data":null}')).toEqual({ event: 'X', data: {} });
  });
});

describe('a webhook is a hint about where to look', () => {
  it('points at an invoice', () => {
    expect(hintOf({ event: 'Platform.Invoice.Paid', data: { invoiceId: 'inv_1' } })).toEqual({
      kind: 'invoice',
      invoiceId: 'inv_1',
    });
  });

  it('still hints at invoices when the id is missing or not text', () => {
    expect(hintOf({ event: 'Platform.Invoice.Paid', data: {} })).toEqual({ kind: 'invoice', invoiceId: null });
    expect(hintOf({ event: 'Platform.Invoice.Paid', data: { invoiceId: 7 } })).toEqual({
      kind: 'invoice',
      invoiceId: null,
    });
    expect(hintOf({ event: 'Platform.Invoice.Paid', data: { invoiceId: '' } })).toEqual({
      kind: 'invoice',
      invoiceId: null,
    });
  });

  it('points at a distribution', () => {
    expect(hintOf({ event: 'Platform.Distribution.Cancelled', data: { distributionId: 'd1' } })).toEqual({
      kind: 'distribution',
      distributionId: 'd1',
    });
    expect(hintOf({ event: 'Platform.Gifts.Funded', data: { distributionId: 'd1' } })).toEqual({
      kind: 'distribution',
      distributionId: 'd1',
    });
  });

  it('ignores events it has no use for', () => {
    expect(hintOf({ event: 'Platform.Link.Completed', data: {} })).toEqual({ kind: 'ignored' });
  });
});
