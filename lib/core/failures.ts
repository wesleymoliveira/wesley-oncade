// What a call to the provider told us, and what is safe to do next.
// The rule that matters: "we did not get an answer" is not "it failed".

export type Outcome =
  | { kind: 'ok' }
  /** The provider said no. Nothing was created. Retrying the same request is pointless. */
  | { kind: 'rejected'; status: number; code: string | null }
  /** 429: the provider refused before doing anything. Safe to try again later. */
  | { kind: 'throttled' }
  /** Our circuit breaker was open: the call was never made. */
  | { kind: 'blocked' }
  /** The connection could not be opened: the request never left. */
  | { kind: 'unreachable' }
  /** No answer, or a 5xx. The request may or may not have been carried out. */
  | { kind: 'unknown'; reason: 'timeout' | 'network' | 'server_error' };

export type Transport = { status: number; code?: string | null } | { error: 'timeout' | 'network' | 'refused' };

export function outcomeOf(result: Transport): Outcome {
  if ('error' in result) {
    return result.error === 'refused' ? { kind: 'unreachable' } : { kind: 'unknown', reason: result.error };
  }
  if (result.status >= 200 && result.status < 300) return { kind: 'ok' };
  if (result.status === 429) return { kind: 'throttled' };
  if (result.status >= 500) return { kind: 'unknown', reason: 'server_error' };
  return { kind: 'rejected', status: result.status, code: result.code ?? null };
}

export type NextStep = 'done' | 'retry' | 'ask_source' | 'give_up';

/**
 * What to do after a call.
 *  - A read can always be repeated.
 *  - A call that creates a payment is never repeated after no answer: the
 *    provider makes a second object for a repeated Idempotency-Key (seen on
 *    the test API). We ask the source whether the first one exists.
 */
export function nextStep(outcome: Outcome, call: { creates: boolean }): NextStep {
  switch (outcome.kind) {
    case 'ok':
      return 'done';
    case 'rejected':
      return 'give_up';
    case 'throttled':
    case 'blocked':
    case 'unreachable':
      return 'retry';
    case 'unknown':
      return call.creates ? 'ask_source' : 'retry';
  }
}

/** "No answer" and "cannot connect" say the provider is in trouble. A 4xx is our problem. */
export function isProviderTrouble(outcome: Outcome): boolean {
  return outcome.kind === 'unknown' || outcome.kind === 'unreachable';
}

/** True when we are sure the provider did not act on the request. */
export function neverHappened(outcome: Outcome): boolean {
  return outcome.kind === 'throttled' || outcome.kind === 'blocked' || outcome.kind === 'unreachable';
}

/**
 * How long to wait before attempt number `attempt` (1 is the first retry):
 * a random time up to an exponentially growing ceiling ("full jitter"), so
 * many clients that failed together do not come back together.
 */
export function backoffMs(
  attempt: number,
  limits: { baseMs: number; capMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(limits.capMs, limits.baseMs * 2 ** (Math.max(1, attempt) - 1));
  return Math.floor(random() * ceiling);
}
