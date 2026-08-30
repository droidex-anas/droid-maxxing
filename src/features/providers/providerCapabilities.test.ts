import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderWireSnapshot } from '../../types/bridge.js';
import { composerCapabilities, composerSlashVisible, specControl } from './providerCapabilities.js';

function grokSnapshot(): ProviderWireSnapshot {
  return {
    definition: { providerDriverKind: 'grok', providerInstanceId: 'grok', displayName: 'Grok' },
    revision: 1,
    readiness: 'ready',
    models: [],
    capabilities: {
      modes: ['auto'],
      autonomyLevels: ['off', 'low', 'medium', 'high'],
      modelChange: 'before_turn',
      resume: true,
      steer: false,
      interrupt: true,
      approvals: true,
      questions: true,
      planReview: true,
      context: false,
      compaction: false,
      skills: false,
      slashCommands: false,
      mcpUse: false,
      mcpManagement: false,
      rewind: false,
      fork: false,
      observationalTasks: false,
      addressableChildren: false,
      missionControl: false,
      browser: false,
      usageReporting: false,
      reasoningStream: false,
    },
  };
}

test('missing snapshots keep Droid composer capabilities so existing UX does not vanish', () => {
  const capabilities = composerCapabilities([], 'droid');
  assert.equal(specControl(capabilities).visibility, 'show');
  assert.equal(composerSlashVisible('/mission', capabilities), true);
  assert.equal(composerSlashVisible('/compact', capabilities), true);
});

test('Grok hides spec, mission, and compact', () => {
  const capabilities = composerCapabilities([grokSnapshot()], 'grok');
  assert.equal(specControl(capabilities).visibility, 'hide');
  assert.equal(composerSlashVisible('/mission', capabilities), false);
  assert.equal(composerSlashVisible('/compact', capabilities), false);
  assert.equal(composerSlashVisible('/spec', capabilities), false);
  assert.equal(composerSlashVisible('/model', capabilities), true);
});
