import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readFactoryDefaults, readFactorySessionLaunchSettings } from './FactoryDefaults.js';

const originalHome = process.env.HOME;

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'droidex-factory-defaults-'));
  process.env.HOME = home;
  try {
    run(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test('readFactoryDefaults returns empty when settings.json is absent', () => {
  withHome(() => {
    assert.deepEqual(readFactoryDefaults(), {});
  });
});

test('readFactoryDefaults maps session and mission defaults from Factory settings.json', () => {
  withHome((home) => {
    mkdirSync(join(home, '.factory'), { recursive: true });
    writeFileSync(
      join(home, '.factory', 'settings.json'),
      JSON.stringify({
        sessionDefaultSettings: {
          model: 'claude-sonnet-4-5',
          reasoningEffort: 'high',
          autonomyLevel: 'low',
          interactionMode: 'spec',
          specModeModel: 'claude-opus-4-1',
          specModeReasoningEffort: 'max',
        },
        compactionModel: 'current-model',
        compactionTokenLimit: 8000,
        missionOrchestratorModel: 'claude-opus-4-1',
        missionOrchestratorReasoningEffort: 'high',
        missionModelSettings: {
          workerModel: 'claude-sonnet-4-5',
          workerReasoningEffort: 'medium',
          validationWorkerModel: 'claude-haiku-4-5',
          validationWorkerReasoningEffort: 'low',
        },
      }),
    );
    assert.deepEqual(readFactoryDefaults(), {
      modelId: 'claude-sonnet-4-5',
      reasoningEffort: 'high',
      compactionModel: 'current-model',
      compactionTokenLimit: 8000,
      compactionTokenLimitPerModel: undefined,
      autonomy: 'low',
      interactionMode: 'spec',
      specModelId: 'claude-opus-4-1',
      specReasoningEffort: 'max',
      missionOrchestratorModelId: 'claude-opus-4-1',
      missionOrchestratorReasoningEffort: 'high',
      workerModelId: 'claude-sonnet-4-5',
      workerReasoningEffort: 'medium',
      validatorModelId: 'claude-haiku-4-5',
      validatorReasoningEffort: 'low',
    });
  });
});

test('readFactorySessionLaunchSettings reads the adjacent Task settings file', () => {
  withHome((home) => {
    const nested = join(home, '.factory', 'sessions', '2026-08-29');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'provider-task.settings.json'),
      JSON.stringify({ model: 'claude-opus-4-1', reasoningEffort: 'max' }),
    );
    assert.deepEqual(readFactorySessionLaunchSettings('provider-task'), {
      modelId: 'claude-opus-4-1',
      reasoningEffort: 'max',
    });
    assert.equal(readFactorySessionLaunchSettings('missing-task'), undefined);
  });
});
