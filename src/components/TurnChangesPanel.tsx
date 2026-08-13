import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { FileChange } from '../lib/diff';

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

function displayTurnEditPath(path: string, cwd?: string): string {
  const normalizedPath = path.replace(/\\/g, '/');
  if (!cwd) return normalizedPath;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedPath === root) return normalizedPath;
  if (normalizedPath.startsWith(`${root}/`)) return normalizedPath.slice(root.length + 1);
  return normalizedPath;
}

function ChangeCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {added > 0 && <span style={{ color: 'var(--diff-add-fg)' }}>+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span style={{ color: 'var(--diff-del-fg)' }}>−{removed}</span>}
    </span>
  );
}

function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
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
            const display = displayTurnEditPath(file.path, cwd);
            const slash = display.lastIndexOf('/');
            const directory = slash >= 0 ? display.slice(0, slash) : '';
            const name = slash >= 0 ? display.slice(slash + 1) : display;
            return (
              <button
                key={file.path}
                onClick={() => onOpenFile?.(file.path)}
                disabled={!onOpenFile}
                title={file.path}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors enabled:hover:bg-droid-elevated/40 disabled:cursor-default"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  <span className="text-droid-text-secondary">{name}</span>
                  {directory && (
                    <span className="ml-2 text-[11px] text-droid-text-muted/60">{directory}</span>
                  )}
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
