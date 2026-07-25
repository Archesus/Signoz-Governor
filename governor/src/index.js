import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { runDetectors } from './detectors.js';
import { querySessionSpans, createAlertRule, traceUrl } from './signozClient.js';
import { explainTrip, notifyTrip } from './notify.js';

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4001;
const AGENT_CONTROL_URL = process.env.AGENT_CONTROL_URL || 'http://localhost:3500';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

const tracer = trace.getTracer('signoz-governor');

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
// Every POLL_INTERVAL_MS, for every session that hasn't already tripped,
// pull its current span list from SigNoz and run the baseline detectors
// against it. This whole function is wrapped in its own self-traced span
// (with a link back to the agent's trace, once known) so the Governor's
// own reasoning shows up in SigNoz as a first-class citizen, not a black
// box making decisions off-screen.
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
        // A failed check should never crash the poll loop for other
        // sessions — log it on this session's own span and move on.
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        console.error(`[governor] check failed for ${session.sessionId}: ${err.message}`);
      } finally {
        span.end();
      }
    }
  );
}

// --- 3. Governor -> Agent, Governor -> SigNoz, Governor -> your own webhook -
// When a detector trips: pause the agent (real, immediate effect — see
// agent/src/sessionControl.js), create a real SigNoz alert rule labeled
// `source: governor` (routes through the policy configured in the SigNoz
// UI — README Step 0), AND send a direct webhook notification from this
// service. That third step is deliberate, not redundant: SigNoz's own
// alert evaluator has a known live reliability issue on this project (see
// signozClient.js), so this is a second, independent guarantee that a
// trip produces a real, visible notification even if that evaluator
// doesn't fire — this path never depends on it.
async function tripSession(session, reason, detail) {
  session.state = 'tripped';
  session.tripped = true;

  const plainEnglish = explainTrip({ reason, detail, agentName: session.agentName, sessionId: session.sessionId });
  console.log(`[governor] TRIPPED session ${session.sessionId}: ${reason} — ${detail}`);

  const sessionTraceUrl = session.traceId ? traceUrl(session.traceId) : null;

  const event = {
    sessionId: session.sessionId,
    type: 'tripped',
    reason,
    detail,
    plainEnglish,
    timestamp: new Date().toISOString(),
    traceUrl: sessionTraceUrl,
  };
  events.unshift(event);

  // Pause first — stopping the bleeding matters more than the paperwork,
  // and pause has no external dependency, so do it even if the alert
  // creation or notification below fails.
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
    // Don't let a SigNoz API hiccup undo the pause — the session is still
    // safely stopped even if the alert-rule creation itself fails. Log
    // loudly since this is the "hero moment" — you want to know instantly
    // if it's broken, not discover it during the demo.
    console.error(`[governor] failed to create SigNoz alert rule: ${err.message}`);
  }

  const notifyResult = await notifyTrip({ session, reason, detail, plainEnglish, traceUrl: sessionTraceUrl });
  if (notifyResult.sent) {
    console.log(`[governor] webhook notification sent for ${session.sessionId}`);
  } else if (notifyResult.why !== 'GOVERNOR_WEBHOOK_URL not set') {
    console.error(`[governor] webhook notification not sent: ${notifyResult.why}`);
  }
}

// Manual trip endpoint — lets you test the pause+alert plumbing directly,
// without waiting for a detector to fire. Useful for Day 3 debugging.
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
