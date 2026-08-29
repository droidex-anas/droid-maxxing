import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CanonicalEvent, CanonicalEventPayload } from '../sessionEvents.js';
import { parseCanonicalEvent } from '../sessionEvents.js';
import { DroidexDatabase } from './DroidexDatabase.js';
import { SessionStore } from './SessionStore.js';
import { droidSessionConfiguration } from '../providers/providerIdentity.js';
import {
  CanonicalEventCollisionError,
  DEFAULT_PAGE_LIMIT,
  InvalidTranscriptCursorError,
  MAX_PAGE_LIMIT,
  MAX_SEARCH_SESSION_RESULTS,
  MAX_SEARCH_SESSIONS,
  MAX_SEARCH_SNIPPETS_PER_SESSION,
  MAX_SEARCH_TEXT_BYTES,
  TranscriptStore,
} from './TranscriptStore.js';

const SESSION_INSERT = `
  INSERT INTO sessions (
    app_session_id, client_ref, provider_driver_kind, provider_instance_id,
    provider_session_id, previous_provider_session_ids_json, resume_state_json,
    runtime_generation, summary_json, lifecycle_status, failure_code, failure_message,
    failure_recovery_action, hidden, created_at, updated_at
  ) VALUES (?, ?, 'droid', 'droid', NULL, '[]', NULL, 0, '{}', 'running', NULL, NULL, NULL, 0, 1, ?)
`;

function withStore(
  run: (store: TranscriptStore, db: DroidexDatabase) => void | Promise<void>,
  options: ConstructorParameters<typeof TranscriptStore>[1] = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-transcript-store-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  const store = new TranscriptStore(db, options);
  return Promise.resolve()
    .then(() => run(store, db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function seedSession(db: DroidexDatabase, appSessionId: string, updatedAt = 1): void {
  db.prepare(SESSION_INSERT).run(appSessionId, `ref-${appSessionId}`, updatedAt);
}

function seedChild(db: DroidexDatabase, parent: string, child: string): void {
  db.prepare(
    `
      INSERT INTO child_sessions (
        parent_app_session_id, child_session_id, provider_driver_kind, provider_instance_id,
        provider_session_id, previous_provider_session_ids_json, resume_state_json,
        runtime_generation, summary_json, lifecycle_status, created_at, updated_at
      ) VALUES (?, ?, 'droid', 'droid', NULL, '[]', NULL, 0, '{}', 'running', 1, 1)
    `,
  ).run(parent, child);
}

function event(
  eventId: string,
  payload: CanonicalEventPayload,
  overrides: Partial<CanonicalEvent> = {},
): CanonicalEvent {
  return parseCanonicalEvent({
    eventId,
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 1,
    createdAt: 1_000,
    payload,
    ...overrides,
  });
}

function textEvent(
  eventId: string,
  text: string,
  overrides: Partial<CanonicalEvent> = {},
): CanonicalEvent {
  return event(
    eventId,
    { type: 'transcript', transcript: { role: 'primary', kind: 'text', text } },
    overrides,
  );
}

test('append assigns event_order and round-trips a tool payload', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    const toolArgs = { path: '/tmp/file', nested: { a: 1 } };
    const persisted = store.append(
      event('evt-tool', {
        type: 'transcript',
        transcript: {
          role: 'primary',
          kind: 'tool_call',
          toolName: 'Edit',
          toolUseId: 'tool-1',
          toolArgs,
        },
      }),
    );
    assert.equal(persisted.seq, 1);
    assert.equal(persisted.payload.type, 'transcript');
    if (persisted.payload.type !== 'transcript') return;
    assert.deepEqual(persisted.payload.transcript.toolArgs, toolArgs);
    const page = store.page({ kind: 'session', appSessionId: 'app-1' });
    assert.equal(page.events[0]?.seq, 1);
    assert.deepEqual(page.events[0]?.payload, persisted.payload);
  });
});

test('interleaved sessions and children page independently', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    seedSession(db, 'app-2');
    seedChild(db, 'app-1', 'child-1');
    store.append(textEvent('a1', 'one', { createdAt: 5 }));
    store.append(
      textEvent('c1', 'child', {
        createdAt: 5,
        target: { kind: 'child', parentAppSessionId: 'app-1', childSessionId: 'child-1' },
      }),
    );
    store.append(
      textEvent('b1', 'two', { createdAt: 5, target: { kind: 'session', appSessionId: 'app-2' } }),
    );
    store.append(textEvent('a2', 'three', { createdAt: 5 }));
    assert.deepEqual(
      store.page({ kind: 'session', appSessionId: 'app-1' }).events.map((row) => row.eventId),
      ['a1', 'a2'],
    );
    assert.deepEqual(
      store.page({ kind: 'session', appSessionId: 'app-2' }).events.map((row) => row.eventId),
      ['b1'],
    );
    assert.deepEqual(
      store
        .page({ kind: 'child', parentAppSessionId: 'app-1', childSessionId: 'child-1' })
        .events.map((row) => row.eventId),
      ['c1'],
    );
  });
});

