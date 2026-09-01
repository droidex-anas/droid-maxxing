import { isAutonomy, isReasoningEffort, trimmedOrNull } from './automationInput.js';
import type { AutomationAutonomy, AutomationReasoningEffort } from './types.js';

export interface AutomationSessionContext {
  cwd: string | null;
  modelId: string | null;
  reasoningEffort: AutomationReasoningEffort | null;
  autonomy: AutomationAutonomy;
}

interface ObservedSession {
  appSessionId: string;
  cwd?: string;
  modelId?: string;
  reasoningEffort?: unknown;
  autonomy?: unknown;
}

const MAX_SESSIONS = 100;

/**
 * The settings a proposal inherits from the chat that asked for it, observed
 * from bridge events. Bounded so long-lived sidecars cannot grow unbounded;
 * eviction is safe because SessionManager remains the authoritative source.
 */
export class SessionContextCache {
  private readonly contexts = new Map<string, AutomationSessionContext>();

  /** Merges a session update, keeping fields the event did not report. */
  observe(session: ObservedSession): void {
    const previous = this.contexts.get(session.appSessionId);
    const next: AutomationSessionContext = {
      cwd: trimmedOrNull(session.cwd) ?? previous?.cwd ?? null,
      modelId: trimmedOrNull(session.modelId) ?? previous?.modelId ?? null,
      reasoningEffort:
        (isReasoningEffort(session.reasoningEffort) ? session.reasoningEffort : null) ??
        previous?.reasoningEffort ??
        null,
      autonomy: isAutonomy(session.autonomy) ? session.autonomy : (previous?.autonomy ?? 'low'),
    };
    this.contexts.delete(session.appSessionId);
    this.contexts.set(session.appSessionId, next);
    while (this.contexts.size > MAX_SESSIONS) {
      const oldest = this.contexts.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.contexts.delete(oldest);
    }
  }

  get(appSessionId: string): AutomationSessionContext | undefined {
    return this.contexts.get(appSessionId);
  }

  clear(): void {
    this.contexts.clear();
  }
}

/**
 * SessionManager is authoritative when it can still answer for a session; the
 * observed event fields fill in whatever it no longer knows.
 */
export function mergeSessionContext(
  observed: AutomationSessionContext | undefined,
  resolved: AutomationSessionContext | null,
): AutomationSessionContext | null {
  if (!observed && !resolved) return null;
  return {
    cwd: resolved?.cwd ?? observed?.cwd ?? null,
    modelId: resolved?.modelId ?? observed?.modelId ?? null,
    reasoningEffort: resolved?.reasoningEffort ?? observed?.reasoningEffort ?? null,
    autonomy: resolved?.autonomy ?? observed?.autonomy ?? 'low',
  };
}
