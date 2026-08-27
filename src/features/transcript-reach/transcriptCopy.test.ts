import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeedItem } from '../../components/chat';
import { parseTruncatedTail, stripAnsi } from '../../lib/tools';
import type { TranscriptEvent } from '../../types/bridge';
import {
  copyTextForCommand,
  copyTextForFeedItem,
  copyTextForFeedItemRange,
  copyTextForMessage,
} from './transcriptCopy';

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

test('copying a range of unmounted rows matches per-message copy text in order', () => {
  const firstText = 'turn 1 answer\n\n[truncated 40 chars]';
  const thirdText = 'turn 2 stack trace';
  const items: FeedItem[] = [
    { type: 'message', key: 'm1', event: ev({ id: 'm1', text: firstText }) },
    {
      type: 'tools',
      key: 'tools-1',
      events: [
        ev({
          id: 'call-1',
          kind: 'tool_call',
          toolName: 'Bash',
          toolArgs: { command: 'npm test' },
          toolUseId: 't1',
        }),
        ev({
          id: 'result-1',
          kind: 'tool_result',
          toolUseId: 't1',
          text: '\u001b[31mError: boom\u001b[0m',
        }),
      ],
    },
    { type: 'message', key: 'm2', event: ev({ id: 'm2', text: thirdText }) },
    { type: 'message', key: 'm3', event: ev({ id: 'm3', text: 'not in range' }) },
  ];

  const expected = [
    copyTextForMessage(firstText),
    copyTextForCommand(
      'npm test',
      items[1] && items[1].type === 'tools' ? items[1].events[1]?.text : '',
    ),
    copyTextForMessage(thirdText),
  ].join('\n\n');

  assert.equal(copyTextForFeedItemRange(items, 'm1', 'm2'), expected);
  assert.equal(copyTextForFeedItem(items[0]!), parseTruncatedTail(firstText).body);
  assert.equal(
    copyTextForFeedItem(items[1]!),
    copyTextForCommand('npm test', '\u001b[31mError: boom\u001b[0m'),
  );
  assert.equal(
    copyTextForCommand('npm test', '\u001b[31mError: boom\u001b[0m').includes(
      stripAnsi('\u001b[31mError: boom\u001b[0m'),
    ),
    true,
  );
});

test('range copy is order-independent for the selected endpoints', () => {
  const items: FeedItem[] = [
    { type: 'message', key: 'a', event: ev({ id: 'a', text: 'alpha' }) },
    { type: 'message', key: 'b', event: ev({ id: 'b', text: 'beta' }) },
    { type: 'message', key: 'c', event: ev({ id: 'c', text: 'gamma' }) },
  ];
  assert.equal(
    copyTextForFeedItemRange(items, 'c', 'a'),
    copyTextForFeedItemRange(items, 'a', 'c'),
  );
  assert.equal(copyTextForFeedItemRange(items, 'a', 'c'), 'alpha\n\nbeta\n\ngamma');
});
