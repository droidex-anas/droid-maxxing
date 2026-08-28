import type { DroidStreamEvent } from '@factory/droid-sdk';
import { convertNotificationToStreamMessage } from '@factory/droid-sdk';

import type { BridgeFeature, SessionRole, TranscriptEvent } from '../../protocol.js';
import { parseSkillActivation, type SkillActivation } from '../../skillSignals.js';
import {
  detectChildSession,
  backgroundTaskCompletionProviderSessionId,
  isTaskToolName,
  slimChildSessionArgs,
  taskPrompt,
  taskResultChildUpdate,
  type ChildSessionSignal,
} from '../../subagentSignals.js';
import { trimmedString as str } from '../../values.js';
import type { ProviderRuntimeEvent, ProviderRuntimeEventBase } from '../providerEvents.js';
import {
  mapProgress,
  normalizeMissionStreamEvent,
  type NormalizedProgressEntry,
} from './DroidMissionSignals.js';

export { mapProgress } from './DroidMissionSignals.js';
export type { NormalizedProgressEntry } from './DroidMissionSignals.js';

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function transcript(
  appSessionId: string,
  sourceSessionId: string,
  role: SessionRole,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  return { id: nextId(), appSessionId, sourceSessionId, role, ts: Date.now(), kind, ...extra };
}

export interface NormalizedEvent {
  transcript?: TranscriptEvent;
  features?: BridgeFeature[];
  progress?: NormalizedProgressEntry[];
  missionState?: string;
  missionChild?: {
    event: 'started' | 'completed';
    providerSessionId: string;
    exitCode?: number;
  };
  childSession?: ChildSessionSignal;
  tokens?: { tokensIn: number; tokensOut: number; contextTokens?: number };
  done?: boolean;
}

function toolUseIdFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    const id = str(value);
    if (id) return id;
  }
  return undefined;
}

