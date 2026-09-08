import { useAutomationSnapshot } from './client';

export function AutomationSessionBadge({ appSessionId }: { appSessionId: string }) {
  const snapshot = useAutomationSnapshot();
  const origin = snapshot.sessionOrigins[appSessionId];
  if (!origin) return null;
  const status = snapshot.runs.find((run) => run.id === origin.runId)?.status;
  return (
    <span
      role="img"
      aria-label={`Started by automation: ${origin.automationTitle}${
        status ? `, run ${status}` : ''
      }`}
      title={`Automation: ${origin.automationTitle}${status ? ` · ${status}` : ''}`}
      className={`h-2.5 w-2.5 shrink-0 rounded-full border border-droid-text-muted ${
        status === 'running' || status === 'starting'
          ? 'motion-safe:animate-pulse border-droid-text-secondary'
          : ''
      }`}
    />
  );
}
