import { MAX_CHAT_PULL_REQUESTS, pullRequestMatchesQuery } from './chatMetadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archivedChats,
  archiveChat,
  chatDisplayTitle,
  deleteChat,
  isChatHidden,
  isChatPinned,
  loadChatMetadata,
  linkChatsPullRequest,
  MAX_CHAT_TITLE_LENGTH,
  pinChat,
  pinnedChats,
  renameChat,
  restoreChat,
  saveChatMetadata,
  unpinChat,
  type ChatMetadataMap,
} from './chatMetadata';
import type { SessionSummary } from '../types/bridge';

// fakeStorage() installs a global localStorage stub; restore the original
// global after every test so the stub cannot leak into other suites.
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
test.afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

function fakeStorage() {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return data;
}

function makeSession(
  appSessionId: string,
  updatedAt = 1_000,
  title = appSessionId,
): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title,
    goal: '',
    cwd: '',
    autonomy: 'off',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

test('renameChat sets, changes, and clears the display title', () => {
  const renamed = renameChat({}, 's1', 'My chat');
  assert.deepEqual(renamed, { s1: { displayTitle: 'My chat' } });

  const changed = renameChat(renamed ?? {}, 's1', 'Better name');
  assert.deepEqual(changed, { s1: { displayTitle: 'Better name' } });

  // Re-renaming to the same title is a no-op; clearing when unset is too.
  assert.equal(renameChat(changed ?? {}, 's1', 'Better name'), null);
  assert.equal(renameChat({}, 's1', '   '), null);

  // A blank title clears the override (back to the generated title).
  assert.deepEqual(renameChat(changed ?? {}, 's1', '  '), {});
});

test('renameChat trims and caps the title, preserving other flags', () => {
  const pinned = pinChat({}, 's1', 100) ?? {};
  const renamed = renameChat(pinned, 's1', '  padded  ');
  assert.deepEqual(renamed, { s1: { pinnedAt: 100, displayTitle: 'padded' } });

  const long = renameChat({}, 's1', 'x'.repeat(MAX_CHAT_TITLE_LENGTH + 50));
  assert.equal(long?.s1.displayTitle?.length, MAX_CHAT_TITLE_LENGTH);
});

test('chatDisplayTitle prefers the override and falls back to the session title', () => {
  const session = makeSession('s1', 1_000, 'Generated title');
  assert.equal(chatDisplayTitle(session, undefined), 'Generated title');
  assert.equal(chatDisplayTitle(session, {}), 'Generated title');
  assert.equal(chatDisplayTitle(session, { displayTitle: 'My name' }), 'My name');
});

test('chatDisplayTitle humanizes slash-command titles without rewriting storage', () => {
  // The CLI titles skill invocations by the raw command ("/review src"); the
  // sidebar shows the command as a name. Display-only: the stored title is
  // never rewritten, so the original string is always recoverable.
  assert.equal(
    chatDisplayTitle(makeSession('s1', 1_000, '/review src/lib'), undefined),
    'Review: src/lib',
  );
  assert.equal(
    chatDisplayTitle(makeSession('s2', 1_000, '/btw side conversation (hidden)'), undefined),
    'Btw: side conversation (hidden)',
  );
  assert.equal(chatDisplayTitle(makeSession('s3', 1_000, '/ review'), undefined), 'Review');
  assert.equal(
    chatDisplayTitle(makeSession('s4', 1_000, '/review'), { displayTitle: '/review' }),
    'Review',
  );
  // Not bare commands: paths and ordinary titles pass through verbatim.
  assert.equal(
    chatDisplayTitle(makeSession('s5', 1_000, '/already/a/path'), undefined),
    '/already/a/path',
  );
  assert.equal(
    chatDisplayTitle(makeSession('s6', 1_000, 'see /review later'), undefined),
    'see /review later',
  );
});

test('pinChat stamps pinnedAt and unpinChat removes the empty entry', () => {
  const pinned = pinChat({}, 's1', 100);
  assert.deepEqual(pinned, { s1: { pinnedAt: 100 } });

  // Re-pinning and unpinning an unpinned chat are no-ops (null).
  assert.equal(pinChat(pinned ?? {}, 's1', 200), null);
  assert.equal(unpinChat({}, 's1'), null);

  // Unpinning the only flag prunes the key entirely.
  assert.deepEqual(unpinChat(pinned ?? {}, 's1'), {});
});

