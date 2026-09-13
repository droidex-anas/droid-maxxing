// Durable transcript for a session whose provider keeps no session file of its
// own (everything except Droid). Scrollback and the sidebar both come from the
// stored-JSONL reader, so this writer emits exactly what that reader parses:
// one session_start head line, then one stored message line per settled
// message, at <userData>/provider-sessions/<appSessionId>.jsonl.
//
// The reader is the contract. sessionFileHead.ts needs the head line plus a
// completed user/assistant exchange to admit a sidebar row, history.ts reads
// cwd, title, the model settings and the provider binding off the head, and
// sessionTranscriptParser.ts maps the content blocks below back to transcript
// events. Changing a shape here without reading those three is a silent
// "session is empty after restart" bug.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { providerSessionsDir } from '../droidexPaths.js';
import type { SessionSummary, TranscriptEvent } from '../protocol.js';
import type { StoredMessageLine, StoredSessionStart } from '../sessionTranscriptParser.js';

// The head line: a StoredSessionStart plus the settings readSessionModelSettings
// reads off the same record. Without modelId the restored session has no launch
// settings and cannot be resumed.
interface ProviderSessionStart extends StoredSessionStart {
  modelId?: string;
  reasoningEffort?: string;
  autonomyLevel?: string;
}

type ContentBlock = Record<string, unknown>;

interface PendingMessage {
  id: string;
  ts: number;
  blocks: ContentBlock[];
}

export class ProviderTranscriptFile {
  private readonly path: string;
  private pending: PendingMessage | null = null;
  private headWritten = false;
  private promptSeq = 0;

  // Holds the registry's live summary rather than a copy: the head line is
  // written with the first message, so a session abandoned before its first
  // turn leaves no file, and a provider that mints its resume handle during
  // create still gets it onto the head.
  constructor(private readonly summary: SessionSummary) {
    this.path = join(providerSessionsDir(), `${summary.appSessionId}.jsonl`);
  }

  // A turn's prompt. The renderer already showed it, so it is persisted here
  // rather than replayed as a live event.
  appendPrompt(text: string): void {
    if (!text) return;
    this.flush();
    const ts = Date.now();
    this.writeMessage('user', [{ type: 'text', text }], `prompt-${this.nextPromptId(ts)}`, ts);
  }

  append(event: TranscriptEvent): void {
    // Child sessions keep their own transcripts; this file is one conversation.
    if (event.role !== 'primary') return;
    const block = assistantBlock(event);
    if (block) {
      this.pending ??= { id: event.id, ts: event.ts, blocks: [] };
      this.pending.blocks.push(block);
      return;
    }
    const result = toolResultBlock(event);
    if (!result) return;
    // A result belongs after the call that produced it.
    this.flush();
    this.writeMessage('user', [result], event.id, event.ts);
  }

  // Closes the open assistant message. Called when a turn settles and when the
  // session closes, so one stored line is one settled message.
  flush(): void {
    const message = this.pending;
    if (!message) return;
    this.pending = null;
    this.writeMessage('assistant', message.blocks, message.id, message.ts);
  }

  private nextPromptId(ts: number): string {
    return `${ts.toString(36)}-${(this.promptSeq++).toString(36)}`;
  }

  private writeMessage(
    role: 'user' | 'assistant',
    content: ContentBlock[],
    id: string,
    ts: number,
  ): void {
    const line: StoredMessageLine = {
      type: 'message',
      id,
      timestamp: new Date(ts).toISOString(),
      message: { role, content },
    };
    this.writeLine(line);
  }

  private writeLine(line: object): void {
    if (!this.headWritten) {
      mkdirSync(providerSessionsDir(), { recursive: true });
      // A resumed session appends to the transcript it already has: one head
      // line per file, written with the session's first message.
      if (!existsSync(this.path)) appendFileSync(this.path, serialize(headLine(this.summary)));
      this.headWritten = true;
    }
    appendFileSync(this.path, serialize(line));
  }
}

function headLine(summary: SessionSummary): ProviderSessionStart {
  return {
    type: 'session_start',
    id: summary.appSessionId,
    provider: summary.provider,
    cwd: summary.cwd,
    title: summary.title,
    autonomyLevel: summary.autonomy,
    ...(summary.resumeId ? { resumeId: summary.resumeId } : {}),
    ...(summary.modelId ? { modelId: summary.modelId } : {}),
    ...(summary.reasoningEffort ? { reasoningEffort: summary.reasoningEffort } : {}),
  };
}

function assistantBlock(event: TranscriptEvent): ContentBlock | null {
  if (event.kind === 'tool_call') {
    return {
      type: 'tool_use',
      ...(event.toolUseId ? { id: event.toolUseId } : {}),
      name: event.toolName ?? 'tool',
      input: event.toolArgs,
    };
  }
  if (!event.text) return null;
  if (event.kind === 'text') return { type: 'text', text: event.text };
  if (event.kind === 'thinking') return { type: 'thinking', thinking: event.text };
  return null;
}

function toolResultBlock(event: TranscriptEvent): ContentBlock | null {
  if (event.kind !== 'tool_result') return null;
  return {
    type: 'tool_result',
    ...(event.toolUseId ? { tool_use_id: event.toolUseId } : {}),
    ...(event.toolName ? { name: event.toolName } : {}),
    content: event.text ?? '',
    ...(event.isError ? { is_error: true } : {}),
  };
}

function serialize(line: object): string {
  return `${JSON.stringify(line)}\n`;
}
