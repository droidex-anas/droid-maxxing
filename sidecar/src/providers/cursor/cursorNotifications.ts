import type { AcpNotification } from '../acp/AcpConnection.js';
import {
  cursorTodoFingerprint,
  extractTodosAsPlan,
  formatCursorPlanSteps,
  parseCursorUpdateTodos,
} from './cursorExtensions.js';
import {
  ingestCursorToolCallUpdate,
  parseCursorAssistantTextDelta,
  sessionUpdateIsReplay,
  type CursorToolCallCoalesceState,
  type CursorToolCallState,
} from './cursorSessionUpdate.js';

export interface CursorNotificationTranscript {
  kind: 'text' | 'tool_call' | 'tool_result' | 'status';
  text: string;
  toolCall?: CursorToolCallState;
}

export function interpretCursorNotification(
  notification: AcpNotification,
  state: {
    toolCalls: Map<string, CursorToolCallCoalesceState>;
    lastTodoFingerprint: string | undefined;
  },
): { transcripts: CursorNotificationTranscript[]; lastTodoFingerprint: string | undefined } {
  if (notification.method === 'cursor/update_todos') {
    return interpretTodoNotification(notification.params, state.lastTodoFingerprint);
  }
  if (notification.method !== 'session/update' || sessionUpdateIsReplay(notification.params)) {
    return { transcripts: [], lastTodoFingerprint: state.lastTodoFingerprint };
  }
  const delta = parseCursorAssistantTextDelta(notification.params);
  if (delta) {
    return {
      transcripts: [{ kind: 'text', text: delta.text }],
      lastTodoFingerprint: state.lastTodoFingerprint,
    };
  }
  const tool = ingestCursorToolCallUpdate(state.toolCalls, notification.params);
  if (!tool || !tool.emit) {
    return { transcripts: [], lastTodoFingerprint: state.lastTodoFingerprint };
  }
  const text = tool.toolCall.detail ?? tool.toolCall.title ?? '';
  if (!text && !tool.toolCall.status) {
    return { transcripts: [], lastTodoFingerprint: state.lastTodoFingerprint };
  }
  const terminal = tool.toolCall.status === 'completed' || tool.toolCall.status === 'failed';
  return {
    transcripts: [
      {
        kind: terminal ? 'tool_result' : 'tool_call',
        text: tool.toolCall.detail ?? tool.toolCall.title ?? '',
        toolCall: tool.toolCall,
      },
    ],
    lastTodoFingerprint: state.lastTodoFingerprint,
  };
}

function interpretTodoNotification(
  params: unknown,
  lastTodoFingerprint: string | undefined,
): { transcripts: CursorNotificationTranscript[]; lastTodoFingerprint: string | undefined } {
  const parsed = parseCursorUpdateTodos(params);
  if (!parsed) {
    return { transcripts: [], lastTodoFingerprint };
  }
  const fingerprint = cursorTodoFingerprint(parsed.todos);
  if (fingerprint === lastTodoFingerprint) {
    return { transcripts: [], lastTodoFingerprint };
  }
  const formatted = formatCursorPlanSteps(extractTodosAsPlan(parsed.todos).plan);
  if (!formatted) {
    return { transcripts: [], lastTodoFingerprint: fingerprint };
  }
  return {
    transcripts: [{ kind: 'status', text: formatted }],
    lastTodoFingerprint: fingerprint,
  };
}
