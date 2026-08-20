export function createComposerSeed(text: string, replace = false) {
  return { text, id: Date.now(), replace };
}

/**
 * Post-submit composer reset. Image chips always clear: the submit path
 * waited out every in-flight encode, so each made the prompt. The
 * text/file/skill draft resets only when the composer went untouched between
 * snapshot and send — anything typed or staged while images finished
 * encoding belongs to the next prompt and must not be wiped.
 */
export function resetComposerAfterSubmit(opts: {
  draftUntouched: boolean;
  clearImages: () => void;
  resetDraft: () => void;
}): void {
  opts.clearImages();
  if (opts.draftUntouched) opts.resetDraft();
}

export function composerTextAfterSeed(current: string, seed: string, replace: boolean): string {
  if (replace || !current.trim()) return seed;
  return `${current.trimEnd()}\n\n${seed}`;
}
