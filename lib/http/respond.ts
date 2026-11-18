// What every route handler shares: one shape for answers, the token, the run reference of a path.

import { timingSafeEqual } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { config } from '../config.ts';
import { REFERENCE } from '../core/run.ts';
import { log } from '../telemetry/log.ts';

/** JSON with the trace id in a header, so a client can quote it in a support request. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return Response.json(body, { status, headers: { ...headers, ...(traceId ? { 'x-trace-id': traceId } : {}) } });
}

/** Every error has the same shape: a sentence for a person, and a code for a program. One code, one status. */
export function refuse(status: number, code: string, error: string, more: Record<string, unknown> = {}): Response {
  return json({ error, code, ...more }, status);
}

function authorized(request: Request): boolean {
  const sent = Buffer.from(request.headers.get('authorization') ?? '', 'utf8');
  const expected = Buffer.from(`Bearer ${config.appToken}`, 'utf8');
  return config.appToken !== '' && sent.length === expected.length && timingSafeEqual(sent, expected);
}

type Handler<Context> = (request: Request, context: Context) => Promise<Response>;

/**
 * Every route except the signed webhook and health goes through here. The token is checked first: with a tunnel
 * open the whole port is public, and these routes move money. A handler that throws answers 500 in the shape of
 * every other error, with the trace id, and never with the error's own text.
 */
export function guarded<Context = unknown>(handler: Handler<Context>): Handler<Context> {
  return async (request, context) => {
    if (!authorized(request)) return refuse(401, 'UNAUTHORIZED', 'missing or wrong token');
    try {
      return await handler(request, context);
    } catch (err) {
      if (err instanceof Error) trace.getActiveSpan()?.recordException(err);
      log.error('api.unexpected_error', { reason: err instanceof Error ? err.name : 'unknown' });
      return refuse(500, 'INTERNAL_ERROR', 'unexpected error');
    }
  };
}

export interface RunPath {
  params: Promise<{ reference: string }>;
}

/**
 * The run a path names, put on the request's span so the trace is found by it. Null when the text cannot be a
 * reference: then it names no run, and no query is made for it.
 */
export async function runOf(context: RunPath): Promise<string | null> {
  const { reference } = await context.params;
  if (!REFERENCE.test(reference)) return null;
  tagRun(reference);
  return reference;
}

export const noSuchRun = (): Response => refuse(404, 'NOT_FOUND', 'no run with this reference');

export function tagRun(reference: string): void {
  trace.getActiveSpan()?.setAttribute('run.reference', reference);
}
