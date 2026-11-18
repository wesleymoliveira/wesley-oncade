// A circuit breaker as a pure state machine. The caller passes the time in,
// so the rules are tested without waiting.
//
//   closed ──(failures in a row reach the threshold)──► open
//   open ──(cool-down passed)──► half_open: exactly one probe call
//   half_open ──(probe ok)──► closed      half_open ──(probe failed)──► open

export interface BreakerRules {
  /** Failures in a row that open the circuit. */
  threshold: number;
  /** How long it stays open before one probe is let through. */
  coolDownMs: number;
}

export type BreakerState =
  { mode: 'closed'; failures: number } | { mode: 'open'; since: number } | { mode: 'half_open' };

export const closed: BreakerState = { mode: 'closed', failures: 0 };

/** May a call go out now? Returns the answer and the state to keep. */
export function ask(state: BreakerState, now: number, rules: BreakerRules): { allowed: boolean; state: BreakerState } {
  if (state.mode === 'closed') return { allowed: true, state };
  if (state.mode === 'open' && now - state.since >= rules.coolDownMs) {
    return { allowed: true, state: { mode: 'half_open' } };
  }
  // Still cooling down, or the single probe is already out.
  return { allowed: false, state };
}

/** The call finished. Returns the state to keep. */
export function settle(state: BreakerState, ok: boolean, now: number, rules: BreakerRules): BreakerState {
  if (ok) return closed;
  if (state.mode === 'closed' && state.failures + 1 < rules.threshold) {
    return { mode: 'closed', failures: state.failures + 1 };
  }
  return { mode: 'open', since: now };
}

/** For a gauge: 0 closed, 1 half-open, 2 open. */
export function asNumber(state: BreakerState): 0 | 1 | 2 {
  return state.mode === 'closed' ? 0 : state.mode === 'half_open' ? 1 : 2;
}
