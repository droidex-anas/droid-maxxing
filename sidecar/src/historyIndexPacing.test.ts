import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  HistoryIndexDatabase,
  IDLE_BACKFILL_SLICE_DELAY_MS,
  RECENT_SLICE_DELAY_MS,
} from './historyIndexDatabase.js';
import { sqliteFts5UnavailableSkipReason } from './historySearchSchema.js';
import { readSessionSearchSlice } from './sessionSearch.js';

const FTS5_UNAVAILABLE_REASON = sqliteFts5UnavailableSkipReason();
const PREVIOUS_RECENT_SLICE_DELAY_MS = 250;

interface ChatFixture {
  label: string;
  providerSessionId: string;
  messageCount: number;
  tailToken: string;
  path: string;
  sizeBytes: number;
  slices: number;
}

interface ScheduledSlice {
  callback: () => void | Promise<void>;
  delayMs: number;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

function scheduler(): {
  schedule: (
    callback: () => void | Promise<void>,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
  runNext: () => Promise<number>;
  nextDelay: () => number | undefined;
} {
  const scheduled: ScheduledSlice[] = [];
  return {
    schedule: (callback, delayMs) => {
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      scheduled.push({ callback, delayMs, timer, cancelled: false });
      return timer;
    },
    cancel: (timer) => {
      const pending = scheduled.find((entry) => entry.timer === timer);
      if (pending) pending.cancelled = true;
      clearTimeout(timer);
    },
    runNext: async () => {
      const index = scheduled.findIndex((entry) => !entry.cancelled);
      assert.notEqual(index, -1, 'an indexing slice is scheduled');
      const [entry] = scheduled.splice(index, 1);
      const delayMs = entry?.delayMs ?? 0;
      await entry?.callback();
      return delayMs;
    },
    nextDelay: () => scheduled.find((entry) => !entry.cancelled)?.delayMs,
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function messageBody(role: 'user' | 'assistant', index: number, random: () => number): string {
  const roll = random();
  if (role === 'user') {
    return `Please look at item ${String(index)} and keep the change small.`;
  }
  if (roll < 0.1) {
    return `${'```ts\n'.repeat(1)}export function handle${String(index)}(input: string): string {\n  return input.repeat(${String(8 + Math.floor(random() * 24))});\n}\n${'// '.repeat(40)}${String(index)}\n\`\`\`\nThe helper stays local until a second caller appears.`;
  }
  if (roll < 0.3) {
    return `Here is the approach for turn ${String(index)}: keep ownership in the indexer, pace slices, and do not grind the event loop while the app sits still. `.repeat(
      4,
    );
  }
  return `Acknowledged turn ${String(index)}. Indexed search will catch the tail on the next recent-lane slice.`;
}

function writeRecentChat(
  sessionsDirectory: string,
  providerSessionId: string,
  messageCount: number,
  timestamp: number,
  tailToken: string,
): { path: string; sizeBytes: number } {
  const random = mulberry32(hashId(providerSessionId));
  const lines = [
    JSON.stringify({
      type: 'session_start',
      cwd: '/repo',
      sessionTitle: providerSessionId,
      settings: { interactionMode: 'auto' },
    }),
  ];
  for (let index = 0; index < messageCount; index += 1) {
    const role: 'user' | 'assistant' = index % 2 === 0 ? 'user' : 'assistant';
    const isTail = index === messageCount - 1;
    const text = isTail ? `closing thought ${tailToken}` : messageBody(role, index, random);
    lines.push(
      JSON.stringify({
        id: `${providerSessionId}-${String(index)}`,
        type: 'message',
        timestamp: new Date(timestamp + index).toISOString(),
        message: { role, content: [{ type: 'text', text }] },
      }),
    );
  }
  const path = join(sessionsDirectory, `${providerSessionId}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, sizeBytes: statSync(path).size };
}

async function countSlices(path: string, sizeBytes: number): Promise<number> {
  let offset = 0;
  let slices = 0;
  while (offset < sizeBytes) {
    const slice = await readSessionSearchSlice(
      {
        providerSessionId: 'pacing',
        appSessionId: 'pacing',
        path,
        sizeBytes,
      },
      offset,
    );
    slices += 1;
    if (slice.reachedEnd) break;
    assert.ok(slice.nextByteOffset > offset, 'each search slice must advance');
    offset = slice.nextByteOffset;
    assert.ok(slices < 10_000, 'slice counting must remain bounded');
  }
  return slices;
}

function pacedSeconds(slices: number, delayMs: number, cpuMs = 0): number {
  return (slices * delayMs + cpuMs) / 1_000;
}

function createCanonicalDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE app_sessions (
      app_session_id TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      compacted_from_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE settings (
      scope TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.close();
}

async function withRecentHome(
  run: (input: { sessionsDirectory: string; dbPath: string; now: number }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'droidex-index-pacing-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const databaseDirectory = join(home, '.factory', 'droidex');
  const sessionsDirectory = join(home, '.factory', 'sessions');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(sessionsDirectory, { recursive: true });
  try {
    await run({
      sessionsDirectory,
      dbPath: join(databaseDirectory, 'session-index.sqlite'),
      now: Date.UTC(2026, 7, 24),
    });
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test('recent-lane time to fully searchable is slice count times the active or idle delay', async (t) => {
  await withRecentHome(async ({ sessionsDirectory }) => {
    const now = Date.UTC(2026, 7, 24);
    const specs = [
      {
        label: 'small',
        providerSessionId: 'recent-small',
        messageCount: 12,
        tailToken: 'smalltail',
      },
      {
        label: 'medium',
        providerSessionId: 'recent-medium',
        messageCount: 3_000,
        tailToken: 'mediumtail',
      },
      {
        label: 'large',
        providerSessionId: 'recent-large',
        messageCount: 10_000,
        tailToken: 'largetail',
      },
    ];
    const fixtures: ChatFixture[] = [];
    for (const spec of specs) {
      const file = writeRecentChat(
        sessionsDirectory,
        spec.providerSessionId,
        spec.messageCount,
        now,
        spec.tailToken,
      );
      fixtures.push({
        ...spec,
        path: file.path,
        sizeBytes: file.sizeBytes,
        slices: await countSlices(file.path, file.sizeBytes),
      });
    }

    const small = fixtures[0];
    const medium = fixtures[1];
    const large = fixtures[2];
    assert.ok(small && medium && large);
    assert.equal(small.slices, 1, 'a short just-finished chat fits in one 256 KiB slice');
    assert.equal(medium.slices, 4, 'a 3k-event recent chat is four 256 KiB slices');
    assert.equal(large.slices, 11, 'a 10k-event recent chat is eleven 256 KiB slices');

    t.diagnostic(
      JSON.stringify(
        fixtures.map((fixture) => ({
          label: fixture.label,
          messages: fixture.messageCount,
          sizeKiB: Math.round(fixture.sizeBytes / 1024),
          slices: fixture.slices,
          beforeActiveSec: pacedSeconds(fixture.slices, PREVIOUS_RECENT_SLICE_DELAY_MS),
          afterActiveSec: pacedSeconds(fixture.slices, RECENT_SLICE_DELAY_MS),
          afterIdleSec: pacedSeconds(fixture.slices, IDLE_BACKFILL_SLICE_DELAY_MS),
        })),
      ),
    );

    for (const fixture of fixtures) {
      const beforeActive = pacedSeconds(fixture.slices, PREVIOUS_RECENT_SLICE_DELAY_MS);
      const afterActive = pacedSeconds(fixture.slices, RECENT_SLICE_DELAY_MS);
      const afterIdle = pacedSeconds(fixture.slices, IDLE_BACKFILL_SLICE_DELAY_MS);
      assert.equal(afterActive, beforeActive * 8);
      assert.equal(afterIdle, beforeActive * 20);
      assert.notEqual(afterActive, afterIdle, 'active use must not inherit the 5s OS-idle cadence');
    }

    const oneSliceBefore = pacedSeconds(1, PREVIOUS_RECENT_SLICE_DELAY_MS);
    const oneSliceAfter = pacedSeconds(1, RECENT_SLICE_DELAY_MS);
    assert.equal(oneSliceBefore, 0.25);
    assert.equal(oneSliceAfter, 2);
    assert.equal(pacedSeconds(1, IDLE_BACKFILL_SLICE_DELAY_MS), 5);
  });
});

test(
  'injected-clock indexing finds the tail only after every recent slice at the active delay',
  { skip: FTS5_UNAVAILABLE_REASON },
  async (t) => {
    const specs = [
      { providerSessionId: 'recent-small', messageCount: 12, tailToken: 'smalltail' },
      { providerSessionId: 'recent-medium', messageCount: 3_000, tailToken: 'mediumtail' },
      { providerSessionId: 'recent-large', messageCount: 10_000, tailToken: 'largetail' },
    ];
    const measured: Array<{
      id: string;
      slices: number;
      waitMs: number;
      cpuMs: number;
    }> = [];
    for (const spec of specs) {
      await withRecentHome(async ({ sessionsDirectory, dbPath, now }) => {
        writeRecentChat(
          sessionsDirectory,
          spec.providerSessionId,
          spec.messageCount,
          now,
          spec.tailToken,
        );
        createCanonicalDatabase(dbPath);
        const slices = scheduler();
        const database = new HistoryIndexDatabase(dbPath, {
          now: () => now,
          schedule: slices.schedule,
          cancel: slices.cancel,
        });
        try {
          database.reconcileSessionFiles();
          assert.equal(slices.nextDelay(), RECENT_SLICE_DELAY_MS);
          if (spec.providerSessionId === 'recent-small') {
            database.setIdle(true);
            assert.equal(slices.nextDelay(), IDLE_BACKFILL_SLICE_DELAY_MS);
            database.setIdle(false);
            assert.equal(slices.nextDelay(), RECENT_SLICE_DELAY_MS);
          }

          let waitMs = 0;
          let cpuMs = 0;
          let sliceCount = 0;
          let found = false;
          for (let step = 0; step < 10_000; step += 1) {
            const started = performance.now();
            waitMs += await slices.runNext();
            cpuMs += performance.now() - started;
            sliceCount += 1;
            if (database.search(spec.tailToken)[0]?.appSessionId === spec.providerSessionId) {
              found = true;
              break;
            }
          }
          assert.equal(found, true, `${spec.providerSessionId} tail must become searchable`);
          assert.equal(waitMs, sliceCount * RECENT_SLICE_DELAY_MS);
          measured.push({ id: spec.providerSessionId, slices: sliceCount, waitMs, cpuMs });
          assert.equal(slices.nextDelay(), undefined);
        } finally {
          await database.close();
        }
      });
    }
    t.diagnostic(JSON.stringify(measured));
  },
);
