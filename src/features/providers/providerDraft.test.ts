import assert from 'node:assert/strict';
import test from 'node:test';

import { withLocalStorageMap } from '../../test/localStorage.js';
import {
  loadProviderDraft,
  parseProviderDraft,
  persistDraftHarness,
  persistHarnessSelection,
  PROVIDER_PREFERENCES_KEY,
} from './providerDraft.js';

test('malformed provider preferences fall back to a Droid draft', () => {
  withLocalStorageMap({ [PROVIDER_PREFERENCES_KEY]: '{not-json' }, () => {
    assert.deepEqual(loadProviderDraft(), {
      draftProviderInstanceId: 'droid',
      selections: {},
    });
  });
  assert.equal(
    parseProviderDraft({ draftProviderInstanceId: 'factory', selections: {} }),
    undefined,
  );
});

test('draft harness and per-harness model selections persist independently', () => {
  withLocalStorageMap({}, () => {
    persistDraftHarness('grok');
    persistHarnessSelection('grok', { modelId: 'grok-build' });
    persistHarnessSelection('droid', { modelId: 'droid-core', reasoningEffort: 'high' });
    const loaded = loadProviderDraft();
    assert.equal(loaded.draftProviderInstanceId, 'grok');
    assert.deepEqual(loaded.selections.grok, { modelId: 'grok-build' });
    assert.deepEqual(loaded.selections.droid, { modelId: 'droid-core', reasoningEffort: 'high' });
  });
});
