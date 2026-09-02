import { useCallback } from 'react';

// Drop handlers for the composer wrapper. Chromium navigates the window to a
// dropped file, which would destroy the app state, so file drops are always
// swallowed; the files themselves are handed to the composer, which routes
// images to the image store and everything else to file attachments. Non-file
// drags (queue reorder) pass through untouched.
export function useComposerFileDrop(addFiles: (files: File[]) => void) {
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  return { onDragOver, onDrop };
}
