import type { SessionSummary } from '../../types/bridge';

/** Persisted project IDs can outlive the renderer's current session window. */
export function projectSession(
  sessions: Partial<Record<string, SessionSummary>>,
  id: string | null | undefined,
): SessionSummary | undefined {
  return id ? sessions[id] : undefined;
}