test('equal timestamps stay chronological by event_order', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    store.append(textEvent('first', 'a', { createdAt: 50 }));
    store.append(textEvent('second', 'b', { createdAt: 50 }));
    store.append(textEvent('third', 'c', { createdAt: 50 }));
    const ids = store
      .page({ kind: 'session', appSessionId: 'app-1' })
      .events.map((row) => [row.eventId, row.seq, row.createdAt]);
    assert.deepEqual(ids, [
      ['first', 1, 50],
      ['second', 2, 50],
      ['third', 3, 50],
    ]);
  });
});

test('cursor is the oldest returned event_order and the next page is strictly older', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    for (let index = 0; index < 5; index += 1) {
      store.append(textEvent(`e${String(index)}`, String(index), { createdAt: 1 }));
    }
    const newest = store.page({ kind: 'session', appSessionId: 'app-1', limit: 2 });
    assert.deepEqual(
      newest.events.map((row) => row.eventId),
      ['e3', 'e4'],
    );
    assert.equal(newest.olderCursor, String(newest.events[0]?.seq));
    const middle = store.page({
      kind: 'session',
      appSessionId: 'app-1',
      before: newest.olderCursor,
      limit: 2,
    });
    assert.deepEqual(
      middle.events.map((row) => row.eventId),
      ['e1', 'e2'],
    );
    assert.ok(middle.events[0] && newest.events[0]);
    assert.equal(middle.events[0].seq < newest.events[0].seq, true);
    const oldest = store.page({
      kind: 'session',
      appSessionId: 'app-1',
      before: middle.olderCursor,
      limit: 2,
    });
    assert.deepEqual(
      oldest.events.map((row) => row.eventId),
      ['e0'],
    );
    assert.equal(oldest.olderCursor, undefined);
  });
});

test('exact duplicate replay returns the original row and allocates no order', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    const original = store.append(textEvent('dup', 'hello', { createdAt: 9 }));
    const replayed = store.append(textEvent('dup', 'hello', { createdAt: 9 }));
    assert.deepEqual(replayed, original);
    assert.equal(store.page({ kind: 'session', appSessionId: 'app-1' }).events.length, 1);
    store.append(textEvent('other', 'next'));
    assert.equal(store.page({ kind: 'session', appSessionId: 'app-1' }).events.at(-1)?.seq, 2);
  });
});

test('conflicting duplicate eventId rolls back and leaves the original row unchanged', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    const original = store.append(textEvent('dup', 'hello', { createdAt: 9 }));
    assert.throws(
      () => store.append(textEvent('dup', 'different', { createdAt: 9 })),
      CanonicalEventCollisionError,
    );
    assert.throws(
      () => store.append(textEvent('dup', 'hello', { createdAt: 10 })),
      CanonicalEventCollisionError,
    );
    const page = store.page({ kind: 'session', appSessionId: 'app-1' });
    assert.deepEqual(page.events, [original]);
  });
});

test('appendMany collision rolls back earlier inserts in the same batch', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    store.append(textEvent('existing', 'keep'));
    assert.throws(
      () => store.appendMany([textEvent('new-1', 'one'), textEvent('existing', 'changed')]),
      CanonicalEventCollisionError,
    );
    assert.deepEqual(
      store.page({ kind: 'session', appSessionId: 'app-1' }).events.map((row) => row.eventId),
      ['existing'],
    );
  });
});

test('malformed cursors fail explicitly', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    store.append(textEvent('e1', 'hello'));
    for (const cursor of ['', 'abc', '1.5', '-1', '1e2', 'v2:0:1:0', ' 1']) {
      assert.throws(
        () => store.page({ kind: 'session', appSessionId: 'app-1', before: cursor }),
        InvalidTranscriptCursorError,
        cursor,
      );
    }
    assert.deepEqual(
      store.page({ kind: 'session', appSessionId: 'app-1' }).events.map((row) => row.eventId),
      ['e1'],
    );
  });
});

