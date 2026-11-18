import { config } from '../../../lib/config.ts';
import { db } from '../../../lib/infra/db.ts';
import { log } from '../../../lib/telemetry/log.ts';

export const dynamic = 'force-dynamic';

/**
 * Liveness plus one real dependency check: can we reach the database? Open on purpose, with no secret in it:
 * `setup` is what this process is pointed at, and a script compares it with its own before it creates anything.
 */
export async function GET(): Promise<Response> {
  try {
    await db().command({ ping: 1 });
    return Response.json({ ok: true, setup: config.setup, recordsWebhooks: config.recordWebhooks });
  } catch (err) {
    log.error('health.database_unreachable', { reason: err instanceof Error ? err.name : 'unknown' });
    return Response.json({ ok: false }, { status: 503 });
  }
}
