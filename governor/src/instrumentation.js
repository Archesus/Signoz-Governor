// The Governor's own OTel setup — deliberately a SEPARATE service.name
// from the agent it watches, so in SigNoz you see two distinct timelines
// side by side: the agent going wrong, and the Governor reasoning about
// it and acting. This is the "self-tracing" piece that's meant to be the
// project's actual differentiator — without this, the Governor is just
// another background job; with it, it's another well-behaved citizen of
// the same observability system it's protecting.
//
// Loaded via `node --import` (see package.json), same pattern as the
// agent's instrumentation.js — must run before any other module.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import 'dotenv/config';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'signoz-governor',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  }),
});

sdk.start();
console.log(`[otel] governor exporting its own traces to ${otlpEndpoint}/v1/traces`);

process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
process.on('beforeExit', () => sdk.shutdown());
