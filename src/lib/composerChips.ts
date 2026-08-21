// Which chip Backspace deletes when the draft is empty.
//
// The chip row renders Visualize, pasted images, image attachments, skills, then
// documents, so unwinding it in reverse means Backspace always removes the chip
// nearest the caret, and a skill or plugin leaves in a single press.

export interface ComposerChips {
  visualizeSelected: boolean;
  pastedImageIds: readonly string[];
  imagePaths: readonly string[];
  skillFilePaths: readonly string[];
  documentPaths: readonly string[];
}

export type ChipRemoval =
  | { chip: 'attachment'; path: string }
  | { chip: 'skill'; filePath: string }
  | { chip: 'pastedImage'; id: string }
  | { chip: 'visualize' }
  | null;

export function chipRemovedByBackspace(chips: ComposerChips): ChipRemoval {
  const document = chips.documentPaths.at(-1);
  if (document !== undefined) return { chip: 'attachment', path: document };
  const skill = chips.skillFilePaths.at(-1);
  if (skill !== undefined) return { chip: 'skill', filePath: skill };
  const image = chips.imagePaths.at(-1);
  if (image !== undefined) return { chip: 'attachment', path: image };
  const pasted = chips.pastedImageIds.at(-1);
  if (pasted !== undefined) return { chip: 'pastedImage', id: pasted };
  return chips.visualizeSelected ? { chip: 'visualize' } : null;
}
