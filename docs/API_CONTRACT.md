# API Contract — agree on this before splitting up on Day 1

Two services, three interfaces. This is the whole surface area between
Person A's agent and Person B's governor. If you need to change something
here after today, tell each other before you do it — don't let the two
sides silently drift apart.

## 1. Agent → Governor (registration)

The agent tells the governor a session exists, so the governor knows what
to watch for in SigNoz. It does **not** send trace data directly — the
governor pulls that from SigNoz itself. This call just says "this session ID
is live, go watch it."

```
POST http://localhost:4001/agent/register
Content-Type: application/json

{
  "sessionId": "sess_1a2b3c",     // matches the trace's session.id attribute
  "agentName": "research-agent",
  "traceId": "abc123...",          // OTel trace ID, sent as soon as it exists (may be null briefly)
  "spanId": "def456...",           // root span ID — governor uses this + traceId to build a
                                    // real OTel span link back to this session's trace
  "startedAt": "2026-07-20T10:00:00Z"
}

→ 200 { "acknowledged": true }
```

## 2. Governor → Agent (control)

When the governor decides to intervene, it calls back into the agent. The
agent must expose this endpoint and actually honor it (stop making further
LLM/tool calls once paused).

```
POST http://localhost:3500/control/pause     ← implemented by the AGENT
Content-Type: application/json

{
  "sessionId": "sess_1a2b3c",
  "reason": "loop_detected",        // one of: loop_detected | cost_velocity | consecutive_failures
  "detail": "identical tool call 'search' with same args x3"
}

→ 200 { "paused": true }
```

```
POST http://localhost:3500/control/resume    ← implemented by the AGENT
{ "sessionId": "sess_1a2b3c" }
→ 200 { "resumed": true }
```

## 3. Dashboard → Governor (status, read-only)

```
GET http://localhost:4001/governor/status

→ 200
{
  "state": "monitoring",     // monitoring | tripped | paused
  "sessions": [
    {
      "sessionId": "sess_1a2b3c",
      "agentName": "research-agent",
      "state": "healthy",     // healthy | warning | tripped
      "lastChecked": "2026-07-20T10:04:12Z",
      "spendUsd": 0.043,
      "stepCount": 7
    }
  ]
}
```

```
GET http://localhost:4001/governor/events

→ 200
{
  "events": [
    {
      "sessionId": "sess_1a2b3c",
      "type": "tripped",
      "reason": "loop_detected",
      "timestamp": "2026-07-20T10:05:00Z",
      "traceUrl": "http://localhost:8080/trace/abcd1234"   // deep link into real SigNoz trace
    }
  ]
}
```

## Ports, for reference

| Service | Port |
|---|---|
| SigNoz UI | 8080 |
| SigNoz OTLP HTTP ingest | 4318 |
| Agent (control endpoints) | 3500 |
| Governor | 4001 |
| Dashboard (Next.js) | 3000 |

## Non-negotiable rule

The dashboard never talks to the agent directly, and never talks to SigNoz
directly. Everything flows through the governor. This keeps the "SigNoz is
the single source of truth" property honest — if the dashboard could bypass
the governor, we'd be tempted to fake data, and that's exactly the trap we
called out as dishonest for other teams to fall into.
