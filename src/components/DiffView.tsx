import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { FileChange, DiffOp } from '../lib/diff';
import { displayPath } from '../lib/pathDisplay';
import { Expand, ToolPanel } from './transcript/primitives';

const ADD_FG = 'var(--diff-add-fg)';
const DEL_FG = 'var(--diff-del-fg)';

// Shared review-diff classes: row backgrounds follow the active diff palette,
// and the "focused" diff style adds its colored left-border accent, exactly as
// in the Review tab.
const ROW_TONE: Record<DiffOp['type'], string> = {
  add: 'review-diff-row review-diff-add',
  del: 'review-diff-row review-diff-del',
  ctx: 'review-diff-row',
};

export function DiffLines({ ops }: { ops: DiffOp[] }) {
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.65]">
      {/* Sized to the widest line so row tones cover the whole scroll range. */}
      <div className="review-diff-content">
        {ops.map((o, i) => (
          <div key={`${o.type}-${String(i)}`} className={`flex ${ROW_TONE[o.type]}`}>
            <span
              className="w-5 shrink-0 text-center select-none"
              style={{
                color:
                  o.type === 'add' ? ADD_FG : o.type === 'del' ? DEL_FG : 'var(--droid-text-muted)',
              }}
            >
              {o.type === 'add' ? '+' : o.type === 'del' ? '−' : ''}
            </span>
            <span className="whitespace-pre flex-1 px-1 text-droid-text-secondary">
              {o.text || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const VERB_LABEL: Record<FileChange['verb'], string> = {
  edit: 'Edit',
  create: 'Create',
  patch: 'Patch',
};

function DiffHeader({ change, cwd }: { change: FileChange; cwd?: string }) {
  const label = displayPath(change.path, cwd);
  return (
    <div className="flex items-center gap-2 px-3 h-9 border-b border-droid-border bg-droid-bg/40 shrink-0">
      <span className="text-[12px] font-medium text-droid-text-secondary shrink-0">
        {VERB_LABEL[change.verb]}
      </span>
      <span title={change.path} className="text-[12px] text-droid-text-muted truncate flex-1">
        {label}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: ADD_FG }}>
        +{change.added}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: DEL_FG }}>
        −{change.removed}
      </span>
    </div>
  );
}

export function DiffCard({
  change,
  cwd,
  onOpen,
}: {
  change: FileChange;
  cwd?: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const preview = change.ops.slice(0, 14);
  const more = change.ops.length - preview.length;
  const label = displayPath(change.path, cwd);

  return (
    <div>
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label={`Preview ${label}`}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="group flex shrink-0 items-center justify-center"
        >
          <ChevronRight
            className={`w-3 h-3 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <button
          type="button"
          aria-expanded={onOpen ? undefined : open}
          onClick={() => {
            if (onOpen) onOpen();
            else setOpen((value) => !value);
          }}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="shrink-0 text-[13px] font-medium text-droid-text-secondary">
            {VERB_LABEL[change.verb]}
          </span>
          <span title={change.path} className="min-w-0 truncate text-[12px] text-droid-text-muted">
            {label}
          </span>
          <span className="ml-auto text-[11px] tabular-nums shrink-0" style={{ color: ADD_FG }}>
            +{change.added}
          </span>
          <span className="text-[11px] tabular-nums shrink-0" style={{ color: DEL_FG }}>
            −{change.removed}
          </span>
        </button>
      </div>
      <Expand open={open}>
        {open ? (
          <ToolPanel className="mt-1.5">
            <div className="max-h-56 overflow-auto py-1">
              <DiffLines ops={preview} />
              {more > 0 && (
                <div className="border-t border-droid-border/60 px-3 py-1.5 text-[11px] text-droid-text-muted">
                  +{more} more lines
                </div>
              )}
            </div>
          </ToolPanel>
        ) : null}
      </Expand>
    </div>
  );
}

export function DiffFull({ change, cwd }: { change: FileChange; cwd?: string }) {
  return (
    <div className="flex flex-col h-full">
      <DiffHeader change={change} cwd={cwd} />
      <div className="flex-1 min-h-0 overflow-auto py-1">
        <DiffLines ops={change.ops} />
      </div>
    </div>
  );
}
