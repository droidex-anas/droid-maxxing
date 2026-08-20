import { useCallback, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Octicon } from '../../../components/environment/GithubIcons';
import { prKind } from '../../../lib/github';
import type { PrMergeMethod, PullRequest } from '../../../types/vcs';
import { useDismissOnOutside } from '../hooks/useDismissOnOutside';
import { mergeBlockReason } from '../lib/prMeta';

const METHODS: { id: PrMergeMethod; label: string; hint: string }[] = [
  { id: 'merge', label: 'Create a merge commit', hint: 'Keeps every commit and adds a merge' },
  { id: 'squash', label: 'Squash and merge', hint: 'Combines the commits into one' },
  { id: 'rebase', label: 'Rebase and merge', hint: 'Replays the commits onto the base' },
];

// Merging happens through `gh pr merge`, so the strategy is picked explicitly:
// the button opens the list and the chosen entry performs the merge. There is no
// separate confirmation because choosing a strategy already states the intent.
export function PrMergeButton({
  pr,
  merging,
  onMerge,
}: {
  pr: PullRequest | null;
  merging: boolean;
  onMerge: (method: PrMergeMethod) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismissOnOutside(open, rootRef, close);

  if (!pr) return null;
  const kind = prKind(pr);
  // A merged or closed pull request has nothing left to merge.
  if (kind === 'merged' || kind === 'closed') return null;
  const blocked = mergeBlockReason(pr);
  const disabled = merging || blocked !== null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled}
        title={blocked ?? 'Merge this pull request'}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex items-center gap-1.5 rounded-lg bg-[#238636] px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:bg-droid-elevated disabled:text-droid-text-muted"
      >
        <Octicon name="git-merge" size={13} />
        {merging ? 'Merging…' : 'Merge'}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-droid-border bg-droid-surface py-1 shadow-xl">
          {METHODS.map((method) => (
            <button
              key={method.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onMerge(method.id);
              }}
              className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-droid-active"
            >
              <span className="block text-[13px] text-droid-text">{method.label}</span>
              <span className="block text-[11.5px] text-droid-text-muted">{method.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
