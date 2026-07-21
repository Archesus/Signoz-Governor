import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLoop, detectConsecutiveFailures, detectAbsoluteCap, runDetectors } from './detectors.js';

function span(overrides = {}) {
  return {
    toolName: 'search',
    toolArgs: JSON.stringify({ query: 'x' }),
    hasError: false,
    costUsd: 0,
    ...overrides,
  };
}

// --- detectLoop -------------------------------------------------------

test('detectLoop: does not trip on a normal, varied session', () => {
  const spans = [
    span({ toolName: 'search', toolArgs: 'a' }),
    span({ toolName: 'retrieve', toolArgs: 'b' }),
  ];
  assert.equal(detectLoop(spans), null);
});

test('detectLoop: does not trip on 2 identical calls (below threshold)', () => {
  const spans = [span({ toolArgs: 'same' }), span({ toolArgs: 'same' })];
  assert.equal(detectLoop(spans), null);
});

test('detectLoop: trips on exactly 3 identical calls', () => {
  const spans = [span({ toolArgs: 'same' }), span({ toolArgs: 'same' }), span({ toolArgs: 'same' })];
  const result = detectLoop(spans);
  assert.ok(result);
  assert.equal(result.reason, 'loop_detected');
});

test('detectLoop: does NOT trip when args differ even if tool name repeats', () => {
  // This is the specific false-positive case called out in the code
  // comments: same tool, legitimately different args, should not trip.
  const spans = [
    span({ toolArgs: 'query-1' }),
    span({ toolArgs: 'query-2' }),
    span({ toolArgs: 'query-3' }),
  ];
  assert.equal(detectLoop(spans), null);
});

test('detectLoop: a broken streak resets the count', () => {
  const spans = [
    span({ toolArgs: 'same' }),
    span({ toolArgs: 'same' }),
    span({ toolArgs: 'different' }), // breaks the streak
    span({ toolArgs: 'same' }),
    span({ toolArgs: 'same' }),
  ];
  assert.equal(detectLoop(spans), null); // never reaches 3 in a row
});

// --- detectConsecutiveFailures -----------------------------------------

test('detectConsecutiveFailures: does not trip on 2 errors with a success between', () => {
  const spans = [span({ hasError: true }), span({ hasError: false }), span({ hasError: true })];
  assert.equal(detectConsecutiveFailures(spans), null);
});

test('detectConsecutiveFailures: trips on 3 consecutive errors', () => {
  const spans = [span({ hasError: true }), span({ hasError: true }), span({ hasError: true })];
  const result = detectConsecutiveFailures(spans);
  assert.ok(result);
  assert.equal(result.reason, 'consecutive_failures');
});

test('detectConsecutiveFailures: a success in the middle resets the streak', () => {
  const spans = [
    span({ hasError: true }),
    span({ hasError: true }),
    span({ hasError: false }),
    span({ hasError: true }),
    span({ hasError: true }),
  ];
  assert.equal(detectConsecutiveFailures(spans), null);
});

// --- detectAbsoluteCap ---------------------------------------------------

test('detectAbsoluteCap: does not trip under the cap', () => {
  const spans = [span({ costUsd: 0.1 }), span({ costUsd: 0.1 })];
  assert.equal(detectAbsoluteCap(spans, { maxCostUsd: 0.5 }), null);
});

test('detectAbsoluteCap: trips when cumulative cost crosses the cap, even with no single spike', () => {
  // This is the specific case the rule was added for: many small,
  // individually-unremarkable costs that add up.
  const spans = Array.from({ length: 20 }, () => span({ costUsd: 0.03 })); // 20 * 0.03 = 0.6
  const result = detectAbsoluteCap(spans, { maxCostUsd: 0.5 });
  assert.ok(result);
  assert.equal(result.reason, 'absolute_cap_exceeded');
});

// --- runDetectors (priority order) --------------------------------------

test('runDetectors: returns null for a clean healthy session', () => {
  const spans = [span({ toolArgs: 'a' }), span({ toolArgs: 'b', toolName: 'retrieve' })];
  assert.equal(runDetectors(spans), null);
});

test('runDetectors: loop is reported even when the absolute cap would also trip', () => {
  const spans = Array.from({ length: 5 }, () => span({ toolArgs: 'same', costUsd: 0.2 })); // both loop and cap would fire
  const result = runDetectors(spans);
  assert.equal(result.reason, 'loop_detected'); // more specific reason wins per documented priority order
});
