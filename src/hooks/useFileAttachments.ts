import { useCallback, useRef, useState } from 'react';
import { discardImage, isDesktop, saveAttachment } from '../lib/desktop';
import { blobToDataUrl } from '../lib/imageFiles';
import { toast } from '../lib/toast';
import {
  createPendingAdditions,
  insertBySequence,
  saveImageUnlessStale,
} from './useImageAttachments';

export interface AttachedFile {
  id: string;
  /** Absolute path in the temp attachments dir; this is what the prompt @-mentions. */
  path: string;
  /** The pasted file's original name, for the chip label. */
  name: string;
}

// Mirrors MAX_ATTACHMENT_BYTES in electron/attachments.cjs: checked locally so
// an oversized blob is refused before its base64 payload crosses the bridge.
// Files that exist on disk are attached by reference instead and never hit
// this cap, so it only governs clipboard snapshots.
const MAX_PASTED_FILE_BYTES = 40 * 1024 * 1024;

/**
 * Owns the composer's pasted non-image attachments: PDFs, documents, videos,
 * and any other blob with no path on disk. Files that do have a path are
 * attached by reference through the picker's plain path list instead, so this
 * store only ever holds temp copies it may delete. Lifecycle (sequence-ordered
 * adds, stale-save discard, submit settle) is shared with the image store.
 */
export function useFileAttachments() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const filesRef = useRef(files);
  const sequencesRef = useRef(new Map<string, number>());
  const nextSeqRef = useRef(0);
  const [additions] = useState(() => createPendingAdditions());

  const commit = useCallback((next: AttachedFile[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const addBlob = (file: File) => {
    if (!isDesktop()) {
      toast.error('File attachments need the desktop app');
      return;
    }
    if (file.size > MAX_PASTED_FILE_BYTES) {
      toast.error('That file is too large to paste. Drop it onto the composer instead.');
      return;
    }
    const seq = nextSeqRef.current++;
    const stamp = additions.stamp();
    const task = (async () => {
      try {
        const dataUrl = await blobToDataUrl(file);
        const path = await saveImageUnlessStale(
          additions,
          stamp,
          () => saveAttachment(file.name, dataUrl),
          discardImage,
        );
        if (path === null) return; // cleared while encoding; fresh file deleted
        const attached = { id: crypto.randomUUID(), path, name: file.name };
        sequencesRef.current.set(attached.id, seq);
        commit(insertBySequence(filesRef.current, attached, sequencesRef.current));
      } catch (error) {
        toast.error(
          error instanceof Error && error.message.includes('size limit')
            ? 'That file is too large to paste. Drop it onto the composer instead.'
            : 'Could not attach that file',
        );
      }
    })();
    additions.track(task);
  };

  const remove = (id: string) => {
    const hit = filesRef.current.find((f) => f.id === id);
    if (!hit) return;
    sequencesRef.current.delete(id);
    commit(filesRef.current.filter((f) => f.id !== id));
    void discardImage(hit.path);
  };

  // Submit path: chips clear but the temp files stay, referenced by the prompt.
  const clear = useCallback(() => {
    additions.invalidate();
    sequencesRef.current.clear();
    commit([]);
  }, [additions, commit]);

  // Non-submit clears: no prompt references the files, so delete them.
  const clearAndDiscard = useCallback(() => {
    for (const file of filesRef.current) void discardImage(file.path);
    clear();
  }, [clear]);

  const whenSettled = async (): Promise<AttachedFile[]> => {
    await additions.settled();
    return filesRef.current;
  };

  return { files, addBlob, remove, clear, clearAndDiscard, whenSettled };
}
