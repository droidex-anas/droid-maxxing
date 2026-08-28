import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionRefFor, sessionWebUrlFor } from './sessionWebUrl.js';

test('Droid public display is the Factory URL and POSIX-quoted resume command', () => {
  const binding = { providerDriverKind: 'droid' as const, providerSessionId: 'native-1' };
  assert.equal(sessionWebUrlFor(binding), 'https://app.factory.ai/sessions/native-1');
  assert.deepEqual(sessionRefFor(binding), {
    id: 'native-1',
    resumeCommand: "droid -r 'native-1'",
  });
  assert.deepEqual(sessionRefFor({ ...binding, providerSessionId: "o'reilly" }), {
    id: "o'reilly",
    resumeCommand: "droid -r 'o'\\''reilly'",
  });
});

test('non-Droid providers expose neither a web URL nor a session ref', () => {
  for (const providerDriverKind of ['cursor', 'grok'] as const) {
    const binding = { providerDriverKind, providerSessionId: 'native-1' };
    assert.equal(sessionWebUrlFor(binding), undefined);
    assert.equal(sessionRefFor(binding), undefined);
  }
});

test('Droid without a native id exposes neither a web URL nor a session ref', () => {
  const binding = { providerDriverKind: 'droid' as const };
  assert.equal(sessionWebUrlFor(binding), undefined);
  assert.equal(sessionRefFor(binding), undefined);
});
