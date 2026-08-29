import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

import {
  ACP_FAKE_BEHAVIOR_ENV,
  ACP_FAKE_PEER_ENV,
  fakeAcpPeerPath,
  fakeAcpPeerSpawn,
} from './fakeAcpPeer.js';

test('fakeAcpPeerSpawn points at the in-repo peer script and sets the run marker', () => {
  const spawn = fakeAcpPeerSpawn('hang-prompt');
  assert.equal(spawn.command, process.execPath);
  assert.equal(spawn.args.includes('--import'), true);
  assert.equal(spawn.args.includes('tsx'), true);
  assert.equal(spawn.args.at(-1), fakeAcpPeerPath());
  assert.equal(existsSync(fakeAcpPeerPath()), true);
  assert.equal(spawn.env[ACP_FAKE_PEER_ENV], '1');
  assert.equal(spawn.env[ACP_FAKE_BEHAVIOR_ENV], 'hang-prompt');
});