test('archiveChat hides the chat, unpins it, and keeps the rename', () => {
  let map = pinChat({}, 's1', 100) ?? {};
  map = renameChat(map, 's1', 'Keep this name') ?? map;
  const archived = archiveChat(map, 's1', 500);
  assert.deepEqual(archived, { s1: { displayTitle: 'Keep this name', archivedAt: 500 } });

  const meta = (archived ?? {}).s1;
  assert.equal(isChatHidden(meta), true);
  assert.equal(isChatPinned(meta), false);

  // Archiving twice is a no-op; the original timestamp stands.
  assert.equal(archiveChat(archived ?? {}, 's1', 900), null);
});

test('restoreChat returns the chat to the normal list', () => {
  const archived = archiveChat({}, 's1', 500) ?? {};
  const restored = restoreChat(archived, 's1');
  assert.deepEqual(restored, {});
  assert.equal(restoreChat(restored ?? {}, 's1'), null);
});

test('deleteChat tombstones and stays archived; further deletes no-op', () => {
  const archived = archiveChat({}, 's1', 500) ?? {};
  const deleted = deleteChat(archived, 's1', 900);
  assert.deepEqual(deleted, { s1: { archivedAt: 500, deletedAt: 900 } });
  assert.equal(isChatHidden((deleted ?? {}).s1), true);
  assert.equal(deleteChat(deleted ?? {}, 's1', 1000), null);
});

test('pinChat and deleteChat clear conflicting flags', () => {
  // A deleted chat cannot be pinned.
  const deleted = deleteChat({}, 's1', 100) ?? {};
  assert.equal(pinChat(deleted, 's1', 200), null);

  // Deleting a pinned chat drops the pin.
  const pinned = pinChat({}, 's2', 100) ?? {};
  assert.deepEqual(deleteChat(pinned, 's2', 300), { s2: { deletedAt: 300 } });
});

test('pinnedChats lists pinned chats and skips hidden ones', () => {
  const sessions = [makeSession('a'), makeSession('b'), makeSession('c'), makeSession('d')];
  const metadata: ChatMetadataMap = {
    a: { pinnedAt: 100 },
    b: { pinnedAt: 200, archivedAt: 300 },
    c: { pinnedAt: 400, deletedAt: 500 },
  };
  assert.deepEqual(
    pinnedChats(sessions, metadata).map((s) => s.appSessionId),
    ['a'],
  );
});

test('archivedChats lists archived chats newest first and skips deleted ones', () => {
  const sessions = [makeSession('a'), makeSession('b'), makeSession('c')];
  const metadata: ChatMetadataMap = {
    a: { archivedAt: 100 },
    b: { archivedAt: 300, deletedAt: 400 },
    c: { archivedAt: 200 },
  };
  const rows = archivedChats(sessions, metadata);
  assert.deepEqual(
    rows.map((row) => row.session.appSessionId),
    ['c', 'a'],
  );
  assert.equal(rows[0].archivedAt, 200);
});

test('chat metadata round-trips through localStorage', () => {
  fakeStorage();
  let map = renameChat({}, 's1', 'Renamed everywhere') ?? {};
  map = archiveChat(map, 's1', 200) ?? {};
  saveChatMetadata(map);
  assert.deepEqual(loadChatMetadata(), {
    s1: { displayTitle: 'Renamed everywhere', archivedAt: 200 },
  });
});

test('loadChatMetadata caps the payload at MAX_TRACKED_CHATS entries', () => {
  const data = fakeStorage();
  const payload: Record<string, { pinnedAt: number }> = {};
  for (let i = 0; i < 1001; i += 1) payload[`s${String(i)}`] = { pinnedAt: i };
  data.set('droid-chat-metadata', JSON.stringify(payload));
  const loaded = loadChatMetadata();
  assert.equal(Object.keys(loaded).length, 1000);
  // Storage order is recency (writes reinsert the touched id last), so the
  // load cap drops the oldest entries — the same rule the write cap enforces.
  assert.equal(loaded.s0, undefined);
  assert.equal(loaded.s1.pinnedAt, 1);
  assert.equal(loaded.s1000.pinnedAt, 1000);
});

