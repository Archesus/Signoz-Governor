// Shared pause state between the Express control endpoints (index.js) and
// the actual running scenario loop (agent.js). Without this, "pause" was
// only ever a log line — /control/pause set a flag nobody read. This is
// what makes the pause real: a running loop checks isPaused() between
// iterations and actually stops, mid-flight, when the governor calls in.

const state = new Map(); // sessionId -> { paused: boolean }

export function pauseSession(sessionId) {
  state.set(sessionId, { paused: true });
}

export function resumeSession(sessionId) {
  state.set(sessionId, { paused: false });
}

export function isPaused(sessionId) {
  return state.get(sessionId)?.paused === true;
}