test('malformed payload_json fails on read instead of projecting', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    db.prepare(
      `
        INSERT INTO transcript_events (
          event_id, parent_app_session_id, target_kind, child_session_id, turn_id,
          runtime_generation, provider_driver_kind, provider_instance_id, provider_session_id,
          provider_turn_id, provider_item_id, payload_json, search_text, created_at
        ) VALUES ('bad', 'app-1', 'session', NULL, NULL, 0, 'droid', 'droid', NULL, NULL, NULL, '{"type":"nope"}', '', 1)
      `,
    ).run();
    assert.throws(() => store.page({ kind: 'session', appSessionId: 'app-1' }));
  });
});

test('default page limit is 400 and explicit limits clamp to 1..1600', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    const count = MAX_PAGE_LIMIT + 1;
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        store.append(textEvent(`e${String(index)}`, 'x', { createdAt: 1 }));
      }
    });
    assert.equal(
      store.page({ kind: 'session', appSessionId: 'app-1' }).events.length,
      DEFAULT_PAGE_LIMIT,
    );
    assert.equal(store.page({ kind: 'session', appSessionId: 'app-1', limit: 0 }).events.length, 1);
    assert.equal(
      store.page({ kind: 'session', appSessionId: 'app-1', limit: 100_000 }).events.length,
      MAX_PAGE_LIMIT,
    );
  });
});

test('beginTurn requires unique ids and settleTurn enforces generation and legal transitions', async () => {
  await withStore((store, db) => {
    seedSession(db, 'app-1');
    seedChild(db, 'app-1', 'child-1');
    store.beginTurn({
      turnId: 'turn-1',
      target: { kind: 'session', appSessionId: 'app-1' },
      runtimeGeneration: 2,
      startedAt: '1000',
    });
    assert.throws(() =>
      store.beginTurn({
        turnId: 'turn-1',
        target: { kind: 'session', appSessionId: 'app-1' },
        runtimeGeneration: 2,
        startedAt: '1000',
      }),
    );
    store.beginTurn({
      turnId: 'turn-child',
      target: { kind: 'child', parentAppSessionId: 'app-1', childSessionId: 'child-1' },
      runtimeGeneration: 2,
      startedAt: '2000',
    });
    assert.throws(() =>
      store.settleTurn('turn-1', {
        runtimeGeneration: 99,
        status: 'completed',
        settledAt: '3000',
      }),
    );
    store.settleTurn('turn-1', {
      runtimeGeneration: 2,
      status: 'completed',
      settledAt: '3000',
      providerTurnId: 'native-turn',
    });
    assert.throws(() =>
      store.settleTurn('turn-1', {
        runtimeGeneration: 2,
        status: 'cancelled',
        settledAt: '4000',
      }),
    );
    assert.throws(() =>
      store.settleTurn('missing', {
        runtimeGeneration: 2,
        status: 'failed',
        settledAt: '4000',
      }),
    );
    store.settleTurn('turn-child', {
      runtimeGeneration: 2,
      status: 'interrupted',
      settledAt: '2026-08-12T00:00:00.000Z',
    });
    const turn = db
      .prepare('SELECT lifecycle_status, settled_at, provider_turn_id FROM turns WHERE turn_id = ?')
      .get('turn-1') as { lifecycle_status: string; settled_at: number; provider_turn_id: string };
    assert.equal(turn.lifecycle_status, 'completed');
    assert.equal(turn.settled_at, 3000);
    assert.equal(turn.provider_turn_id, 'native-turn');
  });
});

