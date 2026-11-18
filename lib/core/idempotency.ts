// Idempotency in both directions:
//  - incoming: a client that repeats "create run" with the same key gets the
//    same run, and a different body under the same key is refused;
//  - outgoing: each call to Oncade carries a key derived from our own
//    reference, so the same send always has the same key.

import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The same body always gives the same fingerprint, whatever the key order. */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

export type KeyDecision = 'create' | 'replay' | 'conflict';

/**
 * What to do with a request that carries an idempotency key.
 * `stored` is the fingerprint saved with that key, if the key was seen before.
 */
export function decide(stored: string | null, incoming: string): KeyDecision {
  if (stored === null) return 'create';
  return stored === incoming ? 'replay' : 'conflict';
}

/**
 * The Idempotency-Key for a call to Oncade: a UUID computed from our
 * reference, so a retry of the same send can never carry a new key.
 */
export function keyFor(reference: string): string {
  const hex = createHash('sha256').update(reference).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
