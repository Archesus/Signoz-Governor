'use client';

import { useEffect, useState } from 'react';

const GOVERNOR_PORT = process.env.GOVERNOR_PORT || '4001';

export default function StatusPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [governorUrl, setGovernorUrl] = useState('http://localhost:4001');

  useEffect(() => {
    // Derive the governor's address from whatever host you're viewing this
    // page at (localhost, an EC2 public IP, an SSH-tunnel hostname, etc.)
    // instead of hardcoding one — the governor always runs on the same box
    // as this dashboard, just on a different port. This means it keeps
    // working even when your EC2 instance gets a new public IP after a
    // stop/start, with no .env edit needed.
    setGovernorUrl(`http://${window.location.hostname}:${GOVERNOR_PORT}`);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch(`${governorUrl}/governor/status`);
        setStatus(await res.json());
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
    <main>
      <h1>SigNoz Governor — Day 1 shell</h1>
      <p style={{ opacity: 0.6 }}>
        This is intentionally bare. Real design pass is a Day 4 task — today
        just proves governor → dashboard is live.
      </p>

      {error && (
        <div className="card state-tripped">
          Can't reach governor at {governorUrl} — is it running? ({error})
        </div>
      )}

      {status && (
        <>
          <div className="card">
            <strong>Governor state:</strong>{' '}
            <span className={`state-${status.state}`}>{status.state}</span>
          </div>

          <h2>Sessions</h2>
          {status.sessions.length === 0 && (
            <p style={{ opacity: 0.6 }}>
              No sessions registered yet — run the agent (`npm start` in
              /agent) to see one appear here.
            </p>
          )}
          {status.sessions.map((s) => (
            <div className="card" key={s.sessionId}>
              <div>
                <strong>{s.sessionId}</strong> — {s.agentName}
              </div>
              <div className={`state-${s.state}`}>{s.state}</div>
              <div style={{ opacity: 0.6, fontSize: '0.85rem' }}>
                spend: ${s.spendUsd.toFixed(4)} · steps: {s.stepCount}
              </div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
