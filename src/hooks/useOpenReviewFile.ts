import { useCallback } from 'react';

import type { FileChange } from '../lib/diff';
import { openReviewAt, type OpenReviewFileHandler } from '../lib/reviewFocus';
import { useStoreDispatch } from './useStore';

export function useOpenReviewFile(): {
  openReviewFile: OpenReviewFileHandler;
  openDiff: (change: FileChange) => void;
} {
  const dispatch = useStoreDispatch();
  const openReviewFile = useCallback<OpenReviewFileHandler>(
    (path, change) => {
      dispatch(openReviewAt(path, change));
    },
    [dispatch],
  );
  const openDiff = useCallback(
    (change: FileChange) => {
      openReviewFile(change.path, change);
    },
    [openReviewFile],
  );
  return { openReviewFile, openDiff };
}
