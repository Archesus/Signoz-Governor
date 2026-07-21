// instrumentation.js
//
// This file MUST be loaded before any other module (that's why package.json
// runs it via `node --import ./src/instrumentation.js`). OpenTelemetry needs
// to patch things before your app code runs, so import order matters here in
// a way it usually doesn't in JS.
//
// This is the actual Day 1 lesson: how to get an agent's steps into SigNoz
// as spans that carry real GenAI semantic-convention attributes, so later
// (Day 2/3) the governor can query for specific patterns like "3 identical
// tool calls in a row" instead of just eyeballing a dashboard.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import 'dotenv/config';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'signoz-governor-demo-agent',
  }),
  traceExporter: new OTLPTraceExporter({
    // SigNoz's collector expects traces on /v1/traces
    url: `${otlpEndpoint}/v1/traces`,
  }),
});

sdk.start();

console.log(`[otel] exporting traces to ${otlpEndpoint}/v1/traces`);

// Flush spans on exit so short-lived runs (like this demo agent) don't lose
// their last few spans in the export buffer when the process ends.
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
process.on('beforeExit', () => sdk.shutdown());
