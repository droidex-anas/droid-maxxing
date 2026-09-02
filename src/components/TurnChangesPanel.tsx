import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import type { FileChange } from '../lib/diff';
import { displayPath, pathFileName } from '../lib/pathDisplay';
import { Expand } from './transcript/primitives';

export interface TurnFile {
  path: string;
  added: number;
  removed: number;
  verb: FileChange['verb'];
}

export interface TurnChangesItem {
  type: 'turnChanges';
  key: string;
  tailEventId: string;
  files: TurnFile[];
  added: number;
  removed: number;
}

function ChangeCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="shrink-0 tabular-nums text-[11px]">
      {added > 0 && <span style={{ color: 'var(--diff-add-fg)' }}>+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span style={{ color: 'var(--diff-del-fg)' }}>−{removed}</span>}
    </span>
  );
}

export default function TurnChangesPanel({
  item,
  cwd,
  onOpenFile,
}: {
  item: TurnChangesItem;
  cwd?: string;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const { files, added, removed } = item;
  return (
    <div className="overflow-hidden rounded-xl border border-droid-border bg-droid-surface">
      <button
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-droid-elevated/40"
        aria-expanded={open}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ${
            open ? 'rotate-90' : ''
          }`}
        />
        <span className="text-[12.5px] font-medium text-droid-text-secondary">Changes</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="text-[11px] text-droid-text-muted">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <ChangeCount added={added} removed={removed} />
        </span>
      </button>
      <Expand open={open}>
        <div className="border-t border-droid-border">
          {files.map((file) => {
            const display = displayPath(file.path, cwd);
            const name = pathFileName(display);
            return (
              <button
                key={file.path}
                onClick={() => onOpenFile?.(file.path)}
                disabled={!onOpenFile}
                title={file.path}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors enabled:hover:bg-droid-elevated/40 disabled:cursor-default"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {name}
                </span>
                <ChangeCount added={file.added} removed={file.removed} />
              </button>
            );
          })}
        </div>
      </Expand>
    </div>
  );
}
