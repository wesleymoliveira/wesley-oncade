// Spans written by hand, and the trace context that travels with every
// outbox event and queue message, so one trace follows a run across the queue.

import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('payout-runs');

/** The active span as a W3C traceparent header, to store or send along. */
export function currentTraceparent(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx ? `00-${ctx.traceId}-${ctx.spanId}-01` : null;
}

export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

function parentFrom(traceparent: string | null | undefined) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent ?? '');
  if (!match) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: match[1]!, spanId: match[2]!, traceFlags: 1, isRemote: true });
}

/**
 * Runs `work` inside a span. With `continueFrom`, the span joins the trace
 * that published the message instead of starting a new one.
 * An error marks the span as failed and is thrown again.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  continueFrom?: string | null,
): Promise<T> {
  const run = async (span: Span) => {
    try {
      return await work(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : 'error' });
      throw err;
    } finally {
      span.end();
    }
  };
  const parent = parentFrom(continueFrom);
  return parent
    ? tracer.startActiveSpan(name, { attributes }, parent, run)
    : tracer.startActiveSpan(name, { attributes }, run);
}
