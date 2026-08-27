import { useMemo, useState } from 'react';
import { ChevronRight, ListTodo, Search, Undo2 } from 'lucide-react';

import { Octicon, PrStateIcon } from '../../../components/environment/GithubIcons';
import { comparablePath } from '../../../lib/pathComparison';
import { prKind } from '../../../lib/github';
import { workspaceName } from '../../../lib/workspaces';
import {
  attachInboxRepoErrors,
  ensureCurrentInboxGroup,
  filterPullRequests,
  groupInboxPullRequests,
  inboxGroupIsExpanded,
  isCurrentInboxGroup,
  orderInboxGroups,
  searchPullRequests,
  type InboxPullRequest,
  type InboxRepoGroup,
  type PrInboxTab,
} from '../lib/prInbox';
import { prBacklogId } from '../lib/prBacklog';
import type { InboxRepoError } from '../lib/prListState';
import { displayLogin } from '../lib/prIdentity';
import { prAbsoluteTime, prRelativeTime } from '../lib/prTime';
import { GithubAvatar } from './GithubAvatar';

const TABS: { id: PrInboxTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'authored', label: 'Authored' },
  { id: 'backlog', label: 'Backlog' },
];

const EMPTY_COPY: Record<PrInboxTab, string> = {
  all: 'No open pull requests in this repo.',
  reviewing: 'None assigned to you.',
  authored: 'You have not opened any.',
  backlog: 'Nothing in the backlog.',
};

// eslint-disable-next-line react-refresh/only-export-components
export function prInboxEmptyCopy(tab: PrInboxTab, query: string, multiRepo = false): string {
  if (query.trim()) return 'No pull requests match your search.';
  if (tab === 'all' && multiRepo) return 'No open pull requests in these workspaces.';
  return EMPTY_COPY[tab];
}

export function shouldShowPrInboxEmpty(error: string | null, count: number): boolean {
  return !error && count === 0;
}

function rowIsSelected(
  pr: InboxPullRequest,
  selectedCwd: string | null,
  selectedNumber: number | null,
): boolean {
  return (
    selectedNumber === pr.number &&
    selectedCwd != null &&
    comparablePath(selectedCwd) === comparablePath(pr.cwd)
  );
}

function PrInboxRow({
  pr,
  selected,
  backlogged,
  onSelect,
  onToggleBacklog,
}: {
  pr: InboxPullRequest;
  selected: boolean;
  backlogged: boolean;
  onSelect: (pr: InboxPullRequest) => void;
  onToggleBacklog: (pr: InboxPullRequest) => void;
}) {
  const time = prRelativeTime(pr.updatedAt ?? pr.createdAt);
  return (
    <div
      className={`group flex w-full items-start gap-1 rounded-xl pr-1 transition-colors hover:bg-droid-active ${
        selected ? 'bg-droid-active' : ''
      }`}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          onSelect(pr);
        }}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left"
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
      <button
        type="button"
        title={backlogged ? 'Restore from backlog' : 'Move to backlog'}
        aria-label={backlogged ? 'Restore from backlog' : 'Move to backlog'}
        onClick={() => {
          onToggleBacklog(pr);
        }}
        className="mt-1.5 shrink-0 rounded-lg p-1.5 text-droid-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-droid-elevated hover:text-droid-text focus-visible:opacity-100"
      >
        {backlogged ? <Undo2 size={14} /> : <ListTodo size={14} />}
      </button>
    </div>
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

function InboxRows({
  prs,
  selectedCwd,
  selectedNumber,
  backlogIds,
  onSelect,
  onToggleBacklog,
}: {
  prs: InboxPullRequest[];
  selectedCwd: string | null;
  selectedNumber: number | null;
  backlogIds: ReadonlySet<string>;
  onSelect: (pr: InboxPullRequest) => void;
  onToggleBacklog: (pr: InboxPullRequest) => void;
}) {
  return (
    <div className="space-y-0.5">
      {prs.map((pr) => (
        <PrInboxRow
          key={`${pr.cwd}:${pr.number}`}
          pr={pr}
          selected={rowIsSelected(pr, selectedCwd, selectedNumber)}
          backlogged={backlogIds.has(prBacklogId(pr))}
          onSelect={onSelect}
          onToggleBacklog={onToggleBacklog}
        />
      ))}
    </div>
  );
}

