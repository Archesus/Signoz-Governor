// Two things live here, both added specifically to make a Governor "trip"
// undeniable and understandable the moment it happens — independent of
// whether SigNoz's own alert evaluator decides to fire a notification
// (a known live risk on this project — see signozClient.js's note on
// GitHub issue #10823, where a rule can be created successfully and never
// actually notify anyone).
//
// 1. explainTrip() turns a machine-readable reason code (e.g.
//    "loop_detected") into a one-sentence, human explanation of what
//    actually happened — for the dashboard and any notification.
// 2. notifyTrip() sends that explanation to a webhook directly from this
//    service, the moment a session trips. This is deliberately NOT the
//    same path as SigNoz's own alert-rule notification — it's a second,
//    independent guarantee that something visible happens on trip, so a
//    live demo doesn't depend on SigNoz's evaluator behaving.

/**
 * Converts a detector's reason code + detail string into one plain
 * sentence a non-technical viewer (a judge, your guide) can read and
 * immediately understand — no code, no jargon, no attribute names.
 */
export function explainTrip({ reason, detail, agentName, sessionId }) {
  const who = agentName || 'The agent';

  switch (reason) {
    case 'sensitive_tool_call':
      return `${who} called a sensitive tool it has no normal reason to use — ` +
        `something with a real-world effect outside its own task, like sending ` +
        `email or deleting data — so the Governor paused it immediately for a ` +
        `human to review. (${detail})`;

    case 'suspicious_tool_arguments':
      return `${who} made a tool call containing text that matches a known ` +
        `prompt-injection pattern — the kind of phrasing used to try to hijack ` +
        `an agent's instructions — so the Governor paused it immediately. (${detail})`;

    case 'loop_detected':
      return `${who} got stuck repeating the exact same action over and over ` +
        `without making progress, so the Governor paused it. (${detail})`;

    case 'consecutive_failures':
      return `${who} tried several times in a row and failed every time, with ` +
        `no successful attempt in between, so the Governor paused it before it ` +
        `could keep burning time and money on a broken path. (${detail})`;

    case 'absolute_cap_exceeded':
      return `${who}'s single task ran up a cost past the safety limit — not from ` +
        `any one expensive step, but from many small steps adding up — so the ` +
        `Governor paused it before the bill grew further. (${detail})`;

    case 'cost_velocity_exceeded':
      return `${who}'s spending suddenly sped up — burning money much faster than ` +
        `normal in a short stretch — so the Governor paused it before that pace ` +
        `could continue. (${detail})`;

    case 'manual_trigger':
      return `${who} was paused manually for testing. (${detail})`;

    default:
      return `${who} was paused by the Governor for an unrecognized reason ` +
        `("${reason}"). (${detail})`;
  }
}

/**
 * Sends the trip explanation to a webhook — Slack incoming webhooks work
 * as-is (they accept a bare {"text": "..."} POST body); any other webhook
 * receiver that accepts JSON will also get a usable payload.
 *
 * Silently does nothing if GOVERNOR_WEBHOOK_URL isn't set, rather than
 * erroring — this feature is additive, not required for the Governor's
 * core job (detect + pause), so a missing/misconfigured webhook should
 * never take down the trip flow itself.
 */
export async function notifyTrip({ session, reason, detail, plainEnglish, traceUrl }) {
  const webhookUrl = process.env.GOVERNOR_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, why: 'GOVERNOR_WEBHOOK_URL not set' };

  const lines = [
    `🛑 *Governor trip* — session \`${session.sessionId}\` (${session.agentName})`,
    plainEnglish,
    `Reason code: \`${reason}\``,
  ];
  if (traceUrl) lines.push(`Trace: ${traceUrl}`);

  const body = { text: lines.join('\n') };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook returned ${res.status}: ${text}`);
    }
    return { sent: true };
  } catch (err) {
    // Same philosophy as createAlertRule in signozClient.js: log loudly,
    // never let this failure undo the pause that already happened.
    console.error(`[governor] webhook notification failed: ${err.message}`);
    return { sent: false, why: err.message };
  }
}
