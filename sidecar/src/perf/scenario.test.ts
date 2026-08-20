import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReplayPlan, mulberry32, resolveScenario } from './scenario.js';

test('the same seed produces an identical plan', () => {
  const spec = resolveScenario('streaming');
  const first = buildReplayPlan(spec);
  const second = buildReplayPlan(spec);

  assert.deepEqual(first, second);
});

test('different seeds change the workload', () => {
  const first = buildReplayPlan(resolveScenario('streaming', { seed: 1 }));
  const second = buildReplayPlan(resolveScenario('streaming', { seed: 2 }));

  assert.notDeepEqual(first, second);
});

test('plan shape matches the scenario parameters', () => {
  const spec = resolveScenario('smoke');
  const plan = buildReplayPlan(spec);

  assert.equal(plan.turns.length, spec.sessions * spec.turnsPerSession);
  const deltas = plan.turns
    .flatMap((turn) => turn.steps)
    .filter((step) => String(step.event.type).endsWith('_text_delta'));
  const markers = plan.turns.flatMap((turn) => turn.steps).filter((step) => step.marker !== null);
  assert.equal(deltas.length, spec.sessions * spec.turnsPerSession * spec.deltasPerTurn);
  assert.ok(markers.length > 0);
  assert.ok(
    markers.every((step) => step.marker?.startsWith('call:') || step.marker?.startsWith('result:')),
  );
});

test('steps inside a turn are scheduled in non-decreasing time order', () => {
  const plan = buildReplayPlan(resolveScenario('multi-agent'));
  for (const turn of plan.turns) {
    let previous = -1;
    for (const step of turn.steps) {
      assert.ok(step.atMs >= previous, `step at ${String(step.atMs)} after ${String(previous)}`);
      previous = step.atMs;
    }
  }
});

test('unknown scenario names fail fast', () => {
  assert.throws(() => resolveScenario('does-not-exist'), /Unknown scenario/);
});

test('mulberry32 repeats deterministically for a seed', () => {
  const first = Array.from({ length: 5 }, () => mulberry32(99)());
  const second = Array.from({ length: 5 }, () => mulberry32(99)());
  assert.deepEqual(first, second);
  assert.ok(first.every((value) => value >= 0 && value < 1));
});
