import type { FeedItem } from '../../components/chat';
import type { FileChange } from '../../lib/diff';
import { childSessionInfo } from '../../lib/childSessionEvents';
import { parseTruncatedTail, stripAnsi, toolMeta } from '../../lib/tools';
import type { TranscriptEvent } from '../../types/bridge';

export function copyTextForMessage(text: string): string {
  return parseTruncatedTail(text).body;
}

export function copyTextForCommand(command: string, output?: string): string {
  const out = output ? stripAnsi(output).trimEnd() : '';
  return out ? `${command}\n\n${out}` : command;
}

export function copyTextForFileChange(change: FileChange): string {
  const body = change.ops
    .map((op) => `${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}${op.text}`)
    .join('\n');
  return body ? `${change.verb} ${change.path}\n${body}` : `${change.verb} ${change.path}`;
}

export function copyTextForFeedItem(item: FeedItem): string {
  switch (item.type) {
    case 'message':
      return copyTextForMessage(item.event.text ?? '');
    case 'thinking':
    case 'status':
    case 'error':
      return stripAnsi(item.event.text ?? '').trimEnd();
    case 'diff':
      return copyTextForFileChange(item.change);
    case 'diffs':
      return joinCopyParts(item.changes.map((entry) => copyTextForFileChange(entry.change)));
    case 'tools':
      return copyTextForToolEvents(item.events);
    case 'child_session':
      return copyTextForChildSession(item.event);
    case 'child_sessions':
      return joinCopyParts(item.events.map(copyTextForChildSession));
    case 'worked':
      return joinCopyParts(item.items.map(copyTextForFeedItem));
    case 'turnChanges':
      return item.files.map((file) => file.path).join('\n');
  }
}

export function copyTextForFeedItemRange(
  items: readonly FeedItem[],
  fromKey: string,
  toKey: string,
): string {
  const fromIndex = items.findIndex((item) => item.key === fromKey);
  const toIndex = items.findIndex((item) => item.key === toKey);
  if (fromIndex < 0 || toIndex < 0) return '';
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return joinCopyParts(items.slice(start, end + 1).map(copyTextForFeedItem));
}

function joinCopyParts(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

function argStr(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function copyTextForChildSession(event: TranscriptEvent): string {
  const info = childSessionInfo(event.toolArgs);
  return joinCopyParts([info.label ?? '', info.description ?? '', event.text ?? '']);
}

function copyTextForToolCall(call: TranscriptEvent, result?: TranscriptEvent): string {
  const meta = toolMeta(call.toolName, call.toolArgs);
  if (meta.cat === 'exec') {
    const command =
      argStr(call.toolArgs, 'command') ??
      argStr(call.toolArgs, 'cmd') ??
      argStr(call.toolArgs, 'script') ??
      meta.detail ??
      call.toolName ??
      'command';
    return copyTextForCommand(command, result?.text);
  }
  const head = meta.detail || call.toolName || '';
  const out = result?.text ? stripAnsi(result.text).trimEnd() : '';
  if (head && out) return `${head}\n\n${out}`;
  return out || head;
}

function copyTextForToolEvents(events: readonly TranscriptEvent[]): string {
  const resultById = new Map<string, TranscriptEvent>();
  for (const event of events) {
    if (event.kind === 'tool_result' && event.toolUseId) resultById.set(event.toolUseId, event);
  }
  const consumed = new Set<string>();
  const parts: string[] = [];
  for (const event of events) {
    if (event.kind === 'tool_call') {
      const result = event.toolUseId ? resultById.get(event.toolUseId) : undefined;
      if (result) consumed.add(result.id);
      parts.push(copyTextForToolCall(event, result));
      continue;
    }
    if (event.kind === 'tool_result' && !consumed.has(event.id)) {
      parts.push(stripAnsi(event.text ?? '').trimEnd());
    }
  }
  return joinCopyParts(parts);
}
