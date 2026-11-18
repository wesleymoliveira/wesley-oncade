// Receiving a webhook from Oncade. The handler does four things and answers:
//   1. verifies the signature over the raw bytes;
//   2. stores the delivery under a unique key, so a retry is recognised;
//   3. in the same transaction, queues the work the event points at;
//   4. answers 200, well inside the 10 seconds the provider allows.
// It never trusts the payload for a status. The worker reads the source.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { deliveryKey, hintOf, parseEvent, verify } from '../core/webhook.ts';
import { inTransaction } from '../infra/db.ts';
import { col, enqueue } from '../infra/store.ts';
import { log } from '../telemetry/log.ts';
import { m } from '../telemetry/metrics.ts';

function keepRaw(event: string, rawBody: string): void {
  const directory = join(process.cwd(), '.local', 'raw');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${Date.now()}-webhook-${event}.json`);
  writeFileSync(file, JSON.stringify({ status: 200, body: JSON.parse(rawBody) }, null, 2));
}

export interface WebhookAnswer {
  status: 200 | 400 | 401;
  body: Record<string, unknown>;
}

/** An event whose id we do not know still says "something changed": then everything open is checked. */
export async function acceptWebhook(rawBody: string, signature: string | null): Promise<WebhookAnswer> {
  const started = performance.now();
  const answer = (outcome: string, status: WebhookAnswer['status'], body: Record<string, unknown>): WebhookAnswer => {
    m.webhooks.add(1, { outcome });
    m.webhookDuration.record((performance.now() - started) / 1000, { outcome });
    return { status, body };
  };

  if (!verify(rawBody, signature, config.oncadeWebhookSecret)) {
    log.warn('webhook.bad_signature');
    return answer('bad_signature', 401, { error: 'invalid signature', code: 'INVALID_SIGNATURE' });
  }
  const event = parseEvent(rawBody);
  if (!event) return answer('unreadable', 400, { error: 'not an event', code: 'NOT_AN_EVENT' });
  const hint = hintOf(event);
  if (config.recordWebhooks) keepRaw(event.event, rawBody);

  try {
    await inTransaction(async (session) => {
      await col
        .inbox()
        .insertOne({ _id: deliveryKey(rawBody), event: event.event, receivedAt: new Date() }, { session });
      if (hint.kind === 'invoice') {
        const run = hint.invoiceId
          ? await col.runs().findOne({ 'invoice.id': hint.invoiceId }, { session, projection: { _id: 1 } })
          : null;
        if (run) await enqueue(session, 'funding.check', { runId: run._id, path: 'webhook' });
        else await enqueue(session, 'check.all', {});
      } else if (hint.kind === 'distribution') {
        const batch = hint.distributionId
          ? await col.batches().findOne({ 'distribution.id': hint.distributionId }, { session, projection: { _id: 1 } })
          : null;
        if (batch) await enqueue(session, 'batch.sync', { batchId: batch._id });
        else await enqueue(session, 'check.all', {});
      }
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11_000) throw err;
    log.info('webhook.duplicate', { webhook_event: event.event });
    return answer('duplicate', 200, { received: true, duplicate: true });
  }
  log.info('webhook.accepted', { webhook_event: event.event });
  return answer(hint.kind === 'ignored' ? 'ignored' : 'accepted', 200, { received: true });
}
