// Fake tools, on purpose. The point of this demo agent isn't to build a real
// search engine — it's to have full control over timing and behavior so that
// on Day 2 we can deliberately trigger the failure modes (loops, cost
// spikes, repeated failures) on demand and prove the governor catches them.

const FAKE_DOCS = {
  'observability best practices': 'Correlate traces, metrics, and logs on one timeline to cut mean-time-to-resolution.',
  'agent cost overruns': 'Runaway retry loops are the most common cause of surprise LLM bills in production agents.',
  'opentelemetry semantic conventions': 'GenAI semantic conventions standardize span attributes like gen_ai.usage.input_tokens across vendors.',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function search(query) {
  await delay(150 + Math.random() * 150);
  const key = Object.keys(FAKE_DOCS).find((k) => query.toLowerCase().includes(k.split(' ')[0]));
  if (!key) {
    return { found: false, query };
  }
  return { found: true, query, docId: key, snippet: FAKE_DOCS[key].slice(0, 40) + '...' };
}

export async function retrieve(docId) {
  await delay(100 + Math.random() * 100);
  const content = FAKE_DOCS[docId];
  if (!content) {
    throw new Error(`no document found for docId="${docId}"`);
  }
  return { docId, content };
}

// Always throws — used only by agent.js's "fail" scenario to deterministically
// produce the consecutive-failure pattern (same tool, erroring, repeatedly)
// on demand, instead of hoping a real failure happens during a live demo.
export async function unreliableRetrieve() {
  await delay(100 + Math.random() * 100);
  throw new Error('simulated downstream error: retrieval service unavailable');
}