export function normalizeStreamEvent(
  appSessionId: string,
  sourceProviderSessionId: string,
  role: SessionRole,
  ev: DroidStreamEvent,
): NormalizedEvent | null {
  const raw = ev as unknown as Record<string, unknown>;
  if (raw.type === 'token_usage_update' || raw.type === 'session_token_usage_changed') {
    const usage = raw as Record<string, Record<string, unknown> | undefined>;
    const cumulative = usage.inclusiveTokenUsage ?? usage.tokenUsage ?? usage;
    const context =
      usage.lastCallTokenUsage ?? (raw.type === 'token_usage_update' ? usage : undefined);
    const tokensIn =
      (Number(cumulative.inputTokens ?? 0) || 0) +
      (Number(cumulative.cacheReadTokens ?? 0) || 0) +
      (Number(cumulative.cacheCreationTokens ?? 0) || 0);
    const tokensOut = Number(cumulative.outputTokens ?? 0) || 0;
    const contextTokens = context
      ? (Number(context.inputTokens ?? 0) || 0) +
        (Number(context.outputTokens ?? 0) || 0) +
        (Number(context.cacheReadTokens ?? 0) || 0)
      : undefined;
    return {
      tokens: {
        tokensIn,
        tokensOut,
        ...(contextTokens === undefined ? {} : { contextTokens }),
      },
    };
  }

  const update =
    raw.update && typeof raw.update === 'object'
      ? (raw.update as Record<string, unknown>)
      : undefined;
  const subagentSessionId = str(raw.subagentSessionId) ?? str(update?.subagentSessionId);
  const eventToolUseId = toolUseIdFrom(raw.toolUseId, update?.toolUseId);

  if (ev.type === 'tool_progress' || raw.type === 'tool_progress') {
    const params =
      update?.parameters && typeof update.parameters === 'object'
        ? (update.parameters as Record<string, unknown>)
        : {};
    const label = str(params.subagent_type) ?? str(params.subagentType);
    const prompt = taskPrompt(params);
    if (!subagentSessionId && !label && !prompt) return null;
    const isSpawnProgress = Boolean(label ?? prompt);
    return {
      childSession: {
        providerSessionId: subagentSessionId,
        ...(isSpawnProgress && eventToolUseId ? { toolUseId: eventToolUseId } : {}),
        label,
        prompt,
      },
    };
  }

  const mission = normalizeMissionStreamEvent(ev);
  if (mission) return mission;

  switch (ev.type) {
    case 'assistant_text_delta':
      return {
        transcript: transcript(appSessionId, sourceProviderSessionId, role, 'text', {
          text: ev.text,
        }),
      };
    case 'thinking_text_delta':
      return {
        transcript: transcript(appSessionId, sourceProviderSessionId, role, 'thinking', {
          text: ev.text,
        }),
      };
    case 'tool_call':
    case 'tool_call_delta': {
      const toolUse =
        (ev as { toolUse?: { id?: string; name?: string; input?: Record<string, unknown> } })
          .toolUse ?? {};
      const toolUseId = toolUseIdFrom(toolUse.id, eventToolUseId);
      const childSession = detectChildSession(
        toolUse.name,
        toolUse.input ?? {},
        subagentSessionId,
        toolUseId,
      );
      return {
        transcript: transcript(appSessionId, sourceProviderSessionId, role, 'tool_call', {
          toolName: toolUse.name,
          toolArgs: childSession ? slimChildSessionArgs(toolUse.input ?? {}) : toolUse.input,
          ...(toolUseId ? { toolUseId } : {}),
        }),
        ...(childSession ? { childSession } : {}),
      };
    }
    case 'tool_result': {
      const isTask = isTaskToolName(ev.toolName);
      const toolUseId = toolUseIdFrom((ev as { toolUseId?: string }).toolUseId, eventToolUseId);
      const taskUpdate = ev.isError ? undefined : taskResultChildUpdate(ev.toolName, ev.content);
      const resultProviderSessionId = subagentSessionId ?? taskUpdate?.providerSessionId;
      const resultTranscript = () =>
        transcript(appSessionId, sourceProviderSessionId, role, 'tool_result', {
          toolName: ev.toolName,
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          isError: ev.isError,
          ...(toolUseId ? { toolUseId } : {}),
        });
      if (resultProviderSessionId || isTask) {
        const signal = {
          childSession: {
            providerSessionId: resultProviderSessionId,
            ...(isTask && taskUpdate?.isSpawnResult !== false && toolUseId ? { toolUseId } : {}),
            done: taskUpdate?.done ?? true,
            ...(taskUpdate?.activity ? { activity: taskUpdate.activity } : {}),
          },
        };
        if (!isTask) return { ...signal, transcript: resultTranscript() };
        if (!ev.isError) return signal;
        return { ...signal, transcript: resultTranscript() };
      }
      return { transcript: resultTranscript() };
    }
    case 'error':
      return {
        transcript: transcript(appSessionId, sourceProviderSessionId, role, 'error', {
          text: ev.message,
          isError: true,
        }),
      };
    case 'result':
      return { done: true };
    default:
      if (subagentSessionId)
        return {
          childSession: {
            providerSessionId: subagentSessionId,
            toolUseId: eventToolUseId,
          },
        };
      return null;
  }
}

export interface CompactionNotification {
  kind: 'started' | 'completed';
  removedCount: number;
  summaryId?: string;
}

export function extractCompactionNotification(
  notification: Record<string, unknown>,
): CompactionNotification | null {
  const raw = extractNotification(notification);
  if (!raw || typeof raw !== 'object') return null;
  const note = raw as Record<string, unknown>;
  if (note.type === 'droid_working_state_changed' && note.newState === 'compacting_conversation')
    return { kind: 'started', removedCount: 0 };
  if (note.type === 'session_compacted') {
    const summaryId = typeof note.summaryId === 'string' ? note.summaryId : undefined;
    return {
      kind: 'completed',
      removedCount: Number(note.removedCount ?? 0) || 0,
      ...(summaryId ? { summaryId } : {}),
    };
  }
  return null;
}

export function normalizeNotification(
  appSessionId: string,
  sourceProviderSessionId: string,
  role: SessionRole,
  notification: Record<string, unknown>,
): NormalizedEvent[] {
  const raw = extractNotification(notification);
  const backgroundTaskProviderSessionId = backgroundTaskCompletionProviderSessionIdFrom(raw);
  if (backgroundTaskProviderSessionId)
    return [
      {
        childSession: {
          providerSessionId: backgroundTaskProviderSessionId,
          done: true,
        },
      },
    ];
  const skillActivation = skillActivationFromNotification(raw);
  if (skillActivation)
    return [
      {
        transcript: transcript(appSessionId, sourceProviderSessionId, role, 'text', {
          text: skillActivation.message,
        }),
      },
    ];
  const converted = convertNotificationToStreamMessage(raw);
  const messages = Array.isArray(converted) ? converted : converted ? [converted] : [];
  return messages
    .map((message) =>
      normalizeStreamEvent(
        appSessionId,
        sourceProviderSessionId,
        role,
        message as DroidStreamEvent,
      ),
    )
    .filter((event): event is NormalizedEvent => event !== null);
}