function InboxList({
  loading,
  error,
  emptyCopy,
  groups,
  currentCwd,
  searching,
  expandedOther,
  onToggleOther,
  selectedCwd,
  selectedNumber,
  backlogIds,
  repoErrors,
  onSelect,
  onToggleBacklog,
}: {
  loading: boolean;
  error: string | null;
  emptyCopy: string;
  groups: InboxRepoGroup[];
  currentCwd: string | null;
  searching: boolean;
  expandedOther: ReadonlySet<string>;
  onToggleOther: (cwd: string) => void;
  selectedCwd: string | null;
  selectedNumber: number | null;
  backlogIds: ReadonlySet<string>;
  repoErrors: InboxRepoError[];
  onSelect: (pr: InboxPullRequest) => void;
  onToggleBacklog: (pr: InboxPullRequest) => void;
}) {
  if (loading) return <SkeletonRows />;
  if (groups.length === 0) {
    return error ? null : (
      <p className="px-1 py-6 text-[13px] text-droid-text-muted">{emptyCopy}</p>
    );
  }
  const errorByCwd = new Map(repoErrors.map((item) => [comparablePath(item.cwd), item] as const));
  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const current = isCurrentInboxGroup(group.cwd, currentCwd);
        const expanded = inboxGroupIsExpanded({
          cwd: group.cwd,
          currentCwd,
          expandedOther,
          searching,
          selectedCwd,
        });
        const repoError = errorByCwd.get(comparablePath(group.cwd));
        const rows = (
          <InboxRows
            prs={group.prs}
            selectedCwd={selectedCwd}
            selectedNumber={selectedNumber}
            backlogIds={backlogIds}
            onSelect={onSelect}
            onToggleBacklog={onToggleBacklog}
          />
        );
        if (current) {
          return (
            <section key={group.cwd}>
              {repoError ? (
                <p className="px-1 pb-2 text-[12px] text-droid-text-muted">{repoError.message}</p>
              ) : null}
              {group.prs.length === 0 && !repoError ? (
                <p className="px-1 py-4 text-[13px] text-droid-text-muted">
                  No open pull requests in this repo.
                </p>
              ) : (
                rows
              )}
            </section>
          );
        }
        return (
          <section key={group.cwd}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} ${group.repoName} pull requests`}
              onClick={() => {
                onToggleOther(group.cwd);
              }}
              className="flex w-full items-center gap-1.5 rounded-xl px-1.5 py-1.5 text-left text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text-secondary"
            >
              <ChevronRight
                size={14}
                className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
              <span className="min-w-0 truncate text-[12px] font-medium">{group.repoName}</span>
              {group.prs.length > 0 ? (
                <span className="ml-auto shrink-0 text-[11px] tabular-nums opacity-60">
                  {group.prs.length}
                </span>
              ) : null}
            </button>
            {expanded ? (
              <div className="mt-1">
                {repoError ? (
                  <p className="px-1 pb-2 text-[12px] text-droid-text-muted">{repoError.message}</p>
                ) : null}
                {rows}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function PrInbox({
  prs,
  viewerLogin,
  currentCwd,
  selectedCwd,
  selectedNumber,
  loading,
  error,
  repoErrors,
  backlogIds,
  onSelect,
  onRetry,
  onToggleBacklog,
}: {
  prs: InboxPullRequest[];
  viewerLogin: string | null;
  currentCwd: string | null;
  selectedCwd: string | null;
  selectedNumber: number | null;
  loading: boolean;
  error: string | null;
  repoErrors: InboxRepoError[];
  backlogIds: ReadonlySet<string>;
  onSelect: (pr: InboxPullRequest) => void;
  onRetry: () => void;
  onToggleBacklog: (pr: InboxPullRequest) => void;
}) {
  const [tab, setTab] = useState<PrInboxTab>('all');
  const [query, setQuery] = useState('');
  const [expandedOther, setExpandedOther] = useState<Set<string>>(() => new Set());
  const visible = useMemo(
    () => searchPullRequests(filterPullRequests(prs, tab, viewerLogin, backlogIds), query),
    [backlogIds, prs, query, tab, viewerLogin],
  );
  const groups = useMemo(
    () =>
      orderInboxGroups(
        ensureCurrentInboxGroup(
          attachInboxRepoErrors(groupInboxPullRequests(visible), repoErrors),
          currentCwd,
          currentCwd ? workspaceName(currentCwd) : '',
        ),
        currentCwd,
      ),
    [currentCwd, repoErrors, visible],
  );
  const showSkeleton = loading && prs.length === 0;
  const multiRepo = groups.length > 1 || repoErrors.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-3 pb-2">
      <div className="flex items-center gap-3 px-1">
        <div
          role="tablist"
          aria-label="Pull request filters"
          className="flex min-w-0 items-center gap-2.5"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
              }}
              className={`shrink-0 text-[13px] font-medium transition-colors ${
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
          error={error}
          emptyCopy={prInboxEmptyCopy(tab, query, multiRepo)}
          groups={groups}
          currentCwd={currentCwd}
          searching={query.trim().length > 0}
          expandedOther={expandedOther}
          onToggleOther={(cwd) => {
            const key = comparablePath(cwd);
            setExpandedOther((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }}
          selectedCwd={selectedCwd}
          selectedNumber={selectedNumber}
          backlogIds={backlogIds}
          repoErrors={repoErrors}
          onSelect={onSelect}
          onToggleBacklog={onToggleBacklog}
        />
      </div>
    </div>
  );
}
