/**
 * Primary send commit: echo and clear the composer before the git baseline,
 * then send only after the baseline lands so the agent cannot race the diff.
 * Child sends keep the wait-then-revalidate path in `commitChildPromptAfterBaseline`.
 */
export async function commitPrimaryPromptAfterBaseline({
  waitForBaseline,
  canCommit = () => true,
  appendTranscript,
  resetComposer,
  sendCommand,
}: {
  waitForBaseline: () => Promise<void>;
  canCommit?: () => boolean;
  appendTranscript: () => void;
  resetComposer: () => void;
  sendCommand: () => void;
}): Promise<boolean> {
  appendTranscript();
  resetComposer();
  await waitForBaseline();
  if (!canCommit()) return false;
  sendCommand();
  return true;
}
