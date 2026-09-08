export interface SidecarShutdownStages {
  shutdownSessions: () => Promise<void>;
  shutdownAutomations: () => Promise<void>;
  disableMetrics: () => void;
  closeBridge: () => Promise<void>;
}

/** Attempts every owned cleanup stage and reports the first failure afterward. */
export async function shutdownSidecar(stages: SidecarShutdownStages): Promise<void> {
  let firstError: Error | undefined;
  const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  };

  await attempt(stages.shutdownSessions);
  await attempt(stages.shutdownAutomations);
  await attempt(stages.disableMetrics);
  await attempt(stages.closeBridge);

  if (firstError) throw firstError;
}