test('runtime updates cap the map at MAX_TRACKED_CHATS, dropping the oldest', () => {
  // The load-time cap alone left a gap: metadata created after startup grew
  // the map (and the stored payload) past the bound until the next restart.
  let map: ChatMetadataMap = {};
  for (let i = 0; i < 1000; i += 1) map = pinChat(map, `s${String(i)}`, i) ?? map;
  assert.equal(Object.keys(map).length, 1000);

  const next = pinChat(map, 's1000', 1000) ?? {};
  assert.equal(Object.keys(next).length, 1000);
  // The touched id is reinserted as most recent, so the oldest entry drops.
  assert.equal(next.s0, undefined);
  assert.equal(next.s1?.pinnedAt, 1);
  assert.equal(next.s1000?.pinnedAt, 1000);

  // Updating an existing id reorders instead of growing, so it survives too.
  const renamed = renameChat(next, 's1', 'still here') ?? {};
  assert.equal(Object.keys(renamed).length, 1000);
  assert.equal(renamed.s1?.displayTitle, 'still here');
});

test('loadChatMetadata keeps tombstones over preferences in oversized payloads', () => {
  // Same eviction rule as the write path: a restart must not resurrect hidden
  // chats from an oversized-at-rest payload either.
  const data = fakeStorage();
  const payload: Record<string, Record<string, number>> = {
    // Inserted first, so these are the OLDEST entries — and tombstones.
    'old-archive': { archivedAt: 1 },
    'old-delete': { deletedAt: 2 },
  };
  for (let i = 0; i < 1000; i += 1) payload[`s${String(i)}`] = { pinnedAt: i };
  data.set('droid-chat-metadata', JSON.stringify(payload));

  const loaded = loadChatMetadata();
  assert.equal(Object.keys(loaded).length, 1000);
  // The overflow (2) comes out of the oldest preference entries instead.
  assert.equal(loaded.s0, undefined);
  assert.equal(loaded.s1, undefined);
  assert.equal(loaded['old-archive']?.archivedAt, 1);
  assert.equal(loaded['old-delete']?.deletedAt, 2);
});

test('the runtime cap evicts tombstones last so hidden chats stay hidden', () => {
  // Forgetting a pin or rename is harmless; forgetting an archived/deleted
  // tombstone would resurface a chat the user explicitly hid.
  let map: ChatMetadataMap = {};
  for (let i = 0; i < 1000; i += 1) map = pinChat(map, `s${String(i)}`, i) ?? map;

  // Adding tombstones to a full map overflows it: the oldest pins drop first.
  map = archiveChat(map, 'hidden-1', 2000) ?? {};
  map = deleteChat(map, 'hidden-2', 2001) ?? {};
  assert.equal(Object.keys(map).length, 1000);
  assert.equal(map.s0, undefined);
  assert.equal(map.s1, undefined);
  assert.equal(map['hidden-1']?.archivedAt, 2000);
  assert.equal(map['hidden-2']?.deletedAt, 2001);

  // One more preference entry still evicts a pin, never the tombstones.
  map = pinChat(map, 's1001', 2002) ?? {};
  assert.equal(Object.keys(map).length, 1000);
  assert.equal(map.s2, undefined);
  assert.equal(map['hidden-1']?.archivedAt, 2000);
  assert.equal(map['hidden-2']?.deletedAt, 2001);
});

test('loadChatMetadata sanitizes corrupt payloads', () => {
  const data = fakeStorage();
  data.set(
    'droid-chat-metadata',
    JSON.stringify({
      ok: { pinnedAt: 1, displayTitle: 'Nice chat' },
      blankTitle: { displayTitle: '   ' },
      wrongTitleType: { displayTitle: 42 },
      empty: {},
      junk: 'nope',
      badStamps: { pinnedAt: 'soon', archivedAt: null },
      partial: { deletedAt: 9, pinnedAt: null },
    }),
  );
  assert.deepEqual(loadChatMetadata(), {
    ok: { pinnedAt: 1, displayTitle: 'Nice chat' },
    partial: { deletedAt: 9 },
  });

  data.set('droid-chat-metadata', 'not json{');
  assert.deepEqual(loadChatMetadata(), {});
  data.set('droid-chat-metadata', '[1,2]');
  assert.deepEqual(loadChatMetadata(), {});
});

