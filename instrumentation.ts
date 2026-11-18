// Next.js calls register() once when the server starts, before any route loads.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startTelemetry } = await import('./lib/telemetry/start.ts');
    startTelemetry('payout-runs-api');
    const { ensureIndexes } = await import('./lib/infra/store.ts');
    await ensureIndexes();
    const { primeCounters } = await import('./lib/telemetry/metrics.ts');
    primeCounters();
  }
}
