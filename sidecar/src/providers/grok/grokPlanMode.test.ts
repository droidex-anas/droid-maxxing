import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isGrokEnterPlanModeToolCall,
  nextGrokPlanModeActive,
  shouldEmitPlanBody,
} from './grokPlanMode.js';

test('plan-mode detection uses title or rawInput.variant', () => {
  assert.equal(isGrokEnterPlanModeToolCall({ title: 'enter_plan_mode', data: {} }), true);
  assert.equal(
    isGrokEnterPlanModeToolCall({
      title: 'Tool',
      data: { rawInput: { variant: 'EnterPlanMode' } },
    }),
    true,
  );
  assert.equal(isGrokEnterPlanModeToolCall({ title: 'Terminal', data: {} }), false);
});

test('failed enter_plan_mode does not leave plan mode stuck on', () => {
  assert.equal(
    nextGrokPlanModeActive(false, {
      toolCallId: 't1',
      title: 'enter_plan_mode',
      status: 'inProgress',
      data: {},
    }),
    true,
  );
  assert.equal(
    nextGrokPlanModeActive(true, {
      toolCallId: 't1',
      title: 'enter_plan_mode',
      status: 'failed',
      data: {},
    }),
    false,
  );
});

test('plan body is deduplicated per turn', () => {
  assert.equal(
    shouldEmitPlanBody({
      lastBody: '# Plan',
      lastTurnId: 'turn-1',
      turnId: 'turn-1',
      body: '# Plan',
    }),
    false,
  );
  assert.equal(
    shouldEmitPlanBody({
      lastBody: '# Plan',
      lastTurnId: 'turn-1',
      turnId: 'turn-2',
      body: '# Plan',
    }),
    true,
  );
});