export function providerEventsFromNormalized(
  normalized: NormalizedEvent,
  base: ProviderRuntimeEventBase,
): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [];
  if (normalized.transcript) {
    const transcriptEvent = normalized.transcript;
    events.push({
      ...base,
      type: 'transcript',
      event: {
        role: transcriptEvent.role,
        kind: transcriptEvent.kind,
        ...(transcriptEvent.endTs === undefined ? {} : { endTs: transcriptEvent.endTs }),
        ...(transcriptEvent.text === undefined ? {} : { text: transcriptEvent.text }),
        ...(transcriptEvent.toolName === undefined ? {} : { toolName: transcriptEvent.toolName }),
        ...(transcriptEvent.toolArgs === undefined ? {} : { toolArgs: transcriptEvent.toolArgs }),
        ...(transcriptEvent.toolUseId === undefined
          ? {}
          : { toolUseId: transcriptEvent.toolUseId }),
        ...(transcriptEvent.isError === undefined ? {} : { isError: transcriptEvent.isError }),
        ...(transcriptEvent.removedCount === undefined
          ? {}
          : { removedCount: transcriptEvent.removedCount }),
        ...(transcriptEvent.author === undefined ? {} : { author: transcriptEvent.author }),
        ...(transcriptEvent.skills === undefined ? {} : { skills: transcriptEvent.skills }),
        ...(transcriptEvent.files === undefined ? {} : { files: transcriptEvent.files }),
        ...(transcriptEvent.browserRefs === undefined
          ? {}
          : { browserRefs: transcriptEvent.browserRefs }),
        ...(transcriptEvent.steered === undefined ? {} : { steered: transcriptEvent.steered }),
        ...(transcriptEvent.compactType === undefined
          ? {}
          : { compactType: transcriptEvent.compactType }),
      },
    });
  }
  if (normalized.tokens) {
    events.push({
      ...base,
      type: 'usage',
      inputTokens: normalized.tokens.tokensIn,
      outputTokens: normalized.tokens.tokensOut,
      ...(normalized.tokens.contextTokens === undefined
        ? {}
        : { contextTokens: normalized.tokens.contextTokens }),
    });
  }
  const observational = observationalEffect(normalized);
  if (observational) {
    events.push({ ...base, type: 'session.effect', effect: observational });
  }
  return events;
}

function observationalEffect(
  normalized: NormalizedEvent,
): Extract<ProviderRuntimeEvent, { type: 'session.effect' }>['effect'] | undefined {
  if (normalized.missionChild) {
    return {
      kind: 'observational_task',
      taskId: normalized.missionChild.providerSessionId,
      label: 'mission-worker',
      status: normalized.missionChild.event === 'completed' ? 'completed' : 'running',
    };
  }
  const child = normalized.childSession;
  if (!child?.providerSessionId) return undefined;
  return {
    kind: 'observational_task',
    taskId: child.providerSessionId,
    label: child.label ?? 'task',
    status: child.done ? 'completed' : 'running',
    ...(child.activity?.preview ? { preview: child.activity.preview } : {}),
  };
}

function skillActivationFromNotification(raw: unknown): SkillActivation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const notification = raw as Record<string, unknown>;
  if (notification.type !== 'create_message') return undefined;
  const message = notification.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user' || record.visibility !== 'user_only') return undefined;
  const content = record.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const text = (block as Record<string, unknown>).text;
  return typeof text === 'string' ? parseSkillActivation(text) : undefined;
}

function backgroundTaskCompletionProviderSessionIdFrom(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const notification = raw as Record<string, unknown>;
  if (notification.type !== 'create_message') return undefined;
  const message = notification.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  return backgroundTaskCompletionProviderSessionId(text);
}

function extractNotification(notification: Record<string, unknown>): unknown {
  const params =
    notification.params &&
    typeof notification.params === 'object' &&
    !Array.isArray(notification.params)
      ? (notification.params as Record<string, unknown>)
      : undefined;
  if (params && 'notification' in params) return params.notification;
  if ('notification' in notification) return notification.notification;
  return notification;
}
