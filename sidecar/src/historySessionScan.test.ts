import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionSummary, TranscriptEvent } from './protocol.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';

const originalHome = process.env.HOME;
const originalUserDataDir = process.env.DROIDEX_USER_DATA_DIR;
const home = mkdtempSync(join(tmpdir(), 'droid-history-session-scan-home-'));
process.env.HOME = home;
// The scan's second root lives beside the profile, so a profile override in the
// developer's environment would aim this suite at their real session files.
delete process.env.DROIDEX_USER_DATA_DIR;

const { loadHistoricalSessions } = await import('./history.js');
const { parseFullSessionTranscript } = await import('./sessionTranscript.js');
const { ProviderTranscriptFile } = await import('./providers/ProviderTranscriptFile.js');
const { providerSessionsDir } = await import('./droidexPaths.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserDataDir !== undefined) process.env.DROIDEX_USER_DATA_DIR = originalUserDataDir;
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function writeSession(id: string, title: string): void {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    providerSessionJsonl({
      type: 'session_start',
      cwd: '',
      sessionTitle: title,
      settings: { interactionMode: 'auto' },
    }),
  );
}

function titles(): string[] {
  return loadHistoricalSessions()
    .map((row) => row.summary.title)
    .sort();
}

// These tests pin the uncached scan's freshness contract: it backs the
// session file cache reconcile, so a change written between two scans must
// show up in the second one.

test('a session file rewritten between scans serves its new summary', () => {
  seq += 1;
  const id = `scan-rewrite-${seq}`;
  writeSession(id, 'before the rewrite');
  assert.ok(titles().includes('before the rewrite'));

  writeSession(id, 'after the rewrite — changed on disk');
  const after = titles();
  assert.ok(after.includes('after the rewrite — changed on disk'));
  assert.ok(!after.includes('before the rewrite'));
});

test('a settings sidecar written between scans invalidates the summary', () => {
  seq += 1;
  const id = `scan-settings-${seq}`;
  writeSession(id, `settings session ${seq}`);
  const before = loadHistoricalSessions().find((row) => row.summary.appSessionId === id);
  assert.equal(before?.summary.modelId, undefined);

  writeFileSync(
    join(home, '.factory', 'sessions', `${id}.settings.json`),
    JSON.stringify({ modelId: 'scan-test-model' }),
  );
  const after = loadHistoricalSessions().find((row) => row.summary.appSessionId === id);
  assert.equal(after?.summary.modelId, 'scan-test-model');
});

test('a session file created between scans appears, and a deleted one disappears', () => {
  seq += 1;
  const id = `scan-create-${seq}`;
  writeSession(id, `created late ${seq}`);
  assert.ok(titles().includes(`created late ${seq}`));

  unlinkSync(join(home, '.factory', 'sessions', `${id}.jsonl`));
  assert.ok(!titles().includes(`created late ${seq}`));
});

test('an unreadable subdirectory is skipped without aborting the scan', () => {
  // chmod is ineffective for root (CI containers), where a 000 dir is still
  // readable; skip there so the test stays deterministic everywhere else.
  if (process.getuid?.() === 0) return;
  seq += 1;
  const good = `scan-resilient-${seq}`;
  writeSession(good, `resilient ${seq}`);
  const locked = join(home, '.factory', 'sessions', 'locked-dir');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    // A parallel run removing or locking a sessions subtree must not abort
    // the reconcile scan; the readable sibling session is still enumerated.
    const found = titles();
    assert.ok(found.includes(`resilient ${seq}`), 'the scan completes past the locked subtree');
  } finally {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
  }
});

// The one cross-provider contract in this path: what ProviderTranscriptFile
// writes for a non-Droid session is what the scan admits and the parser
// replays. Nothing types can check — a drifted head key or content block reads
// as "the session is missing, and empty when reopened".
test('a transcript DROIDEX writes for a non-Droid session is enumerated and replays', () => {
  const appSessionId = 'provider-transcript-scan';
  const summary: SessionSummary = {
    appSessionId,
    provider: 'claude',
    resumeId: 'thread-abc',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Claude session',
    goal: 'Claude session',
    cwd: '',
    modelId: 'claude-sonnet-4-5',
    autonomy: 'medium',
    phase: 'paused',
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const transcript = new ProviderTranscriptFile(summary.appSessionId, () => summary);
  transcript.appendPrompt('what is here?');
  transcript.append(transcriptEvent(appSessionId, 'text', { text: 'Looking.' }));
  transcript.append(
    transcriptEvent(appSessionId, 'tool_call', {
      toolName: 'Read',
      toolUseId: 'toolu_1',
      toolArgs: { path: '.' },
    }),
  );
  transcript.append(
    transcriptEvent(appSessionId, 'tool_result', { toolUseId: 'toolu_1', text: 'AGENTS.md' }),
  );
  transcript.flush();

  const listed = loadHistoricalSessions().find((row) => row.summary.appSessionId === appSessionId);
  assert.equal(listed?.summary.provider, 'claude');
  assert.equal(listed?.summary.resumeId, 'thread-abc');
  // Without a model on the head line the restored session cannot be resumed.
  assert.equal(listed?.summary.modelId, 'claude-sonnet-4-5');
  assert.equal(listed?.summary.title, 'Claude session');

  const events = parseFullSessionTranscript(
    appSessionId,
    appSessionId,
    join(providerSessionsDir(), `${appSessionId}.jsonl`),
    'primary',
  );
  assert.deepEqual(
    events.map((event) => [event.kind, event.author ?? event.text, event.toolUseId]),
    [
      ['text', 'user', undefined],
      ['text', 'Looking.', undefined],
      ['tool_call', undefined, 'toolu_1'],
      // The call's id survives, so the renderer pairs the result with its call.
      ['tool_result', 'AGENTS.md', 'toolu_1'],
    ],
  );
});

function transcriptEvent(
  appSessionId: string,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  seq += 1;
  return {
    id: `provider-event-${String(seq)}`,
    appSessionId,
    sourceSessionId: appSessionId,
    role: 'primary',
    ts: 1,
    kind,
    ...extra,
  };
}
