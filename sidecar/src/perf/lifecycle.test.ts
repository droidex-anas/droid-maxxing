import assert from 'node:assert/strict';
import test from 'node:test';

import { runSoak } from './lifecycle.js';
import { resolveScenario } from './scenario.js';

test('soak create/close returns live primary sessions to zero', async () => {
  const report = await runSoak(
    resolveScenario('soak', {
      soakCycles: 3,
    }),
  );
  assert.equal(report.scenario.kind, 'soak');
  assert.equal(report.sidecar.resources?.livePrimarySessions, 0);
  assert.equal(
    report.gates.results.find((result) => result.id === 'sidecar.livePrimarySessions')?.status,
    'pass',
  );
});
