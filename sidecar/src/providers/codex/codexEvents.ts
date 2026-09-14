// `codex app-server` notifications -> the normalized events every DROIDEX
// session already speaks (normalize.ts writes the same shapes from Droid's
// stream, claudeEvents.ts from Claude's).
//
// Deltas are the only source of assistant text and thinking: the completed item
// repeats the whole message, so re-emitting it would double every sentence. The
// completed item backfills one case, a message that streamed nothing at all.
import type { NormalizedEvent } from '../../normalize.js';
import type { TranscriptEvent } from '../../protocol.js';
import {
  patchText,
  threadItem,
  toolCall,
  toolOutput,
  type FileUpdateChange,
  type ThreadItem,
} from './codexItems.js';

// A notification payload is untrusted: every reader below returns undefined
// rather than throwing, so an unknown shape cannot escape the transport's
// stdout listener.
export interface CodexTurn {
  id: string;
  status?: string;
  error?: { message: string } | null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function turnOf(params: unknown): CodexTurn | undefined {
  if (!isObject(params) || !isObject(params.turn)) return undefined;
  const turn = params.turn as Partial<CodexTurn>;
  return typeof turn.id === 'string' ? (turn as CodexTurn) : undefined;
}

export function errorOf(params: unknown): { message: string; willRetry: boolean } | undefined {
  if (!isObject(params) || !isObject(params.error)) return undefined;
  const message = (params.error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  return { message, willRetry: params.willRetry === true };
}

// The notifications this mapper translates. The session owns the rest of the
// turn's lifecycle (thread/started, turn/started, turn/completed, error) and
// everything else Codex reports is ignored.
export const MAPPED_NOTIFICATIONS = [
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/started',
  'item/completed',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'thread/tokenUsage/updated',
] as const;

interface DeltaParams {
  itemId: string;
  delta: string;
}

interface PatchParams {
  itemId: string;
  changes: FileUpdateChange[];
}

function deltaOf(params: Record<string, unknown>): DeltaParams | undefined {
  const { itemId, delta } = params;
  return typeof itemId === 'string' && typeof delta === 'string' ? { itemId, delta } : undefined;
}

function patchOf(params: Record<string, unknown>): PatchParams | undefined {
  const { itemId, changes } = params;
  if (typeof itemId !== 'string' || !Array.isArray(changes)) return undefined;
  return { itemId, changes: changes as FileUpdateChange[] };
}

function tokenUsageOf(params: Record<string, unknown>): ThreadTokenUsage | undefined {
  const usage = params.tokenUsage;
  if (!isObject(usage) || !isObject(usage.total) || !isObject(usage.last)) return undefined;
  return usage as unknown as ThreadTokenUsage;
}

// A tool call still running: what it is about, for an approval card that has to
// describe it, and the output collected so far.
interface OpenTool {
  detail: string;
  output: string;
}

let sequence = 0;
// A distinct suffix from normalize.ts's and claudeEvents.ts's ids so no two
// providers can mint the same transcript id.
const nextId = (): string => `${Date.now().toString(36)}-x${(sequence++).toString(36)}`;

export class CodexEventMapper {
  private readonly tools = new Map<string, OpenTool>();
  // Message items that have already reached the transcript through their deltas.
  private readonly streamed = new Set<string>();

  constructor(private readonly appSessionId: string) {}

  // Every payload is read through a reader that answers undefined for a shape
  // this build does not recognize: a notification is not worth throwing out of
  // the transport's synchronous stdout listener.
  map(method: string, params: unknown): NormalizedEvent[] {
    if (!isObject(params)) return [];
    switch (method) {
      case 'item/agentMessage/delta':
        return this.delta('text', deltaOf(params));
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return this.delta('thinking', deltaOf(params));
      case 'item/started':
        return this.started(threadItem(params));
      case 'item/completed':
        return this.completed(threadItem(params));
      case 'item/commandExecution/outputDelta':
        return this.appendOutput(deltaOf(params));
      case 'item/fileChange/patchUpdated':
        return this.replacePatch(patchOf(params));
      case 'thread/tokenUsage/updated': {
        const usage = tokenUsageOf(params);
        return usage ? [tokens(usage)] : [];
      }
      default:
        return [];
    }
  }

  // What a pending approval is about. A file-change approval carries no detail
  // of its own, so the open item it belongs to is the only description there is.
  toolDetail(itemId: string): string | undefined {
    return this.tools.get(itemId)?.detail;
  }

  errorEvent(message: string): NormalizedEvent {
    return { transcript: this.transcript('error', { text: message, isError: true }) };
  }

  // A line the session itself has to say: what the thread is doing before it can
  // answer, in the row shape every provider's status already uses.
  statusEvent(text: string): NormalizedEvent {
    return { transcript: this.transcript('status', { text }) };
  }

  private delta(kind: 'text' | 'thinking', params: DeltaParams | undefined): NormalizedEvent[] {
    if (!params?.delta) return [];
    if (kind === 'text') this.streamed.add(params.itemId);
    return [{ transcript: this.transcript(kind, { text: params.delta }) }];
  }

  private appendOutput(params: DeltaParams | undefined): NormalizedEvent[] {
    if (!params) return [];
    const tool = this.tools.get(params.itemId);
    if (tool) tool.output += params.delta;
    return [];
  }

  private replacePatch(params: PatchParams | undefined): NormalizedEvent[] {
    if (!params) return [];
    const tool = this.tools.get(params.itemId);
    if (tool) tool.output = patchText(params.changes);
    return [];
  }

  private started(item: ThreadItem): NormalizedEvent[] {
    const call = toolCall(item);
    if (!call) return [];
    this.tools.set(call.id, { detail: call.detail, output: '' });
    return [
      {
        transcript: this.transcript('tool_call', {
          toolName: call.name,
          toolArgs: call.args,
          toolUseId: call.id,
        }),
      },
    ];
  }

  private completed(item: ThreadItem): NormalizedEvent[] {
    if (item.type === 'agentMessage') {
      // A message that never streamed is visible nowhere else.
      if (this.streamed.delete(item.id) || !item.text) return [];
      return [{ transcript: this.transcript('text', { text: item.text }) }];
    }
    const call = toolCall(item);
    if (!call) return [];
    const open = this.tools.get(call.id);
    this.tools.delete(call.id);
    return [
      {
        transcript: this.transcript('tool_result', {
          toolName: call.name,
          text: toolOutput(item, open?.output ?? '', this.appSessionId),
          isError: call.failed,
          toolUseId: call.id,
        }),
      },
    ];
  }

  private transcript(
    kind: TranscriptEvent['kind'],
    extra: Partial<TranscriptEvent>,
  ): TranscriptEvent {
    return {
      id: nextId(),
      appSessionId: this.appSessionId,
      sourceSessionId: this.appSessionId,
      role: 'primary',
      ts: Date.now(),
      kind,
      ...extra,
    };
  }
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

// `total` is the thread's running cost; `last` is the most recent call, which is
// what currently occupies the context window.
function tokens(usage: ThreadTokenUsage): NormalizedEvent {
  return {
    tokens: {
      tokensIn: count(usage.total.inputTokens),
      tokensOut: count(usage.total.outputTokens),
      contextTokens: count(usage.last.totalTokens),
      ...(usage.modelContextWindow ? { maxContextTokens: usage.modelContextWindow } : {}),
    },
  };
}

// A counter Codex did not send has not been spent; publishing NaN instead would
// travel all the way into the stored summary.
function count(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
