import { useEffect, useMemo, useState } from 'react';
import type { TranscriptEvent } from '../../types/bridge';
import type { ToolActivityDensity } from '../../lib/toolActivity';
import {
  MAX_DIFF_CARDS_PER_COMMIT,
  createDiffDisclosure,
  mountNextRevealedDiffCards,
  reopenDiffDisclosure,
  revealNextDiffCards,
  type FileChange,
} from '../../lib/diff';
import { pathFileName } from '../../lib/pathDisplay';
import { formatDuration } from '../../lib/tools';
import type { FeedItem } from '../chatFeed';
import { DiffCard } from '../DiffView';
import { Caret, Expand } from './primitives';
import { renderToolEvents, summarizeTools } from './rows';

/* ── One run of tool calls at the configured density. Compact folds the run to
   a single aggregate line ("Explored 4 files, 1 search") that expands to the
   per-tool lines; balanced shows one line per tool, each expanding to its body;
   detailed renders the bodies inline. ── */
export function ToolGroupItem({
  events,
  active = false,
  density = 'balanced',
}: {
  events: TranscriptEvent[];
  active?: boolean;
  density?: ToolActivityDensity;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeTools(events), [events]);
  if (density !== 'compact') {
    return (
      <div className="space-y-2.5">{renderToolEvents(events, active, density === 'detailed')}</div>
    );
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex items-center gap-1.5 text-left"
      >
        <Caret open={open} />
        {active ? (
          <span className="shimmer-text text-[13px] font-medium">{summary}</span>
        ) : (
          <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">
            {summary}
          </span>
        )}
      </button>
      <Expand open={open}>
        <div className="mt-2 pl-[18px] space-y-2.5">{renderToolEvents(events, active, false)}</div>
      </Expand>
    </div>
  );
}

/* ── Worked-for group: a completed turn's steps folded into one disclosure.
   Pure shell — the parent renders each child feed item so this module does not
   depend on the row dispatcher. The header stays a bare "Worked for 12s"; the
   turn's detail belongs inside the fold, rendered at the configured density. ── */
export function WorkedGroup({
  item,
  children,
}: {
  item: Extract<FeedItem, { type: 'worked' }>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex min-w-0 items-center gap-1.5 text-left"
      >
        <Caret open={open} />
        <span className="shrink-0 text-[13px] text-droid-text-secondary">
          {item.durationMs >= 1000 ? `Worked for ${formatDuration(item.durationMs)}` : 'Worked'}
        </span>
      </button>
      <Expand open={open}>
        <div className="mt-3 space-y-4 border-l border-droid-border pl-4">{children}</div>
      </Expand>
    </div>
  );
}

/* ── Folded run of file edits: one collapsible header over individual diffs.
   `inlineDiffs` (the "Show inline code diffs" setting) is the default open
   state; a manual toggle wins over the setting for that row. ── */
export function DiffGroup({
  changes,
  onOpenDiff,
  inlineDiffs = true,
}: {
  changes: { event: TranscriptEvent; change: FileChange }[];
  onOpenDiff?: (c: FileChange) => void;
  inlineDiffs?: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? inlineDiffs;
  const [disclosure, setDisclosure] = useState(() => createDiffDisclosure(changes.length));
  const added = changes.reduce((s, c) => s + c.change.added, 0);
  const removed = changes.reduce((s, c) => s + c.change.removed, 0);
  const files = new Set(changes.map((c) => c.change.path));
  const edits = `${String(changes.length)} ${changes.length === 1 ? 'edit' : 'edits'}`;
  const label =
    files.size <= 1
      ? `Edited ${pathFileName(changes[0].change.path)} · ${edits}`
      : `Edited ${String(files.size)} files · ${edits}`;
  // Mount bounded chunks so neither opening nor disclosing a genuinely huge
  // edit run creates one long renderer commit. No diff content is discarded.
  const shown = changes.slice(0, disclosure.mountedCount);
  const hiddenCount = changes.length - shown.length;
  const revealCount = Math.min(MAX_DIFF_CARDS_PER_COMMIT, hiddenCount);
  const canRevealMore = hiddenCount > 0 && disclosure.mountedCount >= disclosure.revealedCount;

  useEffect(() => {
    if (!open || disclosure.mountedCount >= disclosure.revealedCount) return;
    const frame = requestAnimationFrame(() => {
      setDisclosure((current) => mountNextRevealedDiffCards(current, changes.length));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [changes.length, disclosure.mountedCount, disclosure.revealedCount, open]);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setDisclosure((current) => reopenDiffDisclosure(current, changes.length));
          }
          setOverride(!open);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <Caret open={open} />
        <span className="min-w-0 truncate text-[13px] font-medium text-droid-text-muted group-hover:text-droid-text-secondary">
          {label}
        </span>
        <span
          className="ml-auto text-[11px] tabular-nums shrink-0"
          style={{ color: 'var(--diff-add-fg)' }}
        >
          +{added}
        </span>
        <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--diff-del-fg)' }}>
          −{removed}
        </span>
      </button>
      <Expand open={open}>
        <div className="mt-2 space-y-2 border-l border-droid-border pl-3">
          {shown.map((c) => (
            <DiffCard
              key={c.event.id}
              change={c.change}
              onOpen={
                onOpenDiff
                  ? () => {
                      onOpenDiff(c.change);
                    }
                  : undefined
              }
            />
          ))}
          {canRevealMore && (
            <button
              type="button"
              onClick={() => {
                setDisclosure((current) => revealNextDiffCards(current, changes.length));
              }}
              className="text-[11px] text-droid-text-muted/70 transition-colors hover:text-droid-text-secondary"
            >
              Show next {revealCount} {revealCount === 1 ? 'edit' : 'edits'} ({hiddenCount}{' '}
              remaining)
            </button>
          )}
        </div>
      </Expand>
    </div>
  );
}