test('search honors session, result, snippet, and byte budgets', async () => {
  const yields: number[] = [];
  await withStore(
    async (store, db) => {
      assert.equal(MAX_SEARCH_SESSIONS, 150);
      assert.equal(MAX_SEARCH_TEXT_BYTES, 40_000_000);
      assert.equal(MAX_SEARCH_SESSION_RESULTS, 25);
      assert.equal(MAX_SEARCH_SNIPPETS_PER_SESSION, 3);

      for (let index = 0; index < 30; index += 1) {
        const id = `sess-${String(index).padStart(2, '0')}`;
        seedSession(db, id, index);
        store.append(
          textEvent(`${id}-hit`, 'needle in hay', {
            target: { kind: 'session', appSessionId: id },
            createdAt: 1_000 + index,
          }),
        );
      }
      const capped = await store.search('needle');
      assert.equal(capped.length, 25);
      assert.equal(capped[0]?.appSessionId, 'sess-29');
      assert.equal(capped.at(-1)?.appSessionId, 'sess-05');

      seedSession(db, 'app-1', 1_000);
      for (let index = 0; index < 5; index += 1) {
        store.append(
          textEvent(`snip-${String(index)}`, `needle snippet ${String(index)}`, {
            createdAt: 2_000 + index,
          }),
        );
      }
      const snippets = await store.search('needle');
      const app1 = snippets.find((result) => result.appSessionId === 'app-1');
      assert.ok(app1);
      assert.equal(app1.matches.length, 3);
      assert.deepEqual(
        app1.matches.map((match) => match.ts),
        [2_004, 2_003, 2_002],
      );

      for (let index = 0; index < MAX_SEARCH_SESSIONS + 1; index += 1) {
        const id = `old-${String(index).padStart(3, '0')}`;
        seedSession(db, id, 10_000 + index);
        store.append(
          textEvent(`${id}-hit`, 'albatross unique', {
            target: { kind: 'session', appSessionId: id },
            createdAt: 10_000 + index,
          }),
        );
      }
      const sessionWindow = await store.search('albatross');
      assert.equal(
        sessionWindow.some((result) => result.appSessionId === 'old-000'),
        false,
      );
      assert.equal(sessionWindow.length, 25);
      assert.equal(sessionWindow[0]?.appSessionId, 'old-150');
    },
    {
      searchBatchSize: 2,
      yieldToEventLoop: async () => {
        yields.push(1);
      },
    },
  );
  assert.equal(yields.length > 0, true);
});

test('search excludes tool, thinking, and internal text and yields between batches', async () => {
  const yields: number[] = [];
  await withStore(
    async (store, db) => {
      seedSession(db, 'app-1');
      store.append(
        event('think', {
          type: 'transcript',
          transcript: { role: 'primary', kind: 'thinking', text: 'needle hidden' },
        }),
      );
      store.append(
        event('tool', {
          type: 'transcript',
          transcript: {
            role: 'primary',
            kind: 'tool_call',
            text: 'needle hidden',
            toolName: 'Bash',
          },
        }),
      );
      store.append(textEvent('visible', 'needle visible', { createdAt: 3 }));
      store.append(
        textEvent('user', 'needle from user', {
          createdAt: 4,
          payload: {
            type: 'transcript',
            transcript: { role: 'primary', kind: 'text', text: 'needle from user', author: 'user' },
          },
        }),
      );
      const results = await store.search('needle');
      assert.equal(results.length, 1);
      assert.equal(results[0]?.matches.length, 2);
      assert.equal(results[0]?.matches[0]?.author, 'user');
      assert.equal(results[0]?.matches[1]?.author, 'assistant');
    },
    {
      searchBatchSize: 1,
      yieldToEventLoop: async () => {
        yields.push(Date.now());
      },
    },
  );
  assert.equal(yields.length, 2);
});

test('search stops before exceeding the injected byte budget', async () => {
  await withStore(
    async (store, db) => {
      seedSession(db, 'app-1');
      store.append(textEvent('old', 'needle-old', { createdAt: 1 }));
      store.append(textEvent('new', 'x'.repeat(80), { createdAt: 2 }));
      assert.deepEqual(await store.search('needle'), []);
    },
    { maxSearchTextBytes: 50 },
  );
});

test('stale search cancels before and after a batch', async () => {
  await withStore(
    async (store, db) => {
      seedSession(db, 'app-1');
      store.append(textEvent('a', 'needle a', { createdAt: 1 }));
      store.append(textEvent('b', 'needle b', { createdAt: 2 }));
      const before = await store.search('needle', () => true);
      assert.deepEqual(before, []);

      let checks = 0;
      const after = await store.search('needle', () => {
        checks += 1;
        return checks >= 2;
      });
      assert.deepEqual(after, []);
      assert.equal(checks >= 2, true);
    },
    { searchBatchSize: 1 },
  );
});

test('beginTurn participates in an outer identity transaction', async () => {
  await withStore((store, db) => {
    const sessions = new SessionStore(db);
    sessions.createProvisional({
      appSessionId: 'app-1',
      clientRef: 'ref-1',
      summary: {
        appSessionId: 'app-1',
        sessionPurpose: 'chat',
        role: 'primary',
        title: 'app-1',
        goal: 'goal',
        cwd: '/workspace',
        workspaceKind: 'folder',
        configuration: droidSessionConfiguration({
          modelId: 'model-default',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
        phase: 'initializing',
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    db.transaction(() => {
      store.beginTurn({
        turnId: 'turn-shared',
        target: { kind: 'session', appSessionId: 'app-1' },
        runtimeGeneration: 1,
        startedAt: '1000',
      });
    });
    store.settleTurn('turn-shared', {
      runtimeGeneration: 1,
      status: 'failed',
      settledAt: '2000',
    });
  });
});
