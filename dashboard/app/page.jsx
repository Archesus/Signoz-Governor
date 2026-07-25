'use client';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { StatusBadge } from '../components/StatusBadge';
import { ThemeToggle } from '../components/ThemeToggle';

const GOVERNOR_PORT = process.env.GOVERNOR_PORT || '4001';

// Plain-English fallback if the governor hasn't attached its own
// plainEnglish field yet (older event, or governor not updated). Keeping
// this here too means the dashboard degrades gracefully either way.
const REASON_TEXT = {
  loop_detected: 'This agent kept repeating the same action without making progress, so it was paused.',
  consecutive_failures: 'This agent hit the same error too many times in a row, so it was paused before it wasted more time.',
  cost_velocity: 'This agent started spending money faster than expected, so it was paused to avoid an unexpected bill.',
  absolute_cap_exceeded: 'This agent went over its spending limit, so it was paused.',
  manual_test: 'This was paused manually for testing.',
};

function plainReason(reason, detail, plainEnglish) {
  return plainEnglish || REASON_TEXT[reason] || detail || 'This agent was paused.';
}

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function SessionCard({ session }) {
  const [expanded, setExpanded] = useState(false);
  const isHealthy = session.state === 'monitoring' || session.state === 'healthy';

  return (
    <div className="rounded-xl border border-[hsl(var(--card-border))] bg-[hsl(var(--card))] p-5 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-lg font-medium">{session.agentName || 'Agent'}</div>
          <div className="text-sm text-[hsl(var(--muted))]">{timeAgo(session.startedAt)}</div>
        </div>
        <StatusBadge state={isHealthy ? 'healthy' : 'tripped'} />
      </div>

      <div className="mt-4 flex gap-6 text-sm">
        <div>
          <div className="text-[hsl(var(--muted))]">Spend so far</div>
          <div className="text-base font-medium">${session.spendUsd.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-[hsl(var(--muted))]">Steps taken</div>
          <div className="text-base font-medium">{session.stepCount}</div>
        </div>
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-4 flex items-center gap-1 text-sm text-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] transition-colors"
      >
        {expanded ? 'Hide advanced details' : 'View advanced details'}
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div className="mt-3 rounded-lg bg-black/10 dark:bg-white/5 p-3 text-xs font-mono space-y-1">
          <div>session id: {session.sessionId}</div>
          <div>trace id: {session.traceId || 'pending'}</div>
          <div>raw state: {session.state}</div>
        </div>
      )}
    </div>
  );
}

function EventCard({ event }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-[hsl(var(--card-border))] bg-[hsl(var(--card))] p-5 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-[hsl(var(--muted))]">{timeAgo(event.timestamp)}</div>
        <StatusBadge state="tripped" />
      </div>
      <div className="mt-2 text-base">{plainReason(event.reason, event.detail, event.plainEnglish)}</div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-3 flex items-center gap-1 text-sm text-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] transition-colors"
      >
        {expanded ? 'Hide advanced details' : 'View advanced details'}
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div className="mt-3 rounded-lg bg-black/10 dark:bg-white/5 p-3 text-xs font-mono space-y-1">
          <div>session id: {event.sessionId}</div>
          <div>technical reason: {event.reason}</div>
          <div>detail: {event.detail}</div>
          {event.traceUrl && (
            <div>
              <a href={event.traceUrl} target="_blank" rel="noreferrer" className="underline">
                View raw trace in SigNoz →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [governorUrl, setGovernorUrl] = useState('http://localhost:4001');

  useEffect(() => {
    setGovernorUrl(`http://${window.location.hostname}:${GOVERNOR_PORT}`);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const [statusRes, eventsRes] = await Promise.all([
          fetch(`${governorUrl}/governor/status`),
          fetch(`${governorUrl}/governor/events`),
        ]);
        setStatus(await statusRes.json());
        setEvents((await eventsRes.json()).events || []);
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [governorUrl]);

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold">Your AI Agents</h1>
        <ThemeToggle />
      </div>
      <p className="text-[hsl(var(--muted))] mb-8">
        A live look at what your agents are doing, and when we've stepped in to stop one.
      </p>

      {error && (
        <div className="rounded-xl border border-[hsl(var(--tripped))] p-4 mb-6 text-sm">
          Can't reach the monitoring service right now. ({error})
        </div>
      )}

      {status && (
        <>
          <h2 className="text-lg font-medium mb-3">Active sessions</h2>
          {status.sessions.length === 0 && (
            <p className="text-[hsl(var(--muted))] text-sm mb-8">
              No agents running right now.
            </p>
          )}
          {status.sessions.map((s) => (
            <SessionCard key={s.sessionId} session={s} />
          ))}
        </>
      )}

      <h2 className="text-lg font-medium mt-10 mb-3">Times we've stepped in</h2>
      {events.length === 0 && (
        <p className="text-[hsl(var(--muted))] text-sm">
          Nothing to show yet — this fills in whenever an agent needs to be paused.
        </p>
      )}
      {events.map((e, i) => (
        <EventCard key={`${e.sessionId}-${i}`} event={e} />
      ))}
    </main>
  );
}