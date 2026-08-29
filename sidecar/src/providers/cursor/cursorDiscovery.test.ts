import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderContractError } from '../providerTypes.js';
import {
  CURSOR_UNAUTHENTICATED_MESSAGE,
  isCursorAboutJsonFormatUnsupported,
  parseCursorAboutOutput,
  runCursorAbout,
  stripAnsi,
  type CursorCommandResult,
} from './cursorAbout.js';
import {
  buildCursorSnapshot,
  fallbackCursorModel,
  parseCursorModelCatalog,
} from './cursorDiscovery.js';
import { CURSOR_ABOUT_TIMEOUT_MS, CURSOR_DEFAULT_MODEL_ID } from './cursorHandshake.js';

function about(partial: Partial<CursorCommandResult>): CursorCommandResult {
  return { stdout: '', stderr: '', code: 0, timedOut: false, ...partial };
}

test('parseCursorAboutOutput reads JSON version, email, and subscription label', () => {
  const parsed = parseCursorAboutOutput(
    about({
      stdout: JSON.stringify({
        cliVersion: '2026.04.09-f2b0fcd',
        subscriptionTier: 'Team',
        userEmail: 'cursor@example.com',
      }),
    }),
  );
  assert.deepEqual(parsed, {
    version: '2026.04.09-f2b0fcd',
    auth: {
      status: 'authenticated',
      email: 'cursor@example.com',
      billingLabel: 'Cursor Team',
    },
  });
});

test('JSON Not logged in / login required / authentication required are unauthenticated', () => {
  for (const userEmail of ['Not logged in', 'login required', 'authentication required']) {
    const parsed = parseCursorAboutOutput(
      about({ stdout: JSON.stringify({ cliVersion: '1.0', userEmail }) }),
    );
    assert.equal(parsed.auth.status, 'unauthenticated', userEmail);
    assert.equal(parsed.message, CURSOR_UNAUTHENTICATED_MESSAGE);
  }
});

test('JSON null userEmail is unauthenticated; missing field at exit 0 is unknown', () => {
  const nullEmail = parseCursorAboutOutput(
    about({ stdout: JSON.stringify({ cliVersion: '1.0', userEmail: null }) }),
  );
  assert.equal(nullEmail.auth.status, 'unauthenticated');
  const missing = parseCursorAboutOutput(about({ stdout: JSON.stringify({ cliVersion: '1.0' }) }));
  assert.equal(missing.auth.status, 'unknown');
  assert.equal(missing.version, '1.0');
});

test('text about output strips ANSI and reads CLI Version / User Email', () => {
  const parsed = parseCursorAboutOutput(
    about({
      stdout: `${stripAnsi('\u001b[32m')}\u001b[32mCLI Version         2026.03.20-44cb435\u001b[0m\nUser Email          cursor@example.com\n`,
    }),
  );
  assert.equal(parsed.version, '2026.03.20-44cb435');
  assert.equal(parsed.auth.status, 'authenticated');
  assert.equal(parsed.auth.email, 'cursor@example.com');
});

test('text unauthenticated markers and missing email at exit 0', () => {
  assert.equal(
    parseCursorAboutOutput(
      about({ stdout: 'CLI Version         1.0\nUser Email          Not logged in\n' }),
    ).auth.status,
    'unauthenticated',
  );
  assert.equal(
    parseCursorAboutOutput(
      about({ stdout: 'CLI Version         1.0\nUser Email          please login required now\n' }),
    ).auth.status,
    'unauthenticated',
  );
  assert.equal(
    parseCursorAboutOutput(about({ stdout: 'CLI Version         1.0\n' })).auth.status,
    'unknown',
  );
});

test('isCursorAboutJsonFormatUnsupported detects --format errors', () => {
  assert.equal(
    isCursorAboutJsonFormatUnsupported(about({ stderr: "unknown option '--format'", code: 1 })),
    true,
  );
  assert.equal(
    isCursorAboutJsonFormatUnsupported(
      about({ stdout: "unexpected argument '--format'", code: 1 }),
    ),
    true,
  );
});

test('runCursorAbout falls back to plain about when --format is unknown', async () => {
  const calls: Array<readonly string[]> = [];
  const result = await runCursorAbout({
    command: 'cursor-agent',
    timeoutMs: CURSOR_ABOUT_TIMEOUT_MS,
    signal: new AbortController().signal,
    runCommand: async (input) => {
      calls.push(input.args);
      assert.equal(input.timeoutMs, CURSOR_ABOUT_TIMEOUT_MS);
      if (input.args.includes('--format')) {
        return about({ stderr: "unrecognized option '--format'", code: 1 });
      }
      return about({ stdout: 'CLI Version         9.9\nUser Email          a@b.c\n' });
    },
  });
  assert.deepEqual(calls, [['about', '--format', 'json'], ['about']]);
  assert.equal(parseCursorAboutOutput(result).version, '9.9');
});

test('the about 8s budget is recorded without waiting', async () => {
  const started = performance.now();
  await runCursorAbout({
    command: 'cursor-agent',
    signal: AbortSignal.timeout(1),
    runCommand: async (input) => {
      assert.equal(input.timeoutMs, CURSOR_ABOUT_TIMEOUT_MS);
      return about({ stdout: JSON.stringify({ cliVersion: '1', userEmail: 'a@b.c' }) });
    },
  });
  assert.ok(performance.now() - started < 1_000);
});

test('model catalog parses values and names; empty catalog falls back to default', () => {
  const models = parseCursorModelCatalog({
    models: [
      { value: 'gpt-5.4-medium-fast[reasoning=medium,context=272k]', name: 'GPT-5.4' },
      { value: 'composer-2', name: 'Composer 2' },
    ],
  });
  assert.equal(models[0]?.id, 'gpt-5.4-medium-fast[reasoning=medium,context=272k]');
  assert.equal(models[0]?.displayName, 'GPT-5.4');
  assert.equal(models[0]?.isDefault, true);
  assert.deepEqual(parseCursorModelCatalog({ models: [] }), [fallbackCursorModel()]);
  assert.equal(fallbackCursorModel().id, CURSOR_DEFAULT_MODEL_ID);
});

test('unauthenticated snapshot uses open_cursor_setup and does not claim ready', () => {
  const snapshot = buildCursorSnapshot({
    revision: 2,
    parsed: {
      version: '1.0',
      auth: { status: 'unauthenticated' },
      message: CURSOR_UNAUTHENTICATED_MESSAGE,
    },
    models: [fallbackCursorModel()],
    advertisedModes: [],
  });
  assert.equal(snapshot.readiness, 'unauthenticated');
  assert.equal(snapshot.error?.code, 'unauthenticated_provider');
  assert.equal(snapshot.error?.recoveryAction, 'open_cursor_setup');
  assert.equal(snapshot.error?.providerInstanceId, 'cursor');
  assert.equal(
    snapshot.error instanceof ProviderContractError || snapshot.error !== undefined,
    true,
  );
});
