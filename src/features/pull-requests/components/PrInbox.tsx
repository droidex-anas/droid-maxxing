import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { Octicon, PrStateIcon } from '../../../components/environment/GithubIcons';
import { prKind } from '../../../lib/github';
import type { PullRequest } from '../../../types/vcs';
import { filterPullRequests, searchPullRequests, type PrInboxTab } from '../lib/prInbox';
import { displayLogin } from '../lib/prIdentity';
import { prAbsoluteTime, prRelativeTime } from '../lib/prTime';
import { GithubAvatar } from './GithubAvatar';

const TABS: { id: PrInboxTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'authored', label: 'Authored' },
];

const EMPTY_COPY: Record<PrInboxTab, string> = {
  all: 'No open pull requests in this repo.',
  reviewing: 'None assigned to you.',
  authored: 'You have not opened any.',
};

// eslint-disable-next-line react-refresh/only-export-components
export function prInboxEmptyCopy(tab: PrInboxTab, query: string): string {
  return query.trim() ? 'No pull requests match your search.' : EMPTY_COPY[tab];
}

function PrInboxRow({
  pr,
  selected,
  onSelect,
}: {
  pr: PullRequest;
  selected: boolean;
  onSelect: (number: number) => void;
}) {
  const time = prRelativeTime(pr.updatedAt ?? pr.createdAt);
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        onSelect(pr.number);
      }}
      className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-droid-active ${
        selected ? 'bg-droid-active' : ''
      }`}
    >
      <span className="mt-0.5 shrink-0">
        <PrStateIcon kind={prKind(pr)} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] leading-snug font-medium text-droid-text">
            {pr.title}
          </span>
          {time ? (
            <span
              title={prAbsoluteTime(pr.updatedAt ?? pr.createdAt)}
              className="shrink-0 text-[11px] text-droid-text-muted"
            >
              {time}
            </span>
          ) : null}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-droid-text-muted">
          <GithubAvatar login={pr.author} size={16} />
          <span className="shrink-0 text-droid-text-secondary">{displayLogin(pr.author)}</span>
          <span className="shrink-0 tabular-nums">#{pr.number}</span>
          {pr.headRefName ? (
            <>
              <Octicon name="git-branch" size={11} className="shrink-0" />
              {/* Which branch this lands on matters as much as where it comes
                  from, so the row reads target ← source. */}
              <span className="truncate">
                {pr.baseRefName ? `${pr.baseRefName} ← ` : ''}
                {pr.headRefName}
              </span>
            </>
          ) : null}
        </span>
        <span className="mt-1 block text-[11px] tabular-nums">
          <span style={{ color: 'var(--diff-add-fg)' }}>+{pr.additions}</span>{' '}
          <span style={{ color: 'var(--diff-del-fg)' }}>−{pr.deletions}</span>
        </span>
      </span>
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="h-16 rounded-xl bg-droid-elevated/40" />
      ))}
    </div>
  );
}

function InboxList({
  loading,
  emptyCopy,
  prs,
  selectedNumber,
  onSelect,
}: {
  loading: boolean;
  emptyCopy: string;
  prs: PullRequest[];
  selectedNumber: number | null;
  onSelect: (number: number) => void;
}) {
  if (loading) return <SkeletonRows />;
  if (prs.length === 0) {
    return <p className="px-1 py-6 text-[13px] text-droid-text-muted">{emptyCopy}</p>;
  }
  return (
    <div className="space-y-0.5">
      {prs.map((pr) => (
        <PrInboxRow
          key={pr.number}
          pr={pr}
          selected={pr.number === selectedNumber}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function PrInbox({
  prs,
  viewerLogin,
  selectedNumber,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  prs: PullRequest[];
  viewerLogin: string | null;
  selectedNumber: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (number: number) => void;
  onRetry: () => void;
}) {
  const [tab, setTab] = useState<PrInboxTab>('all');
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () => searchPullRequests(filterPullRequests(prs, tab, viewerLogin), query),
    [prs, query, tab, viewerLogin],
  );
  const showSkeleton = loading && prs.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-3 pb-2">
      <div className="flex items-center gap-3 px-1">
        <div role="tablist" aria-label="Pull request filters" className="flex items-center gap-3">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
              }}
              className={`text-[13px] font-medium transition-colors ${
                tab === item.id
                  ? 'text-droid-text'
                  : 'text-droid-text-muted hover:text-droid-text-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRetry}
          title="Refresh"
          className="ml-auto rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <Octicon
            name="sync"
            size={14}
            label="Refresh"
            className={loading ? 'animate-spin' : ''}
          />
        </button>
      </div>

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-droid-text-muted" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          aria-label="Search pull requests"
          placeholder="Search"
          className="w-full rounded-xl bg-droid-field py-2 pr-3 pl-9 text-[13px] text-droid-text outline-none placeholder:text-droid-text-muted focus-visible:ring-2 focus-visible:ring-droid-accent/60"
        />
      </div>

      {error ? (
        <div className="mt-2 flex items-center gap-2 px-1 text-[12px] text-droid-text-muted">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-xl px-2 py-1 font-medium text-droid-text transition-colors hover:bg-droid-elevated"
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="pr-workspace-scroll mt-2 min-h-0 flex-1 overflow-y-auto">
        <InboxList
          loading={showSkeleton}
          emptyCopy={prInboxEmptyCopy(tab, query)}
          prs={visible}
          selectedNumber={selectedNumber}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
