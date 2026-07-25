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

function AdvancedDetails({session}) {

  return (
  
  <div
  className="
mt-5
rounded-lg
border
border-[hsl(var(--card-border))]
bg-[hsl(var(--background))]
p-4
space-y-4
text-sm
  "
  >
  
  
  <div>
  
  <p className="text-gray-400 text-xs uppercase">
  Session ID
  </p>
  
  <p className="font-mono">
  {session.sessionId}
  </p>
  
  </div>
  
  
  
  <div>
  
  <p className="text-gray-400 text-xs uppercase">
  Raw State
  </p>
  
  <p>
  {session.state}
  </p>
  
  </div>
  
  
  
  <div>
  
  <p className="text-gray-400 text-xs uppercase">
  Trace
  </p>
  
  
  {
  session.traceId
  ?
  <a
  className="
  text-indigo-400
  hover:underline
  "
  >
  View raw trace in SigNoz →
  </a>
  :
  <p className="text-gray-500">
  Trace pending
  </p>
  }
  
  
  </div>
  
  
  </div>
  
  
  )
  
  }

function SessionCard({ session }) {
  const [expanded, setExpanded] = useState(false);

  const isHealthy =
    session.state === 'monitoring' ||
    session.state === 'healthy';


  return (
    <div className="
    rounded-xl
    border
    border-[hsl(var(--card-border))]
    bg-[hsl(var(--card))]
    text-[hsl(var(--card-foreground))]
    p-5
    mb-5
    shadow-sm
    ">

      {/* Header */}
      <div className="flex justify-between items-center mb-5">

        <div className="
          flex items-center gap-2
          text-xs
          uppercase
          tracking-wide
          border
          border-white/20
          rounded-md
          px-3
          py-1
        ">
          <span className={
            isHealthy
              ? "h-2 w-2 rounded-full bg-green-400"
              : "h-2 w-2 rounded-full bg-red-400"
          } />

          {isHealthy ? "Active Session" : "Tripped Session"}

        </div>


      </div>



      {/* Details */}

      <div className="grid grid-cols-2 gap-y-3 text-sm">


        <span className="text-gray-400">
          AI Agent
        </span>

        <span className="text-right font-semibold">
          {session.agentName || "Agent"}
        </span>



        <span className="text-gray-400">
          Started
        </span>

        <span className="text-right font-semibold">
          {timeAgo(session.startedAt)}
        </span>



        <span className="text-gray-400">
          Status
        </span>

        <span
          className={
            isHealthy
              ? "text-[hsl(var(--healthy))] text-right font-semibold"
              : "text-[hsl(var(--tripped))] text-right font-semibold"
          }
        >
          {isHealthy
            ? "Running Smoothly"
            : "Paused"
          }
        </span>



        <span className="text-gray-400">
          Spend so far
        </span>

        <span className="text-right font-semibold">
          ${session.spendUsd.toFixed(3)} USD
        </span>



        <span className="text-gray-400">
          Steps taken
        </span>

        <span className="text-right font-semibold">
          {session.stepCount}
        </span>


      </div>



      {/* Expand button */}

      <button
        onClick={() => setExpanded(!expanded)}
        className="
          mt-6
          w-full
          flex
          justify-between
          items-center
          rounded-md
          bg-[hsl(var(--primary))]
text-[hsl(var(--primary-foreground))]
hover:opacity-90
          px-4
          py-2
          text-sm
          font-medium
        "
      >

        {expanded
          ? "Hide Advanced Details"
          : "View Advanced Details"
        }


        {
          expanded
            ? <ChevronUp size={16} />
            : <ChevronDown size={16} />
        }

      </button>



      {
        expanded &&
        <AdvancedDetails session={session} />
      }


    </div>
  )
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
    <main className="max-w-7xl mx-auto px-6 py-10">
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

	  <div
className="
grid
grid-cols-1
lg:grid-cols-2
gap-6
w-full
"
>

{
status.sessions.map((s)=>(
  <SessionCard
    key={s.sessionId}
    session={s}
  />
))
}

</div>
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
