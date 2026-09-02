// What Backspace deletes when the draft is empty.
//
// Backspace works outward from the caret, the way it does in text. Skills and
// plugins sit on the caret's own line, so they go first, most recent first; the
// attachment row above goes after that, unwound from its right edge. Each press
// removes one whole thing.

export interface ComposerChips {
  visualizeSelected: boolean;
  pastedImageIds: readonly string[];
  pastedFileIds: readonly string[];
  imagePaths: readonly string[];
  skillFilePaths: readonly string[];
  documentPaths: readonly string[];
}

export type ChipRemoval =
  | { chip: 'attachment'; path: string }
  | { chip: 'skill'; filePath: string }
  | { chip: 'pastedImage'; id: string }
  | { chip: 'pastedFile'; id: string }
  | { chip: 'visualize' }
  | null;

export function chipRemovedByBackspace(chips: ComposerChips): ChipRemoval {
  const skill = chips.skillFilePaths.at(-1);
  if (skill !== undefined) return { chip: 'skill', filePath: skill };
  if (chips.visualizeSelected) return { chip: 'visualize' };
  const document = chips.documentPaths.at(-1);
  if (document !== undefined) return { chip: 'attachment', path: document };
  const image = chips.imagePaths.at(-1);
  if (image !== undefined) return { chip: 'attachment', path: image };
  const pastedFile = chips.pastedFileIds.at(-1);
  if (pastedFile !== undefined) return { chip: 'pastedFile', id: pastedFile };
  const pasted = chips.pastedImageIds.at(-1);
  if (pasted !== undefined) return { chip: 'pastedImage', id: pasted };
  return null;
}
