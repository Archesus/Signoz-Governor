import { trace, SpanStatusCode } from '@opentelemetry/api';
import { search, retrieve, unreliableRetrieve } from './tools.js';
import { isPaused } from './sessionControl.js';

const tracer = trace.getTracer('signoz-governor-demo-agent');

const MODEL = 'gemini-flash-latest'; // alias Google points at current-gen Flash — avoids
                                      // breaking again when they retire a pinned ID

// LLM calls now go through Anurag's gateway proxy instead of calling Gemini
// directly. Same span shape, same cost.usd attribute -- the governor and
// dashboard don't need to know this changed. The only difference: the
// proxy captures REAL usage.total_tokens, which includes hidden reasoning
// tokens Gemini bills for but doesn't break into prompt/completion counts.
// Without this, cost.usd here silently undercounts on any call where the
// model reasons internally -- see the gateway proxy's README for a worked
// example (we measured up to a 35x gap between "visible" and real tokens).
const PROXY_BASE = process.env.PROXY_BASE || 'http://localhost:9000';

// Kept only as the last-resort fallback price if the proxy ever omits a
// cost figure -- the proxy is the source of truth for pricing now, not
// this file. See gateway-proxy/app/config.py PRICING for the real table.
const FALLBACK_PRICE_PER_INPUT_TOKEN_USD = 0.075 / 1_000_000;
const FALLBACK_PRICE_PER_OUTPUT_TOKEN_USD = 0.30 / 1_000_000;

/**
 * Runs one full agent session.
 * (unchanged from the original -- see comments below on runLlmSpan for
 * what actually changed.)
 */
export async function runSession(sessionId, task, mode = 'normal', onStarted) {
  return tracer.startActiveSpan('agent.session', async (sessionSpan) => {
    const { traceId, spanId } = sessionSpan.spanContext();
    if (onStarted) onStarted({ traceId, spanId });
    sessionSpan.setAttribute('session.id', sessionId);
    sessionSpan.setAttribute('gen_ai.agent.name', 'research-agent');
    sessionSpan.setAttribute('agent.task', task);
    sessionSpan.setAttribute('agent.mode', mode);

    try {
      let result;
      if (mode === 'loop') {
        result = await runLoopScenario(sessionId, task);
      } else if (mode === 'fail') {
        result = await runFailScenario(sessionId);
      } else if (mode === 'costly') {
        result = await runCostlyScenario(sessionId);
      } else {
        result = await runNormalScenario(task);
      }

      sessionSpan.setAttribute('agent.outcome', result.outcome);
      sessionSpan.setStatus({ code: SpanStatusCode.OK });
      return { ...result, traceId };
    } catch (err) {
      sessionSpan.recordException(err);
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      return { outcome: 'error', error: err.message, traceId };
    } finally {
      sessionSpan.end();
    }
  });
}

async function runNormalScenario(task) {
  const searchResult = await runToolSpan('search', { query: task }, () => search(task));

  if (!searchResult.found) {
    return { outcome: 'no_results' };
  }

  const doc = await runToolSpan('retrieve', { docId: searchResult.docId }, () =>
    retrieve(searchResult.docId)
  );

  const reasoning = await runLlmSpan('reason', [
    `Using this context: "${doc.content}"\n\nAnswer briefly: ${task}`,
  ]);

  return { outcome: 'success', answer: reasoning };
}

const MAX_STUCK_ITERATIONS = 25;
const STUCK_ITERATION_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoopScenario(sessionId, task) {
  const args = { query: task };
  for (let i = 0; i < MAX_STUCK_ITERATIONS; i++) {
    if (isPaused(sessionId)) {
      return { outcome: 'paused_by_governor', iterationsCompleted: i };
    }
    await runToolSpan('search', args, () => search(task));
    await delay(STUCK_ITERATION_DELAY_MS);
  }
  return { outcome: 'loop_exhausted_uncaught', iterationsCompleted: MAX_STUCK_ITERATIONS };
}

