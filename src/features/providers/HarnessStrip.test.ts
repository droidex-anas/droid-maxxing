import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HarnessStrip from './HarnessStrip.js';
import type { ProviderWireSnapshot } from '../../types/bridge.js';

const snapshots: ProviderWireSnapshot[] = [
  {
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
      approvals: false,
      questions: false,
      planReview: false,
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
  },
];

test('the strip marks the selected harness and leaves others unlocked on a draft', () => {
  const html = renderToStaticMarkup(
    createElement(HarnessStrip, {
      selected: 'grok',
      locked: false,
      snapshots,
      onSelect: () => undefined,
    }),
  );
  assert.match(html, /data-testid="harness-strip"/);
  assert.match(html, /data-harness="grok"[^>]*aria-pressed="true"/);
  assert.match(html, /data-harness="droid"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(html, /Harness is locked after the first prompt/);
});

test('a live session disables every harness except the bound one', () => {
  const html = renderToStaticMarkup(
    createElement(HarnessStrip, {
      selected: 'droid',
      locked: true,
      snapshots,
      onSelect: () => undefined,
    }),
  );
  assert.match(html, /Harness is locked after the first prompt/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});
