import { useCallback, useRef, useState } from 'react';
import { discardImage, isDesktop, saveImage } from '../lib/desktop';
import { blobToDataUrl, cropImage, processImage } from '../lib/imageFiles';
import type { CropRect, ImagePasteQuality } from '../lib/images';
import { toast } from '../lib/toast';

export interface AttachedImage {
  id: string;
  /** Absolute path in the temp attachments dir; this is what the prompt @-mentions. */
  path: string;
  /** Data URL of the saved (fidelity-processed) image, used for chips/viewer. */
  preview: string;
  /** Composer-intake order, shared with pasted files so mixed drops stay in order. */
  sequence: number;
}

/**
 * Bookkeeping for in-flight additions, kept out of React state so async
 * continuations can consult it after any number of awaits. `knownSettled` lets
 * the submit path wait for adds already in flight; `settled` waits until the
 * pending set is empty, including adds that start during the wait. The
 * generation stamp lets clear() invalidate adds that are still encoding, so
 * their late landing discards the saved file instead of reviving a chip on the
 * next prompt.
 */
export function createPendingAdditions() {
  let generation = 0;
  const pending = new Set<Promise<unknown>>();
  return {
    /** Stamps an addition when it starts; compare with isStale when it lands. */
    stamp: () => generation,
    isStale: (stamped: number) => stamped !== generation,
    invalidate: () => {
      generation += 1;
    },
    track: (task: Promise<unknown>) => {
      pending.add(task);
      const done = () => {
        pending.delete(task);
      };
      // then(onFulfilled, onRejected) so a failed encode can't reject the chain.
      void task.then(done, done);
    },
    /** Resolves once every tracked add — including ones started while awaiting — has finished. */
    settled: async (): Promise<void> => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    /** Waits only for adds already tracked; a paste that starts during submit stays for the next prompt. */
    knownSettled: async (): Promise<void> => {
      await Promise.allSettled([...pending]);
    },
  };
}

export type PendingAdditions = ReturnType<typeof createPendingAdditions>;

/**
 * Writes a fresh image file, then applies the clear() race guard shared by
 * adds and crops: if the composer was cleared while the file was being
 * written, the file would surface out of nowhere on a later prompt, so it is
 * deleted and the save is reported as void (null). The discard runs after the
 * save resolves because the file does not exist to delete before then.
 */
export async function saveImageUnlessStale(
  additions: PendingAdditions,
  stamp: number,
  save: () => Promise<string>,
  discard: (path: string) => Promise<void>,
): Promise<string | null> {
  const path = await save();
  if (!additions.isStale(stamp)) return path;
  void discard(path);
  return null;
}

/**
 * Appends an attachment in paste/drop order. Each add reserves a sequence
 * number before its variably slow encode, so completion order must not reorder
 * chips or the prompt's attachment list. Ids without a reserved sequence sort
 * last. Shared by the image and file attachment stores.
 */
export function insertBySequence<T extends { id: string }>(
  items: T[],
  item: T,
  sequences: ReadonlyMap<string, number>,
): T[] {
  const order = (entry: T) => sequences.get(entry.id) ?? Number.MAX_SAFE_INTEGER;
  return [...items, item].sort((a, b) => order(a) - order(b));
}

export function itemsBeforeCutoff<T extends { id: string }>(
  items: readonly T[],
  sequences: ReadonlyMap<string, number>,
  cutoff: number,
): T[] {
  return items.filter((item) => (sequences.get(item.id) ?? Number.MAX_SAFE_INTEGER) < cutoff);
}

export function pathsInSequence(items: readonly { path: string; sequence: number }[]): string[] {
  return [...items].sort((a, b) => a.sequence - b.sequence).map((item) => item.path);
}

/**
 * Owns the composer's image attachments. Pasted/dropped blobs are encoded per
 * the fidelity tier, written to disk via the desktop bridge, and tracked so a
 * crop can re-encode and swap the saved file in place.
 *
 * `imagesRef` mirrors the list so async continuations read the live list after
 * awaits instead of a stale render closure; every write goes through `commit`.
 * File deletion never happens inside a `setImages` updater: StrictMode double-
 * invokes updaters, which would fire discardImage twice per removal.
 */
