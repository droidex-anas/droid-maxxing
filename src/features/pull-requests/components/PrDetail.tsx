import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';

import { openExternal } from '../../../lib/onboarding';
import type { PullRequest } from '../../../types/vcs';
import { usePullRequestDetail } from '../hooks/usePullRequestDetail';
import { PrConversation } from './PrConversation';
import { PrDiff } from './PrDiff';
import { PrSummary } from './PrSummary';

export type PrDetailTab = 'summary' | 'code' | 'chat';

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
  { id: 'chat', label: 'Chat', key: '3' },
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

export function PrDetail({
  cwd,
  number,
  pr,
}: {
  cwd: string;
  number: number;
  pr: PullRequest | null;
}) {
  const [tab, setTab] = useState<PrDetailTab>('summary');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const identityRef = useRef({ cwd, number });
  identityRef.current = { cwd, number };
  const detail = usePullRequestDetail(cwd, number, {
    active: true,
    loadDiff: tab === 'code',
  });
  const headerPr = detail.pr ?? pr;

  useEffect(() => {
    setDraft('');
    setPosting(false);
  }, [cwd, number]);

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

  const conversation = {
    comments: detail.comments,
    loading: detail.loading && !detail.loaded,
    error: detail.commentsError,
    draft,
    posting,
    onDraftChange: setDraft,
    onSubmit: submit,
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-4 px-8 pt-4 pb-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
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
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="Open on GitHub"
            disabled={!headerPr?.url}
            onClick={() => {
              if (headerPr?.url) void openExternal(headerPr.url);
            }}
            className="rounded-xl p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-40"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Refresh"
            onClick={detail.refresh}
            className="rounded-xl p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${detail.loading ? 'animate-spin' : ''}`} />
          </button>
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
            comments={conversation.comments}
            commentsError={conversation.error}
            draft={conversation.draft}
            posting={conversation.posting}
            onDraftChange={conversation.onDraftChange}
            onSubmit={conversation.onSubmit}
          />
        ) : null}
        {tab === 'code' ? <CodePane diff={detail.diff} diffError={detail.diffError} /> : null}
        {tab === 'chat' ? <PrConversation {...conversation} /> : null}
      </div>
    </div>
  );
}
