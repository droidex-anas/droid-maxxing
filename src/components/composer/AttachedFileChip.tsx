import { FileText, X } from 'lucide-react';
import { pathBaseName } from '../../lib/localImage';

// Named, removable chip for an attachment the composer cannot preview: a
// document, or an image reference with no displayable source (a relative path
// has no single root to resolve against). Dropping such a chip silently would
// leave the prompt carrying a mention the user can no longer see or remove.
export function AttachedFileChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = pathBaseName(path);
  return (
    <span
      className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-[11px] bg-droid-bg/60 text-droid-text-secondary border border-droid-border"
      title={path}
    >
      <FileText className="w-3 h-3 text-droid-text-muted" />
      {name.length > 0 ? name : path}
      <button
        onClick={onRemove}
        className="p-0.5 rounded hover:bg-black/20 transition-colors"
        title="Remove file"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}
