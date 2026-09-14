// Claude Code SDK messages -> the normalized events every DROIDEX session
// already speaks (normalize.ts writes the same shapes from Droid's stream).
//
// The one rule that keeps the transcript honest: `stream_event` deltas are the
// only source of assistant text and thinking. The CLI also emits an `assistant`
// snapshot for each block as it finishes, carrying that block's full text, so
// re-emitting a snapshot would double every sentence in the chat. The snapshot
// backfills one case only: a message that streamed nothing at all (an aborted
// or synthetic frame), which is visible nowhere else.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { NormalizedEvent } from '../../normalize.js';
import type { TranscriptEvent } from '../../protocol.js';

const TOOL_BLOCK_TYPES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);

interface RateLimitInfo {
  status: string;
  overageStatus?: string;
  resetsAt?: number;
}

// Why a blocked usage window is worth telling the user about. A refusal stops
// the turn producing anything, which otherwise reads as the model hanging; an
// allowed window is routine accounting and says nothing.
export function rateLimitRefusal(info: RateLimitInfo): string | undefined {
  if (info.status !== 'rejected' || info.overageStatus === 'allowed') return undefined;
  const resumesAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '';
  return resumesAt
    ? `Claude usage limit reached. It resets at ${resumesAt}.`
    : 'Claude usage limit reached.';
}

interface ToolBlock {
  id: string;
  name: string;
  json: string;
}

// One content block of the message currently streaming. Its presence is what
// tells the assistant snapshot that this message already reached the transcript.
interface BlockState {
  tool?: ToolBlock;
}

let sequence = 0;
// A distinct suffix from normalize.ts's ids so two providers can never mint the
// same transcript id.
const nextId = (): string => `${Date.now().toString(36)}-c${(sequence++).toString(36)}`;

export class ClaudeEventMapper {
  // Content blocks of the message currently streaming, per conversation: a
  // subagent's frames carry their own block indices under its tool_use id.
  private readonly blocks = new Map<string, Map<number, BlockState>>();
  // Tool results already in the transcript for this turn, so the result's
  // authoritative denial list only has to cover the ones that never streamed.
  private readonly reportedResults = new Set<string>();
  private readonly totals = { tokensIn: 0, tokensOut: 0 };
  private call = { input: 0, output: 0 };

  constructor(private readonly appSessionId: string) {}

  map(message: SDKMessage): NormalizedEvent[] {
    switch (message.type) {
      case 'stream_event':
        return this.streamEvent(message.event, message.parent_tool_use_id);
      case 'assistant':
        return this.assistantSnapshot(message);
      case 'user':
        return this.toolResults(message);
      case 'result':
        return this.result(message);
      case 'rate_limit_event':
        return this.rateLimit(message.rate_limit_info);
      // Session bookkeeping, hook/task/plugin notices and the other auxiliary
      // frames carry nothing the DROIDEX transcript shows.
      case 'system':
      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'prompt_suggestion':
      case 'conversation_reset':
        return [];
      default:
        // Fails the build when the SDK adds a top-level message type.
        message satisfies never;
        return [];
    }
  }

  private streamEvent(
    event: Extract<SDKMessage, { type: 'stream_event' }>['event'],
    parentToolUseId: string | null,
  ): NormalizedEvent[] {
    const blocks = this.blocksFor(parentToolUseId);
    switch (event.type) {
      case 'message_start': {
        blocks.clear();
        if (parentToolUseId) return [];
        const usage = event.message.usage;
        this.call = {
          input:
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          output: 0,
        };
        return [this.usage()];
      }
      case 'message_delta':
        if (parentToolUseId) return [];
        this.call.output = event.usage.output_tokens;
        return [this.usage()];
      // The message is over, so the next `assistant` frame that arrives with no
      // stream events of its own is one this mapper has not reported yet.
      case 'message_stop':
        blocks.clear();
        return [];
      case 'content_block_start': {
        const tool = toolBlock(event.content_block);
        blocks.set(event.index, tool ? { tool: { ...tool, json: '' } } : {});
        return [];
      }
      case 'content_block_delta':
        return this.contentDelta(blocks, event.index, event.delta, parentToolUseId);
      case 'content_block_stop': {
        const tool = blocks.get(event.index)?.tool;
        return tool ? [this.toolCall(tool.id, tool.name, parseToolInput(tool.json))] : [];
      }
      default:
        return [];
    }
  }

  private contentDelta(
    blocks: Map<number, BlockState>,
    index: number,
    delta: { type: string; text?: string; thinking?: string; partial_json?: string },
    parentToolUseId: string | null,
  ): NormalizedEvent[] {
    if (delta.type === 'input_json_delta') {
      const tool = blocks.get(index)?.tool;
      if (tool) tool.json += delta.partial_json ?? '';
      return [];
    }
    // A subagent narrates its own conversation; only the main thread's prose
    // belongs in this chat. Its tool calls above are kept.
    if (parentToolUseId) return [];
    // A start always comes first in practice; recording the block here keeps the
    // snapshot rule right even if one is ever missed.
    if (!blocks.has(index)) blocks.set(index, {});
    if (delta.type === 'text_delta' && delta.text)
      return [{ transcript: this.transcript('text', { text: delta.text }) }];
    if (delta.type === 'thinking_delta' && delta.thinking)
      return [{ transcript: this.transcript('thinking', { text: delta.thinking }) }];
    return [];
  }

