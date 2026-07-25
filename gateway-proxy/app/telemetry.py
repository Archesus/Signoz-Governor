import logging

from opentelemetry import trace, metrics
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

from app.config import OTEL_ENDPOINT, SERVICE_NAME

resource = Resource.create({"service.name": SERVICE_NAME})

# --- Tracing ------------------------------------------------------------
trace_provider = TracerProvider(resource=resource)
trace_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=OTEL_ENDPOINT, insecure=True))
)
trace.set_tracer_provider(trace_provider)
tracer = trace.get_tracer(SERVICE_NAME)

# --- Metrics --------------------------------------------------------------
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint=OTEL_ENDPOINT, insecure=True)
)
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))
meter = metrics.get_meter(SERVICE_NAME)

request_counter = meter.create_counter(
    "ai_gateway.requests", description="Number of AI provider requests"
)
token_histogram = meter.create_histogram(
    "ai_gateway.tokens", description="Tokens used per request (input+output)"
)
cost_histogram = meter.create_histogram(
    "ai_gateway.cost_usd", description="Estimated cost per request in USD"
)

# --- Trace-correlated logging ---------------------------------------------
# Deliberately NOT using logging.basicConfig() here -- that configures the
# ROOT logger, which every third-party library (httpx, uvicorn, etc.) also
# logs through. Since our trace-ID field is only meaningful for our own
# log lines, applying it root-wide made httpx's internal log calls crash
# with KeyError: 'otelTraceID' (they don't have that field). Instead, give
# our own logger its own handler + formatter and leave everyone else's
# default logging untouched.
class TraceContextFilter(logging.Filter):
    def filter(self, record):
        span = trace.get_current_span()
        ctx = span.get_span_context()
        record.otelTraceID = format(ctx.trace_id, "032x") if ctx.trace_id else "0"
        return True


logger = logging.getLogger("ai_gateway")
logger.setLevel(logging.INFO)
logger.propagate = False  # don't also send these lines up to the root logger

_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("%(asctime)s %(levelname)s [trace_id=%(otelTraceID)s] %(message)s")
)
logger.addFilter(TraceContextFilter())
logger.addHandler(_handler)


def record_usage(provider: str, model: str, input_tokens: int, output_tokens: int, cost: float, status: str):
    attrs = {"gen_ai.system": provider, "gen_ai.request.model": model, "status": status}
    request_counter.add(1, attrs)
    token_histogram.record(input_tokens + output_tokens, attrs)
    cost_histogram.record(cost, attrs)
