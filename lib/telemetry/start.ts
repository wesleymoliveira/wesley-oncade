// Starts OpenTelemetry for one process: traces, metrics and logs, all sent
// over OTLP/HTTP. The backend is whatever answers at OTEL_EXPORTER_OTLP_ENDPOINT
// (locally the Grafana otel-lgtm container).

import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { config } from '../config.ts';

export interface Telemetry {
  /** Sends the metrics collected so far, now. */
  flushMetrics(): Promise<void>;
  /** Flushes what is buffered and stops. Call before the process exits. */
  shutdown(): Promise<void>;
}

const holder = globalThis as { __payoutRunsTelemetry?: Telemetry };

export function startTelemetry(serviceName: string): Telemetry {
  if (holder.__payoutRunsTelemetry) return holder.__payoutRunsTelemetry;
  const base = config.otlpEndpoint;
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
    exportIntervalMillis: config.metricIntervalMs,
  });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.namespace': 'payout-runs',
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) })],
    metricReaders: [metricReader],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }) })],
    // No auto-instrumentation: every span in this project is written by hand
    // or comes from Next.js itself, so nothing depends on module patching.
    instrumentations: [],
  });
  sdk.start();
  holder.__payoutRunsTelemetry = { flushMetrics: () => metricReader.forceFlush(), shutdown: () => sdk.shutdown() };
  return holder.__payoutRunsTelemetry;
}
