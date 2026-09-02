import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  X,
  type LucideIcon,
} from 'lucide-react';
import { attachmentDisplayName, fileKindInfo, type FileKind } from '../../lib/fileKind';

const ICON_BY_KIND: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileText,
  data: FileJson,
  code: FileCode,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  file: File,
};

// Icon-tile hues per type family, kept theme-aware through the droid palette.
const TILE_BY_KIND: Record<FileKind, string> = {
  pdf: 'bg-red-500/15 text-red-400',
  document: 'bg-sky-500/15 text-sky-400',
  spreadsheet: 'bg-emerald-500/15 text-emerald-400',
  presentation: 'bg-amber-500/15 text-amber-400',
  text: 'bg-sky-500/15 text-sky-400',
  data: 'bg-violet-500/15 text-violet-400',
  code: 'bg-violet-500/15 text-violet-400',
  image: 'bg-teal-500/15 text-teal-400',
  video: 'bg-rose-500/15 text-rose-400',
  audio: 'bg-orange-500/15 text-orange-400',
  archive: 'bg-droid-text-muted/10 text-droid-text-muted',
  file: 'bg-droid-text-muted/10 text-droid-text-muted',
};

/**
 * Card-style chip for a file the composer cannot thumbnail: an icon tile
 * colored by type family, the file name, and a type subtitle, with a remove
 * badge in the composer (onRemove) and read-only in the transcript. `name`
 * carries the pasted file's original name; path-only attachments fall back to
 * the basename, with the temp-store prefix stripped for restored chips.
 */
export function FileChip({
  path,
  name,
  onRemove,
}: {
  path: string;
  name?: string;
  onRemove?: () => void;
}) {
  const displayName = name !== undefined && name.length > 0 ? name : attachmentDisplayName(path);
  const info = fileKindInfo(displayName);
  const Icon = ICON_BY_KIND[info.kind];
  return (
    <span
      className="group relative flex max-w-60 items-center gap-2.5 rounded-xl border border-droid-border bg-droid-bg/60 py-2 pl-2 pr-2.5"
      title={path}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TILE_BY_KIND[info.kind]}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12px] font-medium text-droid-text">
          {displayName}
        </span>
        <span className="block text-[10px] text-droid-text-muted">{info.label}</span>
      </span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-droid-border bg-droid-elevated text-droid-text-muted shadow-sm transition-colors hover:border-droid-border-hover hover:text-droid-text"
          title="Remove file"
        >
          <X className="h-2.5 w-2.5" strokeWidth={3} />
        </button>
      )}
    </span>
  );
}