async function runFailScenario(sessionId) {
  for (let i = 0; i < MAX_STUCK_ITERATIONS; i++) {
    if (isPaused(sessionId)) {
      return { outcome: 'paused_by_governor', iterationsCompleted: i };
    }
    try {
      await runToolSpan('retrieve', { docId: `nonexistent-doc-${i}` }, () => unreliableRetrieve());
    } catch {
      // expected
    }
    await delay(STUCK_ITERATION_DELAY_MS);
  }
  return { outcome: 'failures_exhausted_uncaught', iterationsCompleted: MAX_STUCK_ITERATIONS };
}

async function runCostlyScenario(sessionId) {
  for (let i = 0; i < MAX_STUCK_ITERATIONS; i++) {
    if (isPaused(sessionId)) {
      return { outcome: 'paused_by_governor', iterationsCompleted: i };
    }
    try {
      await runLlmSpan('costly_call', ['Reply with just the single word: ok']);
    } catch {
      // keep going even if one call errors
    }
    await delay(STUCK_ITERATION_DELAY_MS);
  }
  return { outcome: 'cost_exhausted_uncaught', iterationsCompleted: MAX_STUCK_ITERATIONS };
}

async function runToolSpan(toolName, args, fn) {
  return tracer.startActiveSpan(`tool.${toolName}`, async (span) => {
    span.setAttribute('gen_ai.tool.name', toolName);
    span.setAttribute('gen_ai.tool.call.arguments', JSON.stringify(args));
    try {
      const result = await fn();
      span.setAttribute('gen_ai.tool.call.result', JSON.stringify(result).slice(0, 500));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps an LLM call in a span carrying real GenAI semantic-convention
 * attributes, plus a cost.usd attribute the governor sums directly.
 *
 * CHANGED: now calls the gateway proxy's /gemini/v1/chat/completions
 * instead of the Gemini SDK directly. Same span shape as before -- the
 * governor and dashboard need no changes. The proxy also does its own
 * OTel export of this same call, so you may see a second, separate
 * gen_ai.chat span from the proxy's own service -- that's expected and is
 * itself useful (it's the proxy's independent record of the same call).
 */
async function runLlmSpan(stepName, contents) {
  return tracer.startActiveSpan(`llm.${stepName}`, async (span) => {
    span.setAttribute('gen_ai.system', 'gemini');
    span.setAttribute('gen_ai.provider.name', 'gcp.gemini');
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.request.model', MODEL);

    try {
      const res = await fetch(`${PROXY_BASE}/gemini/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: contents.join('\n') }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        const err = new Error(`proxy returned ${res.status}: ${errBody}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const usage = data.usage || {};
      const inputTokens = usage.prompt_tokens ?? 0;
      const completionTokens = usage.completion_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? (inputTokens + completionTokens);
      // billable output includes any hidden reasoning tokens beyond the
      // visible completion count -- see gateway-proxy/app/main.py for the
      // matching server-side logic this mirrors
      const billableOutput = Math.max(totalTokens - inputTokens, completionTokens);
      const costUsd =
        inputTokens * FALLBACK_PRICE_PER_INPUT_TOKEN_USD +
        billableOutput * FALLBACK_PRICE_PER_OUTPUT_TOKEN_USD;

      span.setAttribute('gen_ai.response.model', MODEL);
      span.setAttribute('gen_ai.usage.input_tokens', inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', completionTokens);
      span.setAttribute('gen_ai.usage.total_tokens', totalTokens);
      span.setAttribute('cost.usd', costUsd);
      span.setStatus({ code: SpanStatusCode.OK });

      return data.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      const isModelUnavailable = err?.status === 404 || /no longer available/i.test(err?.message || '');
      if (isModelUnavailable) {
        console.error(
          `[agent] Model "${MODEL}" returned 404/unavailable via the proxy -- check the proxy's ` +
          `own logs and https://ai.google.dev/gemini-api/docs/models for a current model ID.`
        );
        span.setAttribute('error.type', 'model_unavailable');
      }
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
