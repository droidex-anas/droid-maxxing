import assert from 'node:assert/strict';
import test from 'node:test';

import { initialState, reducer, type AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';
import { droidSessionConfiguration } from '../lib/sessionConfiguration';

function makeSession(appSessionId: string, updatedAt = 1): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

function stateWithSessions(...ids: string[]): AppState {
  return {
    ...initialState,
    sessions: Object.fromEntries(ids.map((id) => [id, makeSession(id)])),
    sessionOrder: ids,
    listConfirmedSessionIds: ids,
  };
}

test('every chat-metadata action returns the same state object on a no-op', () => {
  // Locks the reducer forwarding contract: a null transform must preserve the
  // exact state reference so no re-render or storage write happens.
  const base = stateWithSessions('s1');
  // True no-ops on a chat with no metadata: unpin, restore, blank rename.
  assert.equal(reducer(base, { type: 'UNPIN_CHAT', appSessionId: 's1' }), base);
  assert.equal(reducer(base, { type: 'RESTORE_CHAT', appSessionId: 's1' }), base);
  assert.equal(reducer(base, { type: 'RENAME_CHAT', appSessionId: 's1', title: '' }), base);
  // Re-applying a settled state is a no-op too: re-pin, re-archive, re-delete.
  const pinned = reducer(base, { type: 'PIN_CHAT', appSessionId: 's1' });
  assert.equal(reducer(pinned, { type: 'PIN_CHAT', appSessionId: 's1' }), pinned);
  const archived = reducer(base, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  assert.equal(reducer(archived, { type: 'ARCHIVE_CHAT', appSessionId: 's1' }), archived);
  const deleted = reducer(base, { type: 'DELETE_CHAT', appSessionId: 's1' });
  assert.equal(reducer(deleted, { type: 'DELETE_CHAT', appSessionId: 's1' }), deleted);
});

test('RENAME_CHAT stores an app-level display title and a blank title clears it', () => {
  const base = stateWithSessions('s1');
  const renamed = reducer(base, { type: 'RENAME_CHAT', appSessionId: 's1', title: 'My chat' });
  assert.equal(renamed.chatMetadata.s1.displayTitle, 'My chat');
  // The harness session summary is untouched: the override lives only in metadata.
  assert.equal(renamed.sessions.s1.title, 's1');

  // Re-renaming to the same title keeps the current state.
  assert.equal(
    reducer(renamed, { type: 'RENAME_CHAT', appSessionId: 's1', title: 'My chat' }),
    renamed,
  );

  const cleared = reducer(renamed, { type: 'RENAME_CHAT', appSessionId: 's1', title: '   ' });
  assert.deepEqual(cleared.chatMetadata, {});
});

test('RENAME_CHAT survives pin/archive transforms on the same chat', () => {
  const base = stateWithSessions('s1');
  let state = reducer(base, { type: 'RENAME_CHAT', appSessionId: 's1', title: 'Stable name' });
  state = reducer(state, { type: 'PIN_CHAT', appSessionId: 's1' });
  state = reducer(state, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  assert.equal(state.chatMetadata.s1.displayTitle, 'Stable name');
  assert.equal(state.chatMetadata.s1.pinnedAt, undefined);
  assert.equal(typeof state.chatMetadata.s1.archivedAt, 'number');
});

test('PIN_CHAT stamps pinnedAt and a second pin is a state-preserving no-op', () => {
  const base = stateWithSessions('s1');
  const pinned = reducer(base, { type: 'PIN_CHAT', appSessionId: 's1' });
  assert.equal(typeof pinned.chatMetadata.s1.pinnedAt, 'number');

  const again = reducer(pinned, { type: 'PIN_CHAT', appSessionId: 's1' });
  assert.equal(again, pinned);
});

test('UNPIN_CHAT clears the pin and prunes the empty entry', () => {
  const base = stateWithSessions('s1');
  const pinned = reducer(base, { type: 'PIN_CHAT', appSessionId: 's1' });
  const unpinned = reducer(pinned, { type: 'UNPIN_CHAT', appSessionId: 's1' });
  assert.deepEqual(unpinned.chatMetadata, {});
});

test('ARCHIVE_CHAT hides the chat and unpins it', () => {
  const base = stateWithSessions('s1');
  const pinned = reducer(base, { type: 'PIN_CHAT', appSessionId: 's1' });
  const archived = reducer(pinned, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  assert.equal(typeof archived.chatMetadata.s1.archivedAt, 'number');
  assert.equal(archived.chatMetadata.s1.pinnedAt, undefined);
  // The session itself is untouched: archive is metadata only.
  assert.equal(archived.sessions.s1, pinned.sessions.s1);
});

test('RESTORE_CHAT removes the archive flag', () => {
  const base = stateWithSessions('s1');
  const archived = reducer(base, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  const restored = reducer(archived, { type: 'RESTORE_CHAT', appSessionId: 's1' });
  assert.deepEqual(restored.chatMetadata, {});
});

test('DELETE_CHAT tombstones the chat and clears any pin', () => {
  const base = stateWithSessions('s1');
  const pinned = reducer(base, { type: 'PIN_CHAT', appSessionId: 's1' });
  const archived = reducer(pinned, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  const deleted = reducer(archived, { type: 'DELETE_CHAT', appSessionId: 's1' });
  assert.equal(typeof deleted.chatMetadata.s1.deletedAt, 'number');
  assert.equal(deleted.chatMetadata.s1.pinnedAt, undefined);
  assert.equal(typeof deleted.chatMetadata.s1.archivedAt, 'number');
});

test('PIN_CHAT on an archived chat is a no-op', () => {
  const base = stateWithSessions('s1');
  const archived = reducer(base, { type: 'ARCHIVE_CHAT', appSessionId: 's1' });
  assert.equal(reducer(archived, { type: 'PIN_CHAT', appSessionId: 's1' }), archived);
});

test('SESSION_LIST prunes metadata only for confirmed sessions it no longer reports', () => {
  // 'gone' was confirmed by a previous listing and has metadata; 'local' was
  // added this run (never list-confirmed) and must survive.
  const base: AppState = {
    ...stateWithSessions('gone', 'kept'),
    sessions: {
      gone: makeSession('gone'),
      kept: makeSession('kept'),
      local: makeSession('local'),
    },
    sessionOrder: ['gone', 'kept', 'local'],
    chatMetadata: {
      gone: { archivedAt: 100 },
      kept: { pinnedAt: 100 },
      local: { pinnedAt: 200 },
    },
  };
  const next = reducer(base, { type: 'SESSION_LIST', sessions: [makeSession('kept', 2)] });
  assert.deepEqual(next.chatMetadata, {
    kept: { pinnedAt: 100 },
    local: { pinnedAt: 200 },
  });
});
