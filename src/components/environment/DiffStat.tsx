import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { ChangesIcon } from '../icons/ChangesIcon';
import { Popover } from './Popover';
import { RowCaret } from './primitives';
import { DIFF_MODES, diffModeLabel } from '../../lib/git';
import type { DiffStatMode, GitDiffStat } from '../../types/vcs';

const ADD_COLOR = 'var(--diff-add-fg)';
const DEL_COLOR = 'var(--diff-del-fg)';

// What the meter sums, phrased as a quiet qualifier next to "Changes"; the
// popover keeps the full mode labels. The default worktree scope gets no
// qualifier — the bare label already means it.
function modeQualifier(mode: DiffStatMode, baseRef?: string | null): string {
  if (mode === 'branch') return baseRef ? `vs ${baseRef}` : 'vs origin/main';
  if (mode === 'uncommitted') return 'uncommitted';
  return '';
}

// The "changes summed up" row. The main button opens the full Review tab; a
// trailing caret switches what the meter sums (worktree / branch / uncommitted).
export function DiffStat({
  stat,
  mode,
  baseRef,
  onModeChange,
  onOpenReview,
}: {
  stat: GitDiffStat | null;
  mode: DiffStatMode;
  baseRef?: string | null;
  onModeChange: (mode: DiffStatMode) => void;
  onOpenReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  // The label switches modes instantly, but `stat` lags until the async refetch
  // resolves. Only trust the counts once they belong to the selected mode.
  const ready = !!stat && stat.mode === mode;
  const additions = stat?.additions ?? 0;
  const deletions = stat?.deletions ?? 0;
  const files = stat?.files ?? 0;
  // Renames, binary edits, and empty-file adds change files without a line
  // delta, so a zero +/- doesn't mean clean — fall back to the file count.
  const clean = files === 0 && additions === 0 && deletions === 0;
  const noLineDelta = additions === 0 && deletions === 0;

  return (
    <>
      <div
        ref={anchorRef}
        className={`group flex items-center rounded-lg transition-colors ${
          open ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <button
          type="button"
          onClick={onOpenReview}
          title="Open the full diff review"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-3 py-2 text-left"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
            <ChangesIcon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text">
            Changes
            {modeQualifier(mode, baseRef) !== '' && (
              <span className="text-[11px] text-droid-text-muted">
                {' '}
                {modeQualifier(mode, baseRef)}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums">
            {!ready ? (
              <span className="text-droid-text-muted/60">…</span>
            ) : clean ? (
              <span className="text-droid-text-muted">Clean</span>
            ) : noLineDelta ? (
              <span className="text-droid-text-secondary">
                {files.toLocaleString()} file{files === 1 ? '' : 's'}
              </span>
            ) : (
              <>
                <span style={{ color: ADD_COLOR }}>+{additions.toLocaleString()}</span>{' '}
                <span style={{ color: DEL_COLOR }}>-{deletions.toLocaleString()}</span>
              </>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); }}
          title="Choose which changes are counted"
          aria-haspopup="menu"
          aria-expanded={open}
          className="shrink-0 rounded-r-lg px-1.5 py-2 text-droid-text-muted/60 hover:text-droid-text"
        >
          <RowCaret open={open} />
        </button>
      </div>

      <Popover
        open={open}
        onClose={() => { setOpen(false); }}
        anchorRef={anchorRef}
        label="Diff mode"
        align="right"
        width={224}
      >
        <div className="p-1.5">
          {DIFF_MODES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onModeChange(option);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
            >
              <span className="flex-1 truncate">{diffModeLabel(option, baseRef)}</span>
              {option === mode && (
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
              )}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
