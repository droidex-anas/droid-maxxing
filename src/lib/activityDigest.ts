import type { TranscriptEvent } from '../types/bridge';
import { toolMeta, type ToolCat } from './tools';

// A tiny summary of where a chat's conversation stands, derived from its
// transcript. It is what the Activity view needs to say "the model asked you
// something" or "editing Sidebar.tsx" without holding the transcript itself,
// and it is persisted so the signal survives a restart.
export interface ActivityDigest {
  // Newest timestamp the digest reflects; stale once the session moves past it.
  at: number;
  modelSpokeLast: boolean;
  // The model's last sentence, preferring a question.
  snippet: string;
  // What the model was doing when the transcript ends on a tool call.
  activity?: string;
}

const STORAGE_KEY = 'droid-activity-digest';
const MAX_ENTRIES = 200;
const SNIPPET_MAX = 90;

const VERB: Record<ToolCat, string> = {
  read: 'Reading',
  create: 'Creating',
  edit: 'Editing',
  exec: 'Running',
  search: 'Searching',
  web: 'Fetching',
  skill: 'Using skill',
  task: 'Delegating',
  subagent: 'Delegating',
  other: 'Working',
};

export function digestTranscript(events: readonly TranscriptEvent[]): ActivityDigest | null {
  if (events.length === 0) return null;
  let lastUser = -1;
  let lastModel = -1;
  for (let i = events.length - 1; i >= 0 && (lastUser < 0 || lastModel < 0); i -= 1) {
    const ev = events[i];
    if (ev.role !== 'primary') continue;
    if (ev.author === 'user') lastUser = Math.max(lastUser, i);
    else if (ev.kind === 'text' && ev.text?.trim()) lastModel = Math.max(lastModel, i);
  }
  const last = events[events.length - 1];
  return {
    at: Math.max(last.ts, last.endTs ?? 0),
    modelSpokeLast: lastModel > lastUser,
    snippet: lastSentence(lastModel >= 0 ? (events[lastModel].text ?? '') : ''),
    // Only a tool call at the very tail is still running.
    activity: last.kind === 'tool_call' && last.role === 'primary' ? describeTool(last) : undefined,
  };
}

function describeTool(ev: TranscriptEvent): string {
  const { cat, detail } = toolMeta(ev.toolName, ev.toolArgs);
  return `${VERB[cat]} ${detail.split('/').pop() ?? ''}`.trim();
}

// The last sentence of a message, preferring its last question, with markdown
// noise stripped so it reads well on one sidebar line.
export function lastSentence(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const sentences = plain.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [plain];
  const pick = [...sentences].reverse().find((s) => s.trim().endsWith('?')) ?? sentences.at(-1);
  return clip((pick ?? plain).trim());
}

function clip(text: string): string {
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > SNIPPET_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function loadActivityDigests(
  storage: Pick<Storage, 'getItem'>,
): Record<string, ActivityDigest> {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const digests: Record<string, ActivityDigest> = {};
    for (const [id, entry] of Object.entries(value)) {
      if (isDigest(entry)) digests[id] = entry;
    }
    return digests;
  } catch {
    return {};
  }
}

export function saveActivityDigests(
  storage: Pick<Storage, 'setItem'>,
  digests: Record<string, ActivityDigest>,
): void {
  const bounded = Object.entries(digests)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ENTRIES);
  storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(bounded)));
}

function isDigest(value: unknown): value is ActivityDigest {
  if (!value || typeof value !== 'object') return false;
  const { at, modelSpokeLast, snippet, activity } = value as Record<string, unknown>;
  return (
    typeof at === 'number' &&
    Number.isFinite(at) &&
    typeof modelSpokeLast === 'boolean' &&
    typeof snippet === 'string' &&
    (activity === undefined || typeof activity === 'string')
  );
}
