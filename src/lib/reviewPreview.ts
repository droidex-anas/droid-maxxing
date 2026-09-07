import { authorizeFilesRoot, readFilePreview } from './desktop';
import { relativeWorkspaceFilePath } from './pathDisplay';

type PreviewResult = { content: string } | { error: string };

// One detached preview owns the in-flight authorization/read. Cancellation is
// synchronous so Close or a git-file selection invalidates it before React's
// next commit, including while a native workspace permission dialog is open.
export function createReviewPreviewRequest({
  authorizeRoot = authorizeFilesRoot,
  readPreview = readFilePreview,
} = {}) {
  let generation = 0;
  return {
    cancel() {
      generation += 1;
    },
    async load(cwd: string, path: string, onResult: (result: PreviewResult) => void) {
      const request = ++generation;
      try {
        const relative = relativeWorkspaceFilePath(path, cwd);
        const accessToken = await authorizeRoot(cwd);
        if (request !== generation) return;
        const preview = await readPreview(accessToken, relative);
        if (request !== generation) return;
        if (preview.category !== 'text' || preview.text === undefined) {
          throw new Error('This file has no text preview. Open it from Files.');
        }
        onResult({ content: preview.text });
      } catch (error) {
        if (request !== generation) return;
        onResult({
          error: error instanceof Error ? error.message : 'Could not preview this file.',
        });
      }
    },
  };
}
