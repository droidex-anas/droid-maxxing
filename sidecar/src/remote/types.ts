import type { ClientCommand, ReasoningEffort } from '../protocol.js';

export interface RemoteModel {
  id: string;
  name: string;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export interface RemoteSelection {
  modelId: string;
  effort?: ReasoningEffort;
  mode: 'auto' | 'spec';
}

export interface RemoteMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps: string[];
}

export interface RemoteChange {
  path: string;
  lines: { kind: 'context' | 'addition' | 'deletion'; text: string }[];
}

export interface RemoteApproval {
  id: string;
  title: string;
  detail: string;
}

export interface RemoteQuestion {
  id: string;
  questions: { index: number; question: string; options: string[] }[];
}

export interface RemoteSession extends RemoteSelection {
  id: string;
  runId: string;
  revision: number;
  title: string;
  workspace: string;
  phase: 'running' | 'approval' | 'question' | 'completed' | 'stopped' | 'failed';
  messages: RemoteMessage[];
  changes: RemoteChange[];
  diffNote: string;
  approval?: RemoteApproval;
  question?: RemoteQuestion;
  error?: string;
  updatedAt: number;
}

export type RemoteEvent =
  | { type: 'snapshot'; sessions: RemoteSession[] }
  | { type: 'session'; session: RemoteSession }
  | { type: 'removed'; id: string }
  | { type: 'catalog'; models: RemoteModel[] }
  | { type: 'heartbeat' };

export interface RemoteRuntime {
  handle(command: ClientCommand): Promise<void>;
}

export class RemoteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteError(400, 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, maximum = 8_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new RemoteError(400, `${name} must contain between 1 and ${maximum} characters.`);
  }
  return value.trim();
}

export function uuid(value: unknown): string {
  const id = text(value, 'Session ID', 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new RemoteError(400, 'Expected a UUID v4.');
  }
  return id;
}
