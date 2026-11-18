import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { batchId, chunk, MAX_RECIPIENTS, payeeId } from '../../lib/core/batches.ts';
import { decide, fingerprint, keyFor } from '../../lib/core/idempotency.ts';

describe('batches', () => {
  it('puts every person in exactly one batch of at most 20, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 400 }), (people) => {
        const groups = chunk(people);
        expect(groups.flat()).toEqual(people);
        expect(groups.every((group) => group.length >= 1 && group.length <= MAX_RECIPIENTS)).toBe(true);
        expect(groups.length).toBe(Math.ceil(people.length / MAX_RECIPIENTS));
      }),
    );
  });

  it('splits 300 people in 15 batches', () => {
    expect(chunk(Array.from({ length: 300 }, (_, i) => i)).length).toBe(15);
  });

  it('refuses a size that is not a positive integer', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });

  it('names batches and people so the name says where they belong', () => {
    expect(batchId('PR-1', 1, 7)).toBe('PR-1/a1/b07');
    expect(payeeId('PR-1', 42)).toBe('PR-1/p042');
  });
});

describe('incoming idempotency key', () => {
  it('gives the same fingerprint whatever the key order', () => {
    expect(fingerprint({ a: 1, b: { c: [1, 2], d: null } })).toBe(fingerprint({ b: { d: null, c: [1, 2] }, a: 1 }));
  });

  it('gives another fingerprint when a value or the order of a list changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint(undefined)).toBe(fingerprint(null));
  });

  it('decides: new key creates, same body replays, other body conflicts', () => {
    const body = fingerprint({ people: 3 });
    expect(decide(null, body)).toBe('create');
    expect(decide(body, body)).toBe('replay');
    expect(decide(fingerprint({ people: 4 }), body)).toBe('conflict');
  });
});

describe('outgoing idempotency key', () => {
  it('is the same for the same reference and looks like a UUID', () => {
    expect(keyFor('PR-1/a1/b07')).toBe(keyFor('PR-1/a1/b07'));
    expect(keyFor('PR-1/a1/b07')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs between references', () => {
    expect(keyFor('PR-1/a1/b07')).not.toBe(keyFor('PR-1/a2/b07'));
  });
});
