import { useCallback, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Octicon } from '../../../components/environment/GithubIcons';
import { prKind } from '../../../lib/github';
import { openExternal } from '../../../lib/onboarding';
import type { PullRequest } from '../../../types/vcs';
import { useDismissOnOutside } from '../hooks/useDismissOnOutside';
import {
  CUBIC_INVITE_URL,
  prReviewOptions,
  type PrReviewAction,
  type PrReviewOption,
} from '../lib/prReview';

// Review is the DROIDEX concept; Cubic and the local Droid agent are providers
// under it. Cubic cannot be installed from here, so a repository it has never
// reviewed gets an invitation instead of a trigger.
export function PrReviewButton({
  pr,
  cubicInstalled,
  requesting,
  onRunCubicReview,
  onReviewWithDroid,
}: {
  pr: PullRequest | null;
  cubicInstalled: boolean;
  requesting: boolean;
  onRunCubicReview: () => void;
  onReviewWithDroid: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismissOnOutside(open, rootRef, close);

  if (!pr) return null;
  const options = prReviewOptions({ cubicInstalled, kind: prKind(pr) });
  const run = (action: PrReviewAction) => {
    setOpen(false);
    if (action === 'enable-cubic') void openExternal(CUBIC_INVITE_URL);
    if (action === 'run-cubic') onRunCubicReview();
    if (action === 'droid') onReviewWithDroid();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Review this pull request"
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-droid-border px-2.5 py-1.5 text-[12.5px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
      >
        <Octicon name="check" size={13} />
        {requesting ? 'Requesting…' : 'Review'}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Review pull request"
          className="absolute right-0 z-50 mt-1 w-72 overflow-hidden rounded-xl border border-droid-border bg-droid-surface py-1 shadow-xl"
        >
          <p className="flex items-center gap-2 px-3 pt-1 pb-1.5">
            <span className="text-[11px] font-medium tracking-wide text-droid-text-muted uppercase">
              Review PR
            </span>
            {cubicInstalled ? (
              <span className="rounded-full bg-droid-elevated px-1.5 py-0.5 text-[10.5px] text-droid-text-muted">
                Cubic connected
              </span>
            ) : null}
          </p>
          {options.map((option) => (
            <MenuRow
              key={option.action}
              option={option}
              disabled={requesting && option.action === 'run-cubic'}
              onClick={() => {
                run(option.action);
              }}
            />
          ))}
          {options.some((option) => option.action === 'enable-cubic') ? (
            <p
              title="DROIDEX may receive a reward if you upgrade."
              className="px-3 pt-0.5 pb-1 text-[11px] text-droid-text-muted"
            >
              Referral link
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({
  option,
  disabled,
  onClick,
}: {
  option: PrReviewOption;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-droid-active disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5 text-[13px] text-droid-text">
        {option.title}
        {option.action === 'enable-cubic' ? (
          <Octicon name="link-external" size={11} className="text-droid-text-muted" />
        ) : null}
      </span>
      <span className="block text-[11.5px] text-droid-text-muted">{option.hint}</span>
    </button>
  );
}
