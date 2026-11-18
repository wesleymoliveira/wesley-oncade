import { describe, expect, it } from 'vitest';
import { canMove, isLive, mayCancel, maySend, progress, type BatchStatus, type RunStatus } from '../../lib/core/run.ts';

describe('state machines', () => {
  it('lets a run follow the happy path', () => {
    const path: RunStatus[] = ['created', 'awaiting_funds', 'funded', 'processing', 'completed'];
    for (let i = 0; i + 1 < path.length; i++) expect(canMove('run', path[i]!, path[i + 1]!)).toBe(true);
  });

  it('never lets a finished run move again', () => {
    for (const to of ['created', 'processing', 'cancelling'] as RunStatus[]) {
      expect(canMove('run', 'completed', to)).toBe(false);
      expect(canMove('run', 'cancelled', to)).toBe(false);
    }
  });

  it('lets a cancelling run go back to where it was when the provider refuses', () => {
    for (const back of ['created', 'awaiting_funds', 'funded', 'processing'] as RunStatus[]) {
      expect(canMove('run', 'cancelling', back)).toBe(true);
    }
    expect(canMove('run', 'cancelling', 'cancelled')).toBe(true);
    expect(canMove('run', 'cancelling', 'completed')).toBe(false);
  });

  it('lets a batch be sent once and never un-confirm', () => {
    expect(canMove('batch', 'pending', 'sending')).toBe(true);
    expect(canMove('batch', 'sending', 'sent')).toBe(true);
    expect(canMove('batch', 'sent', 'sending')).toBe(false);
    expect(canMove('batch', 'confirmed', 'sent')).toBe(false);
    expect(canMove('batch', 'failed', 'pending')).toBe(false);
  });

  it('pays a person at most once', () => {
    expect(canMove('payee', 'unpaid', 'assigned')).toBe(true);
    expect(canMove('payee', 'assigned', 'paid')).toBe(true);
    expect(canMove('payee', 'assigned', 'unpaid')).toBe(true);
    expect(canMove('payee', 'paid', 'unpaid')).toBe(false);
    expect(canMove('payee', 'paid', 'assigned')).toBe(false);
    expect(canMove('payee', 'unpaid', 'paid')).toBe(false);
  });

  it('refuses a state it does not know', () => {
    expect(canMove('run', 'nonsense' as RunStatus, 'created')).toBe(false);
  });

  it('knows which batches may still pay someone', () => {
    const live: BatchStatus[] = ['pending', 'sending', 'sent', 'parked'];
    const done: BatchStatus[] = ['confirmed', 'failed', 'cancelled'];
    expect(live.every(isLive)).toBe(true);
    expect(done.some(isLive)).toBe(false);
  });
});

describe('when money may move', () => {
  it('sends only when the run is funded', () => {
    expect(maySend({ status: 'funded', funding: { source: 'provider' } }, false)).toBe(true);
    expect(maySend({ status: 'processing', funding: { source: 'provider' } }, false)).toBe(true);
    expect(maySend({ status: 'awaiting_funds' }, true)).toBe(false);
    expect(maySend({ status: 'funded' }, true)).toBe(false);
  });

  it('treats simulated funding as money only where that was allowed', () => {
    const run = { status: 'funded' as const, funding: { source: 'simulated' as const } };
    expect(maySend(run, false)).toBe(false);
    expect(maySend(run, true)).toBe(true);
  });
});

describe('progress of a funded run', () => {
  it('is processing while any batch is live', () => {
    expect(progress(['confirmed', 'sent'], { unpaid: 0, assigned: 20, paid: 20 })).toBe('processing');
  });

  it('is completed when everyone is paid', () => {
    expect(progress(['confirmed', 'confirmed'], { unpaid: 0, assigned: 0, paid: 40 })).toBe('completed');
  });

  it('is partially failed when nothing is live and someone is unpaid', () => {
    expect(progress(['confirmed', 'failed'], { unpaid: 20, assigned: 0, paid: 20 })).toBe('partially_failed');
  });
});

describe('cancelling', () => {
  it('is possible until the first person is paid', () => {
    expect(mayCancel('awaiting_funds', 0)).toBe(true);
    expect(mayCancel('processing', 0)).toBe(true);
    expect(mayCancel('processing', 1)).toBe(false);
  });

  it('is possible when every batch failed and nobody was paid: the money can go back', () => {
    expect(mayCancel('partially_failed', 0)).toBe(true);
    expect(mayCancel('partially_failed', 1)).toBe(false);
  });

  it('is not possible for a finished run', () => {
    expect(mayCancel('completed', 0)).toBe(false);
    expect(mayCancel('cancelled', 0)).toBe(false);
  });
});
