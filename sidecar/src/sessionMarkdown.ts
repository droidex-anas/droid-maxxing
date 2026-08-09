// TranscriptEvent[] → Markdown for the sidebar's "Copy as Markdown" action.
// Conversation-shaped: user/Droid turns are headings, tool calls and results
// are fenced, thinking folds into a details block, compaction becomes a
// divider. Oversized payloads are truncated so a huge tool dump cannot make
// the clipboard payload unusable.
import type { TranscriptEvent } from './protocol.js';

const MAX_TOOL_CHARS = 2_000;
const MAX_THINKING_CHARS = 4_000;

export interface SessionMarkdownMeta {
  title: string;
  providerSessionId: string;
  cwd?: string;
  // Caveat shown right under the header, e.g. when the export is truncated.
  note?: string;
  // Injectable for deterministic tests.
  exportedAt?: Date;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${String(text.length - max)} chars]`;
}

// A fence one tick longer than the payload's longest backtick run keeps any
// embedded code fence intact.
function fenced(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function toolCallBlock(event: TranscriptEvent): string {
  const name = event.toolName ?? 'tool';
  const args =
    event.toolArgs === undefined
      ? null
      : truncate(JSON.stringify(event.toolArgs, null, 2), MAX_TOOL_CHARS);
  return args ? `**Tool: ${name}**\n\n${fenced(args)}` : `**Tool: ${name}**`;
}

function toolResultBlock(event: TranscriptEvent): string | null {
  if (!event.text) return null;
  const label = event.isError ? 'Tool error' : 'Tool result';
  const name = event.toolName ? `: ${event.toolName}` : '';
  return `**${label}${name}**\n\n${fenced(truncate(event.text, MAX_TOOL_CHARS))}`;
}

// History surfaces two kinds of status events: transient UI chrome (spinners,
// phase lines), which is not conversation content, and the oversized-file trim
// notice, which documents that older messages were dropped from the export.
// Only the former is dropped; silently eliding the trim notice would misstate
// the export as complete.
function isTrimNotice(event: TranscriptEvent): boolean {
  return event.text?.includes('oversized session') ?? false;
}

function blockFor(event: TranscriptEvent): string | null {
  switch (event.kind) {
    case 'text':
      if (!event.text) return null;
      return event.author === 'user' ? `## User\n\n${event.text}` : `## Droid\n\n${event.text}`;
    case 'thinking':
      if (!event.text) return null;
      return `<details>\n<summary>Thinking</summary>\n\n${truncate(event.text, MAX_THINKING_CHARS)}\n\n</details>`;
    case 'tool_call':
      return toolCallBlock(event);
    case 'tool_result':
      return toolResultBlock(event);
    case 'error':
      return event.text ? `> **Error:** ${event.text}` : null;
    case 'compaction':
      return `---\n\n*${String(event.removedCount ?? 0)} earlier messages were summarized by compaction.*`;
    case 'status':
      if (!isTrimNotice(event)) return null;
      return `> **Note:** ${event.text ?? 'This session was trimmed for performance.'}`;
  }
}

export function transcriptToMarkdown(events: TranscriptEvent[], meta: SessionMarkdownMeta): string {
  const exportedAt = meta.exportedAt ?? new Date();
  const header = [
    `# ${meta.title}`,
    '',
    `- **Droid session:** \`${meta.providerSessionId}\` — resume with \`droid -r ${meta.providerSessionId}\``,
    ...(meta.cwd ? [`- **Directory:** \`${meta.cwd}\``] : []),
    `- **Exported:** ${exportedAt.toISOString()}`,
  ].join('\n');
  const blocks = events.map(blockFor).filter((block): block is string => block !== null);
  return [header, ...(meta.note ? [`> **Note:** ${meta.note}`] : []), ...blocks].join('\n\n');
}
