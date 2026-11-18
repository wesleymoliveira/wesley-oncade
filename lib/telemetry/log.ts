// One logger for the whole project. Each call writes a JSON line to stdout and
// sends the same record over OpenTelemetry. The trace id of the active span is
// added to both, so a log line always leads to its trace.
//
// Rule: never pass a secret, an e-mail address or a wallet. Pass ids.

import { logs, SeverityNumber, trace } from '@opentelemetry/api';

type Level = 'info' | 'warn' | 'error';
/** A field with one of these names would overwrite the line's own, so the compiler refuses it. */
type Reserved = 'time' | 'level' | 'event' | 'trace_id' | 'span_id';
type Fields = Record<string, string | number | boolean | undefined> & Partial<Record<Reserved, never>>;

const SEVERITY: Record<Level, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function write(level: Level, event: string, fields: Fields): void {
  const span = trace.getActiveSpan()?.spanContext();
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<
    string,
    string | number | boolean
  >;
  const line = {
    time: new Date().toISOString(),
    level,
    event,
    ...clean,
    trace_id: span?.traceId,
    span_id: span?.spanId,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  logs.getLogger('payout-runs').emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: event,
    attributes: clean,
  });
}

export const log = {
  info: (event: string, fields: Fields = {}) => write('info', event, fields),
  warn: (event: string, fields: Fields = {}) => write('warn', event, fields),
  error: (event: string, fields: Fields = {}) => write('error', event, fields),
};
