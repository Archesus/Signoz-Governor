import express from 'express';
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { runSession } from './agent.js';
import { pauseSession, resumeSession } from './sessionControl.js';

const app = express();
app.use(express.json());

const PORT = process.env.AGENT_CONTROL_PORT || 3500;
const GOVERNOR_URL = process.env.GOVERNOR_URL || 'http://localhost:4001';

async function registerWithGovernor(sessionId, agentName, traceContext) {
  try {
    await fetch(`${GOVERNOR_URL}/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        agentName,
        traceId: traceContext?.traceId ?? null,
        spanId: traceContext?.spanId ?? null, // root span — lets governor build a real span link
        startedAt: new Date().toISOString(),
      }),
    });
  } catch (err) {
    // Governor might not be up — don't crash the agent over it.
    console.warn(`[agent] could not reach governor at ${GOVERNOR_URL}: ${err.message}`);
  }
}

// --- Control endpoints the governor calls (per API_CONTRACT.md) -----------
// These now actually stop a running session (see sessionControl.js +
// agent.js's isPaused() checks), not just log that a pause was requested.

app.post('/control/pause', (req, res) => {
  const { sessionId, reason, detail } = req.body;
  pauseSession(sessionId);
  console.log(`[agent] PAUSE received for ${sessionId} — reason: ${reason} (${detail})`);
  res.json({ paused: true });
});

app.post('/control/resume', (req, res) => {
  const { sessionId } = req.body;
  resumeSession(sessionId);
  console.log(`[agent] RESUME received for ${sessionId}`);
  res.json({ resumed: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Trigger a session on demand, with a mode: "normal" | "loop" | "fail".
// This is what the dashboard's trigger panel calls (Day 4/5), and what
// you'll use by hand on Day 2/3 to reliably reproduce each scenario for
// testing — don't wait for a real agent to misbehave on its own.
//
// NOTE: this responds only after the session finishes (or is paused) —
// for "loop"/"fail" modes that's up to MAX_STUCK_ITERATIONS *
// STUCK_ITERATION_DELAY_MS (see agent.js), so the caller (curl, the
// dashboard, whatever) should expect to wait, not treat this as instant.
app.post('/run', async (req, res) => {
  const task = req.body?.task || 'observability best practices';
  const mode = req.body?.mode || 'normal';
  const sessionId = `sess_${randomUUID().slice(0, 8)}`;

  console.log(`[agent] starting session ${sessionId} — mode: ${mode}, task: "${task}"`);

  try {
    const result = await runSession(sessionId, task, mode, (traceContext) => {
      // Fires the instant the span exists — while a slow loop/fail
      // scenario is still running, so the governor can watch it live.
      registerWithGovernor(sessionId, 'research-agent', traceContext);
    });
    console.log(`[agent] session ${sessionId} finished:`, result);
    res.json({ sessionId, ...result });
  } catch (err) {
    // runSession catches its own errors and returns { outcome: 'error' }
    // rather than throwing, so reaching here means something outside that
    // contract broke — worth knowing distinctly during debugging.
    console.error(`[agent] session ${sessionId} unexpected failure:`, err.message);
    res.status(500).json({ sessionId, error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[agent] control server listening on :${PORT}`);

  // Proof-of-life on startup: run one normal session so there's a trace to
  // look at in SigNoz within seconds of `npm start`, with no manual step.
  // Uses the same onStarted callback path as /run — registering with a
  // real traceId/spanId, not null — so this session is just as span-
  // linkable by the governor as anything triggered through the API.
  const sessionId = `sess_${randomUUID().slice(0, 8)}`;
  console.log(`[agent] running startup demo session ${sessionId}...`);
  const result = await runSession(sessionId, 'What are agent cost overruns?', 'normal', (traceContext) => {
    registerWithGovernor(sessionId, 'research-agent', traceContext);
  });
  console.log(`[agent] startup session result:`, result);
  console.log(`[agent] check SigNoz Traces for service "signoz-governor-demo-agent"`);
});
