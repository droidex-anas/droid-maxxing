import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptEvent } from '../types/bridge';
import { createTranscriptSpecPathProjector } from './transcriptSpecPath';

function event(id: string, text: string): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text,
    ts: 1,
  };
}

test('streaming after a discovered spec path never rescans settled events', () => {
  let textReads = 0;
  const source = Array.from({ length: 3_000 }, (_, index) => {
    const text = index === 100 ? 'Saved /tmp/specs/plan.md' : `settled ${String(index)}`;
    const item = event(`event-${String(index)}`, text);
    Object.defineProperty(item, 'text', {
      configurable: true,
      enumerable: true,
      get: () => {
        textReads += 1;
        return text;
      },
    });
    return item;
  });
  const project = createTranscriptSpecPathProjector();
  assert.equal(
    project({ conversationKey: 'session-a', source, mutation: undefined, enabled: true }),
    '/tmp/specs/plan.md',
  );
  textReads = 0;

  const next = [...source, event('tail', 'still working')];
  assert.equal(
    project({
      conversationKey: 'session-a',
      source: next,
      mutation: {
        revision: 1,
        baseRevision: 0,
        kind: 'append',
        previousLength: source.length,
        firstChangedIndex: source.length,
      },
      enabled: true,
    }),
    '/tmp/specs/plan.md',
  );
  assert.equal(textReads, 0);
});

test('older history supplies a path only when the retained window has none', () => {
  const project = createTranscriptSpecPathProjector();
  const recent = [event('recent', 'no path')];
  project({ conversationKey: 'session-a', source: recent, mutation: undefined, enabled: true });
  const older = event('older', 'Saved /tmp/specs/older.md');

  assert.equal(
    project({
      conversationKey: 'session-a',
      source: [older, ...recent],
      mutation: {
        revision: 1,
        baseRevision: 0,
        kind: 'prepend',
        previousLength: recent.length,
        firstChangedIndex: 0,
        insertedCount: 1,
      },
      enabled: true,
    }),
    '/tmp/specs/older.md',
  );
});
