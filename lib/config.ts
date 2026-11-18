// Every setting the code reads, in one place, with the local default.
// Secrets are read here too, and nothing in the project logs this object.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_KEY } from './oncade/http.ts';

/** An empty line in .env counts as not set. */
const read = (name: string): string | undefined => process.env[name] || undefined;

const standInUrl = read('STAND_IN_URL') ?? 'http://127.0.0.1:3310';
/**
 * `PROVIDER=oncade` points a process at the Oncade test API: the scripts whose name ends in `:oncade` set it.
 * Anything else is the local stand-in, which needs no credentials.
 */
const usingStandIn = read('PROVIDER') !== 'oncade';
/** With the stand-in a fixed fake key is used, so the real one never leaves .env. */
const oncadeApiKey = usingStandIn ? 'oncade_platform_test_00000000' : (read('API_KEY') ?? '');
// Each provider has its own database and queue: a demo wipes its data, and a worker pointed at Oncade must
// never find a run that was made for the stand-in.
const mongoDb = read('MONGO_DB') ?? (usingStandIn ? 'payout_runs' : 'payout_runs_real');
const queueName = read('QUEUE_NAME') ?? (usingStandIn ? 'payout-runs-work' : 'payout-runs-real');

/** The probe (`npm run check-api -- probe`) saves the business id here. */
function savedBusinessId(): string | undefined {
  const file = join(process.cwd(), '.local', 'oncade.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { businessId?: string }).businessId;
}

export const config = {
  mongoUrl: read('MONGO_URL') ?? 'mongodb://127.0.0.1:27027/?replicaSet=rs0',
  mongoDb,

  // ElasticMQ locally. On AWS these would be the real region and no endpoint.
  queueEndpoint: read('SQS_ENDPOINT') ?? 'http://127.0.0.1:9324',
  queueRegion: read('SQS_REGION') ?? 'elasticmq',
  queueName,
  /** After this many receives without success a message moves to the dead-letter queue. */
  queueMaxReceives: 3,

  otlpEndpoint: read('OTEL_EXPORTER_OTLP_ENDPOINT') ?? 'http://127.0.0.1:4318',
  metricIntervalMs: Number(read('METRIC_INTERVAL_MS') ?? 5_000),

  appUrl: read('APP_URL') ?? 'http://127.0.0.1:3300',
  /** Guards every route except the signed webhook and health. Outside the stand-in it must be set. */
  appToken: read('APP_TOKEN') ?? (usingStandIn ? 'stand-in-token' : ''),

  standInUrl,
  usingStandIn,
  /** What a process is pointed at. The API, the worker and a script must agree before anything is created. */
  setup: { provider: usingStandIn ? 'stand-in' : 'oncade', database: mongoDb, queue: queueName },
  oncadeBaseUrl: usingStandIn ? standInUrl : 'https://www.oncade.gg',
  oncadeApiKey,
  oncadeBusinessId: usingStandIn ? '000000000000000000000000' : (savedBusinessId() ?? ''),
  /** Like the key: with the stand-in a fixed one is used, whatever .env holds. */
  oncadeWebhookSecret: usingStandIn ? 'stand-in-webhook-secret' : (read('ONCADE_WEBHOOK_SECRET') ?? ''),
  /** Keeps each verified delivery under .local/raw, to build fixtures from real payloads. Never the stand-in's. */
  recordWebhooks: !usingStandIn && read('RECORD_WEBHOOKS') === 'yes',
  oncadeTimeoutMs: Number(read('ONCADE_TIMEOUT_MS') ?? 10_000),

  /**
   * Funding typed in by an operator counts only with the stand-in or a test key, so it can never release real
   * money. It is labelled as simulated everywhere.
   */
  allowSimulatedFunding: usingStandIn || TEST_KEY.test(oncadeApiKey),

  /** Where our own customer is told about a run. Empty means "tell nobody". */
  customerWebhookUrl: read('CUSTOMER_WEBHOOK_URL') ?? (usingStandIn ? `${standInUrl}/__sink/webhooks` : ''),
  /** Signs what we send to our customer. Only the stand-in has a default: a real one is never a text in this file. */
  customerWebhookSecret: read('CUSTOMER_WEBHOOK_SECRET') ?? (usingStandIn ? 'customer-webhook-secret' : ''),

  batchLeaseMs: Number(read('BATCH_LEASE_MS') ?? 30_000),
  sweepIntervalMs: Number(read('SWEEP_INTERVAL_MS') ?? 10_000),
  breaker: {
    threshold: Number(read('BREAKER_THRESHOLD') ?? 3),
    coolDownMs: Number(read('BREAKER_COOL_DOWN_MS') ?? 10_000),
  },
} as const;
