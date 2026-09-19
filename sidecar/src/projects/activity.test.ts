import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectActivity } from './activity.js';
import type { TranscriptEvent } from '../protocol.js';

test('only the bounded final primary reply survives a turn, never thinking or tool output', () => {
  const activity = new ProjectActivity();
  const emit = (
    kind: TranscriptEvent['kind'],
    text: string,
    role: TranscriptEvent['role'] = 'primary',
  ) => {
    activity.append({
      id: text,
      appSessionId: 'thread',
      sourceSessionId: 'thread',
      ts: 1,
      kind,
      text,
      role,
    });
  };
  assert.equal(activity.start('thread'), true);
  emit('text', 'Before checking files');
  emit('tool_call', 'Read');
  emit('tool_result', 'SECRET TOOL PAYLOAD');
  emit('thinking', 'PRIVATE THINKING');
  emit('text', 'Foreign child reply', 'worker');
  emit('text', 'x'.repeat(9_000));
  assert.equal(activity.start('thread'), false);
  emit('text', ' finished');
  const reply = activity.finish('thread');
  assert.equal(reply?.length, 8_192);
  assert.ok(reply?.endsWith(' finished'));
  assert.doesNotMatch(reply ?? '', /SECRET|PRIVATE|Before|Foreign/);
  assert.equal(activity.finish('thread'), undefined);
  emit('text', 'Late data');
  assert.equal(activity.finish('thread'), undefined);
});
