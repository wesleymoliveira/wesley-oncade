import { describe, expect, it } from 'vitest';
import { asNumber, ask, closed, settle, type BreakerState } from '../../lib/core/breaker.ts';
import { backoffMs, isProviderTrouble, neverHappened, nextStep, outcomeOf } from '../../lib/core/failures.ts';

describe('what a call told us', () => {
  it('names each kind of answer', () => {
    expect(outcomeOf({ status: 201 })).toEqual({ kind: 'ok' });
    expect(outcomeOf({ status: 429 })).toEqual({ kind: 'throttled' });
    expect(outcomeOf({ status: 503 })).toEqual({ kind: 'unknown', reason: 'server_error' });
    expect(outcomeOf({ error: 'timeout' })).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(outcomeOf({ error: 'network' })).toEqual({ kind: 'unknown', reason: 'network' });
    expect(outcomeOf({ error: 'refused' })).toEqual({ kind: 'unreachable' });
    expect(outcomeOf({ status: 400, code: 'TOO_MANY_RECIPIENTS' })).toEqual({
      kind: 'rejected',
      status: 400,
      code: 'TOO_MANY_RECIPIENTS',
    });
    expect(outcomeOf({ status: 302 })).toEqual({ kind: 'rejected', status: 302, code: null });
  });

  it('knows when it is sure that nothing happened at the provider', () => {
    expect([{ status: 429 }, { error: 'refused' as const }].map((t) => neverHappened(outcomeOf(t)))).toEqual([
      true,
      true,
    ]);
    expect(neverHappened({ kind: 'blocked' })).toBe(true);
    expect(
      [{ status: 503 }, { error: 'timeout' as const }, { status: 400 }, { status: 200 }].some((t) =>
        neverHappened(outcomeOf(t)),
      ),
    ).toBe(false);
  });

  it('"no answer" and "cannot connect" count against the provider, a refusal does not', () => {
    expect(isProviderTrouble(outcomeOf({ error: 'refused' }))).toBe(true);
    expect(isProviderTrouble(outcomeOf({ error: 'timeout' }))).toBe(true);
    expect(isProviderTrouble(outcomeOf({ status: 400 }))).toBe(false);
    expect(isProviderTrouble(outcomeOf({ status: 429 }))).toBe(false);
  });
});

describe('what is safe to do next', () => {
  const read = { creates: false };
  const pay = { creates: true };

  it('is done on success and gives up on a refusal', () => {
    expect(nextStep({ kind: 'ok' }, pay)).toBe('done');
    expect(nextStep({ kind: 'rejected', status: 400, code: null }, pay)).toBe('give_up');
  });

  it('retries a throttled call, and one our breaker blocked: nothing happened', () => {
    expect(nextStep({ kind: 'throttled' }, pay)).toBe('retry');
    expect(nextStep({ kind: 'blocked' }, pay)).toBe('retry');
    expect(nextStep({ kind: 'unreachable' }, pay)).toBe('retry');
  });

  it('retries a read that got no answer', () => {
    expect(nextStep({ kind: 'unknown', reason: 'timeout' }, read)).toBe('retry');
  });

  it('never repeats a payment call that got no answer: it asks the source', () => {
    expect(nextStep({ kind: 'unknown', reason: 'timeout' }, pay)).toBe('ask_source');
    expect(nextStep({ kind: 'unknown', reason: 'server_error' }, pay)).toBe('ask_source');
  });
});

describe('backoff with jitter', () => {
  const limits = { baseMs: 100, capMs: 1_000 };

  it('grows the ceiling with each attempt, up to the cap', () => {
    const almostOne = () => 0.999999;
    expect(backoffMs(1, limits, almostOne)).toBe(99);
    expect(backoffMs(2, limits, almostOne)).toBe(199);
    expect(backoffMs(3, limits, almostOne)).toBe(399);
    expect(backoffMs(10, limits, almostOne)).toBe(999);
  });

  it('picks a random point below the ceiling', () => {
    expect(backoffMs(3, limits, () => 0)).toBe(0);
    expect(backoffMs(3, limits, () => 0.5)).toBe(200);
    expect(backoffMs(0, limits, () => 0.5)).toBe(50);
    expect(backoffMs(4, limits)).toBeLessThan(800);
  });
});

describe('circuit breaker', () => {
  const rules = { threshold: 3, coolDownMs: 10_000 };
  const fail = (state: BreakerState, now: number) => settle(state, false, now, rules);

  it('stays closed below the threshold and lets calls through', () => {
    const state = fail(fail(closed, 0), 1);
    expect(state).toEqual({ mode: 'closed', failures: 2 });
    expect(ask(state, 2, rules).allowed).toBe(true);
  });

  it('forgets earlier failures after a success', () => {
    expect(settle(fail(fail(closed, 0), 1), true, 2, rules)).toEqual(closed);
  });

  it('opens at the threshold and refuses calls while cooling down', () => {
    const open = fail(fail(fail(closed, 0), 1), 2);
    expect(open).toEqual({ mode: 'open', since: 2 });
    expect(ask(open, 5_000, rules)).toEqual({ allowed: false, state: open });
  });

  it('lets exactly one probe through after the cool-down', () => {
    const open: BreakerState = { mode: 'open', since: 0 };
    const first = ask(open, 10_000, rules);
    expect(first).toEqual({ allowed: true, state: { mode: 'half_open' } });
    expect(ask(first.state, 10_001, rules).allowed).toBe(false);
  });

  it('closes when the probe succeeds and opens again when it fails', () => {
    expect(settle({ mode: 'half_open' }, true, 10_500, rules)).toEqual(closed);
    expect(settle({ mode: 'half_open' }, false, 10_500, rules)).toEqual({ mode: 'open', since: 10_500 });
  });

  it('reports its state as a number for a gauge', () => {
    expect(
      [closed, { mode: 'half_open' } as BreakerState, { mode: 'open', since: 0 } as BreakerState].map(asNumber),
    ).toEqual([0, 1, 2]);
  });
});
