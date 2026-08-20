import { useCallback, useEffect, useRef, useState } from 'react';
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

function mergeLabel(merging: boolean, merged: boolean): string {
  if (merged) return 'Merged';
  return merging ? 'Merging…' : 'Merge';
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeButtonTitle(
  blocked: string | null,
  merging: boolean,
  merged: boolean,
): string {
  if (merged) return 'Pull request merged';
  if (merging) return 'Merging pull request';
  return blocked ?? 'Merge this pull request';
}

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
  onMerge: (method: PrMergeMethod) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  // A merge lands before the refreshed pull request does, so the button stays
  // disabled on the merged pull request instead of offering a second merge
  // while the still-open data is on screen. Keyed by URL because a number
  // repeats across repositories.
  const [mergedKey, setMergedKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismissOnOutside(open, rootRef, close);

  const kind = pr ? prKind(pr) : null;
  // A merged or closed pull request has nothing left to merge.
  const blocked = pr ? mergeBlockReason(pr) : null;
  const prKey = pr ? pr.url || `#${String(pr.number)}` : null;
  const merged = prKey !== null && mergedKey === prKey;
  const disabled = merging || merged || blocked !== null;
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (!pr || kind === 'merged' || kind === 'closed' || prKey === null) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        disabled={disabled}
        title={mergeButtonTitle(blocked, merging, merged)}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex items-center gap-1.5 rounded-lg bg-[#238636] px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:bg-droid-elevated disabled:text-droid-text-muted"
      >
        <Octicon name="git-merge" size={13} />
        {mergeLabel(merging, merged)}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && !disabled ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-droid-border bg-droid-surface py-1 shadow-xl"
        >
          {METHODS.map((method) => (
            <button
              key={method.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onMerge(method.id).then((ok) => {
                  if (ok) setMergedKey(prKey);
                });
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
