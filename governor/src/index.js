import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { runDetectors } from './detectors.js';
import { querySessionSpans, createAlertRule, traceUrl } from './signozClient.js';

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4001;
const AGENT_CONTROL_URL = process.env.AGENT_CONTROL_URL || 'http://localhost:3500';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

const tracer = trace.getTracer('signoz-governor');

// Plain-English text for each detector reason, so the dashboard can show
// something a non-technical person understands instead of a raw
// detector/attribute name. Keep this in sync with detectors.js's reason
// strings -- if a new detector is added there, add its sentence here too.
const PLAIN_ENGLISH_REASONS = {
  loop_detected: 'This agent kept repeating the same action without making progress, so it was paused.',
  consecutive_failures: 'This agent hit the same error too many times in a row, so it was paused before it wasted more time.',
  cost_velocity: 'This agent started spending money faster than expected, so it was paused to avoid an unexpected bill.',
  absolute_cap_exceeded: 'This agent went over its spending limit, so it was paused.',
  manual_test: 'This was paused manually for testing.',
};

function plainEnglishFor(reason) {
  return PLAIN_ENGLISH_REASONS[reason] || 'This agent was paused because something looked wrong.';
}

// sessionId -> { agentName, traceId, spanId, startedAt, state, spendUsd, stepCount, tripped }
const sessions = new Map();
const events = []; // trip history, shown on the dashboard's event feed

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- 1. Agent -> Governor --------------------------------------------------
app.post('/agent/register', (req, res) => {
  const { sessionId, agentName, traceId, spanId, startedAt } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    sessionId,
    agentName: agentName || existing?.agentName || 'unknown-agent',
    traceId: traceId || existing?.traceId || null,
    spanId: spanId || existing?.spanId || null,
    startedAt: startedAt || existing?.startedAt || new Date().toISOString(),
    state: existing?.state || 'monitoring', // monitoring | tripped
    spendUsd: existing?.spendUsd || 0,
    stepCount: existing?.stepCount || 0,
    tripped: existing?.tripped || false,
  });

  console.log(`[governor] registered/updated session ${sessionId} (traceId: ${traceId || 'pending'})`);
  res.json({ acknowledged: true });
});

// --- 2. The actual detection loop -----------------------------------------
async function pollAllSessions() {
  for (const session of sessions.values()) {
    if (session.tripped) continue;
    await pollSession(session);
  }
}

async function pollSession(session) {
  const links = session.traceId && session.spanId
    ? [{ context: { traceId: session.traceId, spanId: session.spanId, traceFlags: 1 } }]
    : [];

  await tracer.startActiveSpan(
    'governor.check_session',
    { kind: SpanKind.INTERNAL, links },
    async (span) => {
      span.setAttribute('session.id', session.sessionId);
      span.setAttribute('agent.name', session.agentName);

      try {
        if (!session.traceId) {
          span.setAttribute('governor.decision', 'skipped_no_trace_id');
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        const spans = await querySessionSpans(session.traceId);
        span.setAttribute('governor.spans_examined', spans.length);

        session.stepCount = spans.length;
        session.spendUsd = spans.reduce((sum, s) => sum + (s.costUsd || 0), 0);

        const trip = runDetectors(spans);

        if (trip) {
          span.setAttribute('governor.decision', 'trip');
          span.setAttribute('governor.trip_reason', trip.reason);
          span.setStatus({ code: SpanStatusCode.OK });
          await tripSession(session, trip.reason, trip.detail);
        } else {
          span.setAttribute('governor.decision', 'healthy');
          span.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        console.error(`[governor] check failed for ${session.sessionId}: ${err.message}`);
      } finally {
        span.end();
      }
    }
  );
}

// --- 3. Governor -> Agent, and Governor -> SigNoz --------------------------
async function tripSession(session, reason, detail) {
  session.state = 'tripped';
  session.tripped = true;

  console.log(`[governor] TRIPPED session ${session.sessionId}: ${reason} — ${detail}`);

  const event = {
    sessionId: session.sessionId,
    type: 'tripped',
    reason,
    detail,
    plainEnglish: plainEnglishFor(reason),
    timestamp: new Date().toISOString(),
    traceUrl: session.traceId ? traceUrl(session.traceId) : null,
  };
  events.unshift(event);

  try {
    await fetch(`${AGENT_CONTROL_URL}/control/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, reason, detail }),
    });
  } catch (err) {
    console.error(`[governor] failed to pause agent: ${err.message}`);
  }

  try {
    await createAlertRule({
      sessionId: session.sessionId,
      reason,
      detail,
      traceId: session.traceId,
    });
  } catch (err) {
    console.error(`[governor] failed to create SigNoz alert rule: ${err.message}`);
  }
}

app.post('/governor/trip', async (req, res) => {
  const { sessionId, reason, detail } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: `unknown sessionId: ${sessionId}` });
  await tripSession(session, reason || 'manual_trigger', detail || 'manually tripped for testing');
  res.json({ tripped: true });
});

// --- 4. Dashboard -> Governor (read-only) -----------------------------------
app.get('/governor/status', (_req, res) => {
  const anyTripped = Array.from(sessions.values()).some((s) => s.tripped);
  res.json({
    state: anyTripped ? 'tripped' : 'monitoring',
    sessions: Array.from(sessions.values()),
  });
});

app.get('/governor/events', (_req, res) => {
  res.json({ events });
});

app.listen(PORT, () => {
  console.log(`[governor] listening on :${PORT}`);
  console.log(`[governor] polling every ${POLL_INTERVAL_MS}ms`);
  setInterval(() => {
    pollAllSessions().catch((err) => console.error(`[governor] poll cycle error: ${err.message}`));
  }, POLL_INTERVAL_MS);
});