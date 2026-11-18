// Webhooks in both directions: verifying the ones Oncade sends us, and
// signing the ones we send to our own customer. Same scheme on both sides:
// hex HMAC-SHA256 of the raw body.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * True only when the signature matches the exact bytes received. Never
 * throws: a missing or malformed signature is a "no", not a server error.
 */
export function verify(rawBody: string, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || secret === '') return false;
  const received = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  // timingSafeEqual throws when lengths differ, so compare lengths first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Oncade's webhooks carry no delivery id, so the identity of a delivery is
 * the hash of its bytes. A retry has the same bytes and the same key.
 */
export function deliveryKey(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export interface WebhookEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parses a body that already passed `verify`. Returns null if it is not an event. */
export function parseEvent(rawBody: string): WebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { event, data } = parsed as { event?: unknown; data?: unknown };
  if (typeof event !== 'string') return null;
  const safeData = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { event, data: safeData };
}

export type Hint =
  | { kind: 'invoice'; invoiceId: string | null }
  | { kind: 'distribution'; distributionId: string | null }
  | { kind: 'ignored' };

/**
 * What a webhook tells us to look at. It is only a hint: the handler never
 * trusts the payload for a status, it reads the source. When the id is
 * missing (the docs show no example for invoice events) the hint is still
 * useful: "check every open invoice".
 */
export function hintOf(event: WebhookEvent): Hint {
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  if (event.event.startsWith('Platform.Invoice.')) {
    return { kind: 'invoice', invoiceId: text(event.data.invoiceId) };
  }
  if (event.event.startsWith('Platform.Distribution.') || event.event === 'Platform.Gifts.Funded') {
    return { kind: 'distribution', distributionId: text(event.data.distributionId) };
  }
  return { kind: 'ignored' };
}