test('automatic PR discovery preserves names and pins and does not churn a full cache', () => {
  const pr = {
    number: 42,
    url: 'https://github.com/team/repo/pull/42',
    title: 'Sidebar',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'sidebar',
  };
  const original: ChatMetadataMap = { important: { displayTitle: 'Keep this name', pinnedAt: 1 } };
  const ids = Array.from({ length: 1100 }, (_, index) => `chat-${String(index)}`);
  const linked = linkChatsPullRequest(original, ids, pr);
  assert.ok(linked);
  assert.equal(Object.keys(linked).length, 1000);
  assert.deepEqual(linked.important, original.important);
  assert.equal(linkChatsPullRequest(linked, ids, pr), null);
  const renamed = renameChat(linked, 'another', 'Explicit name');
  assert.ok(renamed);
  assert.deepEqual(renamed.important, original.important);
  assert.equal(renamed.another.displayTitle, 'Explicit name');
  assert.equal(Object.keys(renamed).length, 1000);
});

test('PR history and titles stay bounded at runtime and on reload', () => {
  fakeStorage();
  let map: ChatMetadataMap = {};
  for (let number = 1; number <= 20; number++) {
    map =
      linkChatsPullRequest(map, ['chat'], {
        number,
        url: `https://github.com/team/repo/pull/${number}`,
        title: 'x'.repeat(500),
        state: 'OPEN',
        isDraft: false,
        headRefName: 'branch',
      }) ?? map;
  }
  assert.equal(map.chat.pullRequests?.length, MAX_CHAT_PULL_REQUESTS);
  assert.equal(map.chat.pullRequests?.[0].number, 20);
  assert.equal(map.chat.pullRequests?.[0].title.length, 200);
  saveChatMetadata(map);
  assert.deepEqual(loadChatMetadata(), map);
  const matching = map.chat.pullRequests?.filter((pr) => pullRequestMatchesQuery(pr, '#19'));
  assert.deepEqual(
    matching?.map((pr) => pr.number),
    [19],
  );
});

test('opening a chat can replace passive PR metadata at capacity without evicting user organization', () => {
  const pr = {
    number: 1,
    url: 'https://github.com/team/repo/pull/1',
    title: 'PR',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'branch',
  };
  const full: ChatMetadataMap = { pinned: { pinnedAt: 1 }, hidden: { deletedAt: 2 } };
  for (let i = 0; i < 998; i++) full[`cached-${i}`] = { pullRequests: [pr] };
  assert.equal(linkChatsPullRequest(full, ['active'], pr), null);
  const next = linkChatsPullRequest(full, ['active'], pr, 'active');
  assert.ok(next);
  assert.equal(Object.keys(next).length, 1000);
  assert.deepEqual(next.active.pullRequests, [pr]);
  assert.deepEqual(next.pinned, full.pinned);
  assert.deepEqual(next.hidden, full.hidden);
  assert.equal(next['cached-0'], undefined);
});

test('loading oversized PR history deduplicates and caps provider payloads', () => {
  const storage = fakeStorage();
  const pullRequests = Array.from({ length: 30 }, (_, i) => ({
    number: i + 1,
    url: `https://github.com/team/repo/pull/${i + 1}`,
    title: 'x'.repeat(500),
    state: 'OPEN',
    isDraft: false,
    headRefName: 'branch',
  }));
  storage.set(
    'droid-chat-metadata',
    JSON.stringify({ chat: { pullRequests: [pullRequests[0], ...pullRequests] } }),
  );
  const links = loadChatMetadata().chat.pullRequests;
  assert.equal(links?.length, MAX_CHAT_PULL_REQUESTS);
  assert.equal(links?.[0].title.length, 200);
  assert.equal(new Set(links?.map((pr) => pr.url)).size, MAX_CHAT_PULL_REQUESTS);
});
