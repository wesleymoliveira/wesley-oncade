// What the worker does with the outbox and the queue.
//  - relay: publishes outbox events to the queue, then marks them published.
//    A crash in between publishes twice, which is fine: consumers are
//    idempotent. An event is never lost, because it was saved with the
//    state change that caused it.
//  - handle: runs the step a message asks for.

import { config } from '../config.ts';
import { sign } from '../core/webhook.ts';
import { publish } from '../infra/queue.ts';
import { col, type MessageType, type OutboxDoc } from '../infra/store.ts';
import { m } from '../telemetry/metrics.ts';
import { executeCancel } from './cancel.ts';
import { syncBatch } from './confirm.ts';
import { recordFunding } from './fund.ts';
import { issueInvoice } from './invoice.ts';
import { sendBatch } from './send-batch.ts';
import { sweep } from './sweep.ts';

export interface Message {
  /** The outbox event id. Also the delivery id of a customer notification. */
  id: string;
  type: MessageType;
  payload: OutboxDoc['payload'];
}

export async function relay(limit = 100): Promise<number> {
  const events = await col.outbox().find({ publishedAt: null }).sort({ _id: 1 }).limit(limit).toArray();
  for (const event of events) {
    const message: Message = { id: event._id.toHexString(), type: event.type, payload: event.payload };
    await publish(JSON.stringify(message), event.traceparent ?? undefined);
    await col.outbox().updateOne({ _id: event._id }, { $set: { publishedAt: new Date() } });
  }
  return events.length;
}

/**
 * Tells our own customer what happened to its run, with a signed webhook. The delivery id lets the receiver
 * recognise a retry. A failure is a real error: the queue delivers it again, then dead-letters it.
 */
async function notifyCustomer(message: Message): Promise<void> {
  if (!config.customerWebhookUrl) return;
  if (!config.customerWebhookSecret) throw new Error('CUSTOMER_WEBHOOK_SECRET is not set: nothing is sent unsigned');
  const { event, ...data } = message.payload;
  const body = JSON.stringify({ id: message.id, event, data, timestamp: new Date().toISOString() });
  try {
    const reply = await fetch(config.customerWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payout-event': String(event),
        'x-payout-delivery': message.id,
        'x-payout-signature': sign(body, config.customerWebhookSecret),
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!reply.ok) throw new Error(`the customer endpoint answered ${reply.status}`);
    m.notifications.add(1, { outcome: 'delivered' });
  } catch (err) {
    m.notifications.add(1, { outcome: 'failed' });
    throw err;
  }
}

const text = (value: unknown): string => {
  if (typeof value !== 'string' || value === '') throw new Error('message payload is missing a field');
  return value;
};

/** Runs the step a message asks for. An unknown type throws every time, so it ends in the dead-letter queue. */
export async function handle(message: Message): Promise<void> {
  const p = message.payload;
  switch (message.type) {
    case 'invoice.create':
      return issueInvoice(text(p.runId));
    case 'funding.check':
      return recordFunding(text(p.runId), p.path === 'webhook' ? 'webhook' : 'pull');
    case 'batch.send':
      return sendBatch(text(p.batchId));
    case 'batch.sync':
      return syncBatch(text(p.batchId));
    case 'run.cancel':
      return executeCancel(text(p.runId));
    case 'customer.notify':
      return notifyCustomer(message);
    case 'check.all':
      return sweep();
    default:
      throw new Error(`unknown message type: ${String(message.type)}`);
  }
}
