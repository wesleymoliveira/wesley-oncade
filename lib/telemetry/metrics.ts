// Every metric of the project, each with the question it answers.
// Labels hold only small fixed sets of values: never an id or a reference.

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('payout-runs');
// The SDK's default histogram buckets are meant for milliseconds (5, 10, 25...).
// These are for seconds, or every call would land in the first bucket.
const fast = {
  unit: 's',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] },
};
const slow = { unit: 's', advice: { explicitBucketBoundaries: [1, 5, 15, 60, 300, 900, 3600, 14400, 86400] } };
const seconds = { unit: 's' };

/**
 * Every counter starts at zero for each label value it can take. Without
 * this the first event creates the series already at 1, and a query for
 * "how much did it grow" sees no growth: the first failure would be missed.
 */
export function primeCounters(): void {
  const runStates = ['created', 'awaiting_funds', 'funded', 'processing', 'partially_failed', 'completed', 'cancelled'];
  const batchStates = ['sending', 'sent', 'confirmed', 'failed', 'parked', 'cancelled'];
  const messageTypes = [
    'invoice.create',
    'funding.check',
    'batch.send',
    'batch.sync',
    'run.cancel',
    'customer.notify',
    'check.all',
  ];
  for (const to of runStates) m.runTransitions.add(0, { to });
  for (const to of batchStates) m.batchTransitions.add(0, { to });
  for (const path of ['webhook', 'pull']) m.fundingRecorded.add(0, { path, source: 'provider' });
  m.fundingRecorded.add(0, { path: 'operator', source: 'simulated' });
  for (const outcome of ['accepted', 'duplicate', 'bad_signature', 'ignored', 'unreadable'])
    m.webhooks.add(0, { outcome });
  for (const type of messageTypes)
    for (const outcome of ['done', 'later', 'error']) m.queueHandled.add(0, { type, outcome });
  for (const outcome of ['delivered', 'failed']) m.notifications.add(0, { outcome });
  for (const to of ['open', 'half_open', 'closed']) m.breakerTransitions.add(0, { to });
  const differences = [
    ['funding_missed', 'auto'],
    ['cancelled_at_provider', 'auto'],
    ['missing_at_provider', 'manual'],
    ['amount_mismatch', 'manual'],
    ['partial_payout', 'manual'],
  ];
  for (const [kind, repair] of differences) m.differences.add(0, { kind: kind!, repair: repair! });
  m.breakerState.record(0);
}

export const m = {
  /** How many runs reach each state? */
  runTransitions: meter.createCounter('runs.transitions', { description: 'Run state changes, by new state' }),
  /** How long does a client take to pay? */
  timeToFunded: meter.createHistogram('runs.time_to_funded', {
    ...slow,
    description: 'Invoice sent to money in',
  }),
  /** Is the webhook path alive? If "pull" rises, the webhook is not arriving. */
  fundingRecorded: meter.createCounter('funding.recorded', {
    description: 'Funding recorded, by the path that found it',
  }),
  /** How many batches reach each state? */
  batchTransitions: meter.createCounter('batches.transitions', { description: 'Batch state changes, by new state' }),
  /** Are webhooks accepted, repeated or forged? */
  webhooks: meter.createCounter('webhooks.received', { description: 'Webhook deliveries, by outcome' }),
  /** Do we answer inside the 10 seconds the provider allows? */
  webhookDuration: meter.createHistogram('webhooks.handle.duration', {
    ...fast,
    description: 'Time to answer a webhook',
  }),
  /** Is the provider slow or failing, and on which call? */
  oncadeRequests: meter.createHistogram('oncade.request.duration', {
    ...fast,
    description: 'Calls to Oncade, by operation and outcome',
  }),
  /** Did the breaker trip? */
  breakerTransitions: meter.createCounter('breaker.transitions', { description: 'Circuit breaker state changes' }),
  breakerState: meter.createGauge('breaker.state', { description: '0 closed, 1 half-open, 2 open' }),
  /** Is work piling up, and is anything in the dead-letter queue? */
  queueMessages: meter.createGauge('queue.messages', {
    description: 'Messages by state: waiting, in_flight, dead_letter',
  }),
  queueHandled: meter.createCounter('queue.handled', { description: 'Messages handled, by type and outcome' }),
  /** Are events being published? */
  outboxUnpublished: meter.createGauge('outbox.unpublished', { description: 'Outbox events not yet on the queue' }),
  /** Is money stuck? */
  oldestUnfundedAge: meter.createGauge('runs.oldest_unfunded_age', {
    ...seconds,
    description: 'Age of the oldest run waiting for money',
  }),
  oldestSendingAge: meter.createGauge('batches.oldest_sending_age', {
    ...seconds,
    description: 'Age of the oldest batch whose send has no known result',
  }),
  parkedBatches: meter.createGauge('batches.parked', { description: 'Batches waiting for a person' }),
  /** What did reconciliation find, and is it running at all? */
  differences: meter.createCounter('reconcile.differences', {
    description: 'Differences found against the provider, by kind and repair',
  }),
  reconcileLastSuccess: meter.createGauge('reconcile.last_success', {
    ...seconds,
    description: 'Unix time of the last complete check',
  }),
  /** Do the books still balance? Must stay at zero. */
  ledgerDrift: meter.createGauge('ledger.drift_accounts', {
    description: 'Accounts whose balance differs from its entries',
  }),
  /** Does our customer hear about its runs? */
  notifications: meter.createCounter('notifications.sent', { description: 'Webhooks to our customer, by outcome' }),
};
