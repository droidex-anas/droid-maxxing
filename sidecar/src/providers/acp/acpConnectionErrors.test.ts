import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderError } from '../providerErrors.js';
import {
  AcpConnectionError,
  createAcpConnectionError,
  mapSpawnFailure,
} from './acpConnectionErrors.js';
import { AcpProcessSpawnFailure } from './acpProcess.js';

test('createAcpConnectionError produces a closed ProviderError without native fields', () => {
  const error = createAcpConnectionError(
    'cursor',
    'missing_executable',
    'ACP peer executable was not found',
  );
  assert.equal(error.name, 'AcpConnectionError');
  assert.equal(error.recoveryAction, 'open_cursor_setup');
  assert.deepEqual(parseProviderError(error.toProviderError()), {
    code: 'missing_executable',
    providerInstanceId: 'cursor',
    message: 'ACP peer executable was not found',
    recoveryAction: 'open_cursor_setup',
  });
});

test('mapSpawnFailure maps a missing executable without leaking ENOENT', () => {
  const error = mapSpawnFailure(
    'grok',
    new AcpProcessSpawnFailure('missing_executable', 'ENOENT: no such file'),
  );
  assert.equal(error.code, 'missing_executable');
  assert.equal(error.recoveryAction, 'open_grok_setup');
  assert.equal(error.message.includes('ENOENT'), false);
});

test('AcpConnectionError is an Error that still round-trips as ProviderError', () => {
  const error = new AcpConnectionError({
    code: 'provider_process_exited',
    providerInstanceId: 'cursor',
    message: 'ACP peer process exited',
    recoveryAction: 'retry_session',
  });
  assert.equal(error instanceof Error, true);
  assert.equal(parseProviderError(error.toProviderError()).code, 'provider_process_exited');
});