  private assistantSnapshot(
    message: Extract<SDKMessage, { type: 'assistant' }>,
  ): NormalizedEvent[] {
    const blocks = this.blocksFor(message.parent_tool_use_id);
    // The snapshot's content is the block that just finished, not the message so
    // far, so it cannot be matched positionally against the stream. Blocks that
    // streamed are already in the transcript, and a tool block is matched by its
    // id, which is stable.
    const streamed = blocks.size > 0;
    const reported = new Set(
      [...blocks.values()].flatMap((block) => (block.tool ? [block.tool.id] : [])),
    );
    const events: NormalizedEvent[] = [];
    for (const block of message.message.content) {
      const tool = toolBlock(block);
      if (tool) {
        if (!reported.has(tool.id))
          events.push(this.toolCall(tool.id, tool.name, (block as { input?: unknown }).input));
        continue;
      }
      if (streamed || message.parent_tool_use_id) continue;
      if (block.type === 'text' && block.text)
        events.push({ transcript: this.transcript('text', { text: block.text }) });
      if (block.type === 'thinking' && block.thinking)
        events.push({ transcript: this.transcript('thinking', { text: block.thinking }) });
    }
    if (message.error)
      events.push({ transcript: this.transcript('error', { text: message.error, isError: true }) });
    return events;
  }

  private toolResults(message: Extract<SDKMessage, { type: 'user' }>): NormalizedEvent[] {
    const content = message.message.content;
    if (typeof content === 'string') return [];
    return content.flatMap((block) => {
      if (block.type !== 'tool_result') return [];
      this.reportedResults.add(block.tool_use_id);
      return {
        transcript: this.transcript('tool_result', {
          text: toolResultText(block.content),
          isError: block.is_error === true,
          toolUseId: block.tool_use_id,
        }),
      };
    });
  }

  // modelUsage covers the main loop, subagents and compaction, and is cumulative
  // for the whole query(). Settlement itself is the session's call: a result left
  // behind by an interrupted turn contributes usage and nothing else.
  private result(message: Extract<SDKMessage, { type: 'result' }>): NormalizedEvent[] {
    this.totals.tokensIn = 0;
    this.totals.tokensOut = 0;
    for (const usage of Object.values(message.modelUsage)) {
      this.totals.tokensIn +=
        usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
      this.totals.tokensOut += usage.outputTokens;
    }
    // The denial list is the turn's authoritative record; a refusal usually
    // reaches the model as a tool result too, and that row is the one the
    // transcript keeps. What is left never streamed at all.
    const missed = message.permission_denials.flatMap((denial) =>
      this.reportedResults.has(denial.tool_use_id)
        ? []
        : [
            {
              transcript: this.transcript('tool_result', {
                text: `${denial.tool_name} was denied.`,
                isError: true,
                toolUseId: denial.tool_use_id,
              }),
            },
          ],
    );
    this.reportedResults.clear();
    return [...missed, this.usage()];
  }

  // A line the session itself has to say: what the CLI is doing before it can
  // answer, in the row shape every provider's status already uses.
  statusEvent(text: string): NormalizedEvent {
    return { transcript: this.transcript('status', { text }) };
  }

  private rateLimit(info: RateLimitInfo): NormalizedEvent[] {
    const refusal = rateLimitRefusal(info);
    return refusal ? [this.statusEvent(refusal)] : [];
  }

  private toolCall(id: string, name: string, input: unknown): NormalizedEvent {
    return {
      transcript: this.transcript('tool_call', { toolName: name, toolArgs: input, toolUseId: id }),
    };
  }

  // The context reading is the current API call's own window occupancy, which is
  // what the meter measures; the cumulative totals come from the result.
  private usage(): NormalizedEvent {
    return {
      tokens: {
        tokensIn: this.totals.tokensIn,
        tokensOut: this.totals.tokensOut,
        contextTokens: this.call.input + this.call.output,
      },
    };
  }

  private blocksFor(parentToolUseId: string | null): Map<number, BlockState> {
    const key = parentToolUseId ?? '';
    const existing = this.blocks.get(key);
    if (existing) return existing;
    const created = new Map<number, BlockState>();
    this.blocks.set(key, created);
    return created;
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

// The tool-use block shapes share id/name; the SDK's own union splits them by
// server/mcp provenance, which the transcript does not distinguish.
function toolBlock(block: { type: string }): { id: string; name: string } | undefined {
  if (!TOOL_BLOCK_TYPES.has(block.type)) return undefined;
  const { id, name } = block as unknown as { id: string; name: string };
  return { id, name };
}

// A tool whose input never finished streaming (an interrupt, or a block the
// model left open) still deserves its row, so a partial payload reads as no
// arguments rather than failing the turn.
function parseToolInput(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((block: unknown) => {
      const text = (block as { text?: string }).text;
      return typeof text === 'string' ? text : JSON.stringify(block);
    })
    .join('\n');
}
