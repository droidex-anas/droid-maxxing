import { useEffect, useRef, useState } from 'react';

import { Octicon, PrStateIcon } from '../../../components/environment/GithubIcons';
import { prKind } from '../../../lib/github';
import { openExternal } from '../../../lib/onboarding';
import type { PullRequest } from '../../../types/vcs';
import { usePullRequestDetail } from '../hooks/usePullRequestDetail';
import { isCubicRemembered, rememberCubic } from '../lib/cubicMemory';
import { CUBIC_REVIEW_MENTION, hasCubicActivity, repoKeyFromPrUrl } from '../lib/prReview';
import { PrDiff } from './PrDiff';
import { PrMergeButton } from './PrMergeButton';
import { PrReviewButton } from './PrReviewButton';
import { PrSummary } from './PrSummary';

export type PrDetailTab = 'summary' | 'code';

export function applyCommentPostSettlement(
  submitted: { cwd: string; number: number },
  current: { cwd: string; number: number },
  resultOk: boolean,
): { clearDraft: boolean; posting: false } | null {
  if (submitted.cwd !== current.cwd || submitted.number !== current.number) return null;
  return { clearDraft: resultOk, posting: false };
}

const TABS: { id: PrDetailTab; label: string; key: string }[] = [
  { id: 'summary', label: 'Summary', key: '1' },
  { id: 'code', label: 'Code', key: '2' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function CodePane({ diff, diffError }: { diff: string | null; diffError: string | null }) {
  if (diff !== null) return <PrDiff diff={diff} />;
  if (diffError) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="text-[13px] text-droid-text-muted">{diffError}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="h-16 w-full max-w-2xl rounded-xl bg-droid-elevated/40" />
    </div>
  );
}

function ToolbarIconButton({
  label,
  icon,
  disabled,
  spinning,
  onClick,
}: {
  label: string;
  icon: 'link-external' | 'sync';
  disabled?: boolean;
  spinning?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
    >
      <Octicon name={icon} size={14} label={label} className={spinning ? 'animate-spin' : ''} />
    </button>
  );
}

export function PrDetail({
  cwd,
  number,
  pr,
  viewerLogin,
  onOpenChat,
  onReviewWithDroid,
}: {
  cwd: string;
  number: number;
  pr: PullRequest | null;
  viewerLogin: string | null;
  onOpenChat: (pr: PullRequest) => void;
  onReviewWithDroid: (pr: PullRequest) => void;
}) {
  const [tab, setTab] = useState<PrDetailTab>('summary');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [requestingReview, setRequestingReview] = useState(false);
  const identityRef = useRef({ cwd, number });
  identityRef.current = { cwd, number };
  const detail = usePullRequestDetail(cwd, number, {
    active: true,
    loadDiff: tab === 'code',
  });
  const headerPr = detail.pr ?? pr;

  const repoKey = repoKeyFromPrUrl(headerPr?.url);
  const cubicActive = hasCubicActivity(detail.comments);

  useEffect(() => {
    setDraft('');
    setPosting(false);
    setRequestingReview(false);
  }, [cwd, number]);

  // Cubic reviewing this repository once is proof it is installed, so the
  // invitation never returns for it.
  useEffect(() => {
    if (cubicActive) rememberCubic(repoKey);
  }, [cubicActive, repoKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (
        event.target instanceof HTMLElement &&
        !event.target.closest('[data-testid="pull-requests-workspace"]')
      ) {
        return;
      }
      const next = TABS.find((item) => item.key === event.key);
      if (next) setTab(next.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    const submittedCwd = cwd;
    const submittedNumber = number;
    setPosting(true);
    void detail.submitComment(body).then((result) => {
      const settlement = applyCommentPostSettlement(
        { cwd: submittedCwd, number: submittedNumber },
        identityRef.current,
        result.ok,
      );
      if (!settlement) return;
      if (settlement.clearDraft) setDraft('');
      setPosting(settlement.posting);
    });
  };

  const runCubicReview = () => {
    const submittedCwd = cwd;
    const submittedNumber = number;
    setRequestingReview(true);
    void detail.submitComment(CUBIC_REVIEW_MENTION, 'Cubic review requested').then(() => {
      if (
        identityRef.current.cwd !== submittedCwd ||
        identityRef.current.number !== submittedNumber
      )
        return;
      setRequestingReview(false);
    });
  };

  const composer = {
    viewerLogin,
    draft,
    posting,
    onDraftChange: setDraft,
    onSubmit: submit,
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* This strip sits where the window's title bar would be, so it carries
          the drag region the session view gets from its floating controls. */}
      <div data-electron-drag-region className="flex items-center gap-2 px-8 pt-4 pb-2">
        {headerPr ? (
          <span className="shrink-0">
            <PrStateIcon kind={prKind(headerPr)} size={16} />
          </span>
        ) : null}
        <div className="flex items-center gap-0.5 rounded-lg bg-droid-elevated/50 p-0.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
              }}
              className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                tab === item.id
                  ? 'bg-droid-surface text-droid-text shadow-sm'
                  : 'text-droid-text-muted hover:text-droid-text-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarIconButton
            label="Refresh"
            icon="sync"
            spinning={detail.loading}
            onClick={detail.refresh}
          />
          <ToolbarIconButton
            label="Open on GitHub"
            icon="link-external"
            disabled={!headerPr?.url}
            onClick={() => {
              if (headerPr?.url) void openExternal(headerPr.url);
            }}
          />
          <button
            type="button"
            title="Start a chat about this pull request"
            disabled={!headerPr}
            onClick={() => {
              if (headerPr) onOpenChat(headerPr);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-droid-border px-2.5 py-1.5 text-[12.5px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
          >
            <Octicon name="comment-discussion" size={13} />
            Chat
          </button>
          <PrReviewButton
            pr={headerPr}
            cubicInstalled={cubicActive || isCubicRemembered(repoKey)}
            requesting={requestingReview}
            onRunCubicReview={runCubicReview}
            onReviewWithDroid={() => {
              if (headerPr) onReviewWithDroid(headerPr);
            }}
          />
          <PrMergeButton
            pr={headerPr}
            merging={detail.merging}
            onMerge={(method) => {
              void detail.merge(method);
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'summary' ? (
          <PrSummary
            pr={headerPr}
            number={number}
            body={detail.body}
            loaded={detail.loaded}
            loading={detail.loading}
            metaError={detail.metaError}
            checks={detail.checks}
            checksError={detail.checksError}
            comments={detail.comments}
            commentsError={detail.commentsError}
            commits={detail.commits}
            {...composer}
          />
        ) : null}
        {tab === 'code' ? <CodePane diff={detail.diff} diffError={detail.diffError} /> : null}
      </div>
    </div>
  );
}
