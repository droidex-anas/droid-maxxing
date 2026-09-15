import { useEffect } from 'react';
import { openComposerCapture } from './composerDestination';
import { toast } from '../../lib/toast';
import './types';

export function CaptureShortcutHost(): null {
  useEffect(
    () =>
      window.droidCapture?.onShortcut(() => {
        try {
          openComposerCapture('desktop');
        } catch (error) {
          toast.info(
            error instanceof Error ? error.message : 'Open a chat to capture an attachment',
          );
        }
      }),
    [],
  );
  return null;
}