export function useImageAttachments(quality: ImagePasteQuality) {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef(images);
  const sequencesRef = useRef(new Map<string, number>());
  const nextSeqRef = useRef(0);
  // Stable per-mount instance; not React state in the render sense.
  const [additions] = useState(() => createPendingAdditions());
  // Crops mutate an already-staged file. Submit must wait for them even when
  // they start during an in-flight add, or the snapshot keeps the old path
  // that applyCrop then deletes.
  const [crops] = useState(() => createPendingAdditions());

  // useCallback: commit and clear are referenced from PromptInput effects, so
  // they must keep a stable identity across renders.
  const commit = useCallback((next: AttachedImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const addBlob = (blob: Blob, sequence?: number) => {
    if (!isDesktop()) {
      toast.error('Image attachments need the desktop app');
      return;
    }
    // Reserve the chip's position synchronously: a paste whose encode runs
    // long must not overtake one that was added later but finished earlier.
    const seq = sequence ?? nextSeqRef.current;
    if (sequence === undefined || sequence >= nextSeqRef.current) nextSeqRef.current = seq + 1;
    const stamp = additions.stamp();
    const task = (async () => {
      try {
        const raw = await blobToDataUrl(blob);
        const processed = await processImage(raw, quality);
        const path = await saveImageUnlessStale(
          additions,
          stamp,
          () => saveImage(processed),
          discardImage,
        );
        // clear() ran during the encode (submit): the fresh file was deleted
        // rather than reviving a chip on the next prompt.
        if (path === null) return;
        const image = { id: crypto.randomUUID(), path, preview: processed, sequence: seq };
        sequencesRef.current.set(image.id, seq);
        commit(insertBySequence(imagesRef.current, image, sequencesRef.current));
      } catch {
        toast.error('Could not attach that image');
      }
    })();
    additions.track(task);
  };

  const remove = (id: string) => {
    const hit = imagesRef.current.find((i) => i.id === id);
    if (!hit) return;
    sequencesRef.current.delete(id);
    commit(imagesRef.current.filter((i) => i.id !== id));
    // Outside the state update so it fires exactly once per removal.
    void discardImage(hit.path);
  };

  // Errors propagate so the viewer can keep the crop UI open and report them.
  const applyCrop = async (id: string, rect: CropRect) => {
    const target = imagesRef.current.find((i) => i.id === id);
    if (!target) return;
    // Tracked as a mutation of an existing chip, not a new add: whenReady
    // waits for crops that start while an earlier encode is still in flight.
    const stamp = additions.stamp();
    const task = (async () => {
      const cropped = await cropImage(target.preview, rect, quality);
      // A clear() (submit) during the crop means the old path is now
      // referenced by a prompt; the new file is discarded, state left alone.
      const path = await saveImageUnlessStale(
        additions,
        stamp,
        () => saveImage(cropped),
        discardImage,
      );
      if (path === null) return;
      // The chip may have been removed while the crop was saving; discard the
      // new file instead of orphaning it in the temp dir.
      const existing = imagesRef.current.find((i) => i.id === id);
      if (!existing) {
        void discardImage(path);
        return;
      }
      commit(imagesRef.current.map((i) => (i.id === id ? { ...i, path, preview: cropped } : i)));
      // After the commit: exactly one deletion of the superseded file.
      void discardImage(existing.path);
    })();
    crops.track(task);
    await task;
  };

  // After a submit the saved files are referenced by the in-flight prompt, so
  // the chips clear but the temp files must stay until the OS reclaims them.
  // Stable identity (see commit): PromptInput's session-switch effect lists it
  // as a dependency.
  const clear = useCallback(() => {
    additions.invalidate();
    sequencesRef.current.clear();
    commit([]);
  }, [additions, commit]);

  // Non-submit clears (session switch, editing a queued prompt): no prompt
  // references the committed files, so delete them instead of orphaning them
  // until the daily sweep. In-flight adds still self-discard via the stamp.
  const clearAndDiscard = useCallback(() => {
    for (const image of imagesRef.current) void discardImage(image.path);
    clear();
  }, [clear]);

  /**
   * Submit-path support: wait only for adds already in flight at cutoff, then
   * wait for any crop of those attachments — including a crop that started
   * during the add wait — before snapshotting paths.
   */
  const whenReady = async (cutoff: number): Promise<AttachedImage[]> => {
    await additions.knownSettled();
    await crops.settled();
    return itemsBeforeCutoff(imagesRef.current, sequencesRef.current, cutoff);
  };

  const clearReady = (cutoff: number) => {
    const keep = imagesRef.current.filter(
      (image) => (sequencesRef.current.get(image.id) ?? Number.MAX_SAFE_INTEGER) >= cutoff,
    );
    for (const image of imagesRef.current) {
      if ((sequencesRef.current.get(image.id) ?? Number.MAX_SAFE_INTEGER) < cutoff) {
        sequencesRef.current.delete(image.id);
      }
    }
    commit(keep);
  };

  return { images, addBlob, remove, applyCrop, clear, clearAndDiscard, whenReady, clearReady };
}
