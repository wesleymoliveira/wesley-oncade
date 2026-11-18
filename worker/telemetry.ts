// Imported first by worker/main.ts, on purpose: metric instruments are
// created when lib/telemetry/metrics.ts loads, and they only record if the
// SDK is already running by then.
import { startTelemetry } from '../lib/telemetry/start.ts';

export const telemetry = startTelemetry('payout-runs-worker');
