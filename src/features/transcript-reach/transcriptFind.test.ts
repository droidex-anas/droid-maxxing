import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeedItem } from '../../components/chat';
import { feedRowId } from '../../hooks/conversationViewportAnchor';
import { parseTruncatedTail } from '../../lib/tools';
import type { TranscriptEvent } from '../../types/bridge';
import { copyTextForCommand, copyTextForFeedItem, copyTextForMessage } from './transcriptCopy';
import {
  cycleMatchIndex,
  findTranscriptMatches,
  formatFindCount,
  projectTranscriptSearchIndex,
  TRANSCRIPT_FIND_DEBOUNCE_MS,
  transcriptFindScopeNotice,
} from './transcriptFind';

let seq = 0;
function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: extra.id ?? `e${String(++seq)}`,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: seq,
    kind: 'text',
    ...extra,
  };
}

function message(id: string, text: string, author: 'user' | 'assistant' = 'assistant'): FeedItem {
  return { type: 'message', key: id, event: ev({ id, text, author }) };
}

test('find searches feed state and locates a hit in an unmounted row', () => {
  const items = Array.from({ length: 200 }, (_, index) =>
    message(
      `row-${String(index)}`,
      index === 3 ? 'uniqueFunctionName in turn two' : `row ${String(index)}`,
    ),
  );
  const index = projectTranscriptSearchIndex(null, 'chat:primary', items, 'full', 0);
  const matches = findTranscriptMatches(index, 'uniqueFunctionName');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.itemKey, 'row-3');
  assert.equal(matches[0]?.rowId, feedRowId(items[3]!));
  assert.equal(index.rows.length, 200);
});

test('bounded loaded history is labelled instead of a silent no-match', () => {
  assert.equal(
    formatFindCount({ activeIndex: 0, matchCount: 0, hasOlderHistory: true }),
    'No matches in loaded history',
  );
  assert.equal(
    formatFindCount({ activeIndex: 0, matchCount: 2, hasOlderHistory: true }),
    '1 of 2 in loaded history',
  );
  assert.equal(
    formatFindCount({ activeIndex: 1, matchCount: 2, hasOlderHistory: false }),
    '2 of 2',
  );
  assert.deepEqual(
    transcriptFindScopeNotice({
      hasQuery: true,
      matchCount: 0,
      hasOlderHistory: true,
      isLoadingOlder: false,
    }),
    { kind: 'older-history', empty: true },
  );
  assert.equal(
    transcriptFindScopeNotice({
      hasQuery: true,
      matchCount: 0,
      hasOlderHistory: false,
      isLoadingOlder: false,
    }),
    null,
  );
});

test('next and previous wrap through the match list', () => {
  assert.equal(cycleMatchIndex(2, 3, 1), 0);
  assert.equal(cycleMatchIndex(0, 3, -1), 2);
  assert.equal(cycleMatchIndex(1, 3, 1), 2);
  assert.equal(cycleMatchIndex(0, 0, 1), 0);
});

test('append projection reuses unchanged haystacks instead of scanning on each keystroke', () => {
  assert.ok(TRANSCRIPT_FIND_DEBOUNCE_MS > 0);
  const initial = [message('a', 'alpha'), message('b', 'beta')];
  const first = projectTranscriptSearchIndex(null, 'chat:primary', initial, 'full', 0);
  const nextItems = [...initial, message('c', 'gamma')];
  const second = projectTranscriptSearchIndex(first, 'chat:primary', nextItems, 'append', 2);
  assert.equal(second.rows[0], first.rows[0]);
  assert.equal(second.rows[1], first.rows[1]);
  assert.equal(second.rows[2]?.itemKey, 'c');
});

test('message copy text matches the per-message copy button path', () => {
  const text = 'hello stack\n\n[truncated 12 chars]';
  const item = message('m1', text);
  assert.equal(copyTextForFeedItem(item), copyTextForMessage(text));
  assert.equal(copyTextForMessage(text), parseTruncatedTail(text).body);
});

test('command copy text matches the terminal copy button path', () => {
  const command = 'npm test';
  const output = '\u001b[31mFAIL\u001b[0m stack trace';
  const out = output.replace(/\u001b\[\d+m/g, '').trimEnd();
  assert.equal(copyTextForCommand(command, output), `${command}\n\n${out}`);
});
