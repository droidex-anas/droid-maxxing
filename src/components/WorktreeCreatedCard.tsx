import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { WorktreeIcon } from './icons/WorktreeIcon';

export function WorktreeCreatedCard({ path }: { path: string }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="text-droid-text-muted">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        className="group flex items-center gap-2 text-left transition-colors hover:text-droid-text-secondary"
      >
        <WorktreeIcon className="h-4 w-4 shrink-0" />
        <span className="text-[13px] font-medium">Worktree created</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-droid-border bg-droid-elevated/35 px-4 py-3 font-mono text-[12px] leading-relaxed text-droid-text-secondary">
          <div>Preparing worktree (detached HEAD)</div>
          <div className="break-all">Worktree created at {path}</div>
        </div>
      )}
    </div>
  );
}
