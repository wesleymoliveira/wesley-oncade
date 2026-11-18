// The worker: three loops in one long-lived process.
//   relay    outbox → queue
//   consume  queue → the step a message asks for
//   check    the periodic sweep
// On Vercel nothing stays running, so there the same three would be a cron
// route and queue-triggered functions. The code in lib/flows would not change.

import { telemetry } from './telemetry.ts'; // must stay first, see the file
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../lib/config.ts';
import { Later } from '../lib/flows/later.ts';
import { sweep } from '../lib/flows/sweep.ts';
import { handle, relay, type Message } from '../lib/flows/work.ts';
import { closeDb } from '../lib/infra/db.ts';
import { ack, ensureQueues, publish, receive, retryLater, type QueueMessage } from '../lib/infra/queue.ts';
import { ensureIndexes } from '../lib/infra/store.ts';
import { providerPaused } from '../lib/oncade/client.ts';
import { log } from '../lib/telemetry/log.ts';
import { m, primeCounters } from '../lib/telemetry/metrics.ts';
import { withSpan } from '../lib/telemetry/trace.ts';

let running = true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(body: string): Message {
  try {
    return JSON.parse(body) as Message;
  } catch {
    return { id: '', type: 'unreadable' as Message['type'], payload: {} };
  }
}

/**
 * Runs one delivery inside a span that carries the run reference, so one search finds every message of a run.
 * Done: the message is removed. `Later`: a fresh copy goes back with a delay and this one is removed, so waiting
 * never counts towards the dead-letter limit. A real error: the message is left to come back after a growing
 * pause, and after `queueMaxReceives` receives it moves to the dead-letter queue.
 */
async function consume(delivery: QueueMessage): Promise<void> {
  const message = parse(delivery.body);
  const type = String(message.type);
  const reference = String(message.payload?.runId ?? String(message.payload?.batchId ?? '').split('/')[0]);
  const attributes = {
    'messaging.message.type': type,
    'messaging.receive_count': delivery.receiveCount,
    'run.reference': reference,
  };

  await withSpan(
    `queue ${type}`,
    attributes,
    async () => {
      try {
        await handle(message);
        await ack(delivery);
        m.queueHandled.add(1, { type, outcome: 'done' });
      } catch (err) {
        if (err instanceof Later) {
          await publish(delivery.body, delivery.traceparent, err.seconds);
          await ack(delivery);
          m.queueHandled.add(1, { type, outcome: 'later' });
          return;
        }
        m.queueHandled.add(1, { type, outcome: 'error' });
        log.error('queue.handler_failed', {
          type,
          run_reference: reference,
          receive_count: delivery.receiveCount,
          reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
        await retryLater(delivery, 2 ** delivery.receiveCount);
        throw err;
      }
    },
    delivery.traceparent,
  );
}

async function relayLoop(): Promise<void> {
  while (running) {
    try {
      if ((await relay()) === 0) await sleep(250);
    } catch (err) {
      log.error('relay.failed', { reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      await sleep(1_000);
    }
  }
}

/** While the breaker is open no work is taken: messages wait in the queue instead of failing their way to the dead-letter queue. */
async function consumeLoop(): Promise<void> {
  while (running) {
    if (providerPaused()) {
      await sleep(500);
      continue;
    }
    try {
      const deliveries = await receive(2, 10);
      await Promise.all(deliveries.map((delivery) => consume(delivery).catch(() => undefined)));
    } catch (err) {
      log.error('queue.receive_failed', { reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      await sleep(1_000);
    }
  }
}

async function checkLoop(): Promise<void> {
  while (running) {
    await sweep().catch((err: unknown) =>
      log.error('sweep.failed', { reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }),
    );
    for (let waited = 0; running && waited < config.sweepIntervalMs; waited += 250) await sleep(250);
  }
}

/**
 * The zero counters are sent before any work, so the first real event counts as growth. The pid file tells a
 * script that a worker is running, and what it is pointed at.
 */
async function main(): Promise<void> {
  await ensureIndexes();
  await ensureQueues();
  primeCounters();
  await telemetry.flushMetrics().catch(() => undefined);
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/worker.pid', JSON.stringify({ pid: process.pid, setup: config.setup }));
  log.info('worker.started', { provider: config.usingStandIn ? 'stand-in' : 'oncade-test-api' });
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await Promise.all([relayLoop(), consumeLoop(), checkLoop()]);
  rmSync('.local/worker.pid', { force: true });
  log.info('worker.stopped');
  await telemetry.shutdown();
  await closeDb();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
