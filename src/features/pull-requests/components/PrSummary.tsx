import { CheckStatusIcon, PrStateIcon } from '../../../components/environment/GithubIcons';
import { Markdown } from '../../../components/Markdown';
import { bucketToStatus, prKind } from '../../../lib/github';
import { openExternal } from '../../../lib/onboarding';
import { formatRelativeTime } from '../../../lib/time';
import type { PrCheck, PrComment, PullRequest } from '../../../types/vcs';
import { PrConversation } from './PrConversation';

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? formatRelativeTime(ts) : '';
}

function branchPair(pr: PullRequest): string | null {
  if (!pr.baseRefName && !pr.headRefName) return null;
  return `${pr.baseRefName ?? ''} ← ${pr.headRefName ?? ''}`;
}

function ChecksBody({
  checks,
  loading,
  error,
}: {
  checks: PrCheck[];
  loading: boolean;
  error: string | null;
}) {
  if (checks.length > 0) {
    return (
      <div className="mt-2">
        {error ? <p className="mb-2 text-[13px] text-droid-text-muted">{error}</p> : null}
        {checks.map((check) => (
          <button
            key={`${check.name}-${check.workflow ?? ''}`}
            type="button"
            onClick={() => {
              if (check.link) void openExternal(check.link);
            }}
            disabled={!check.link}
            className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-droid-active disabled:cursor-default"
          >
            <CheckStatusIcon status={bucketToStatus(check.bucket)} size={14} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-droid-text">{check.name}</span>
              {check.workflow ? (
                <span className="mt-0.5 block truncate text-[11px] text-droid-text-muted">
                  {check.workflow}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    );
  }
  if (loading) return <div className="mt-3 h-12 rounded-xl bg-droid-elevated/40" />;
  return <p className="mt-3 text-[13px] text-droid-text-muted">{error ?? 'No checks reported'}</p>;
}

function ChecksList({
  checks,
  loading,
  error,
}: {
  checks: PrCheck[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-[12px] text-droid-text-muted">Checks</h2>
      <ChecksBody checks={checks} loading={loading} error={error} />
    </section>
  );
}

function Description({
  loaded,
  body,
  metaError,
}: {
  loaded: boolean;
  body: string;
  metaError: string | null;
}) {
  if (!loaded && !body) return <div className="h-16 rounded-xl bg-droid-elevated/40" />;
  if (body) return <Markdown allowGeneratedContent={false}>{body}</Markdown>;
  return <p className="text-[13px] text-droid-text-muted">{metaError ?? 'No description.'}</p>;
}

function SummaryHeader({
  pr,
  number,
  body,
  loaded,
  loading,
  metaError,
  checks,
  checksError,
}: {
  pr: PullRequest | null;
  number: number;
  body: string;
  loaded: boolean;
  loading: boolean;
  metaError: string | null;
  checks: PrCheck[];
  checksError: string | null;
}) {
  const time = relativeTime(pr?.updatedAt ?? pr?.createdAt ?? null);
  const branches = pr ? branchPair(pr) : null;
  const meta = [
    `#${String(number)}`,
    pr?.author,
    branches,
    pr ? `+${String(pr.additions)} −${String(pr.deletions)}` : null,
    time,
  ].filter(Boolean);

  return (
    <div>
      <div className="flex items-start gap-3">
        {pr ? (
          <span className="mt-1 shrink-0">
            <PrStateIcon kind={prKind(pr)} size={20} />
          </span>
        ) : null}
        <h1 className="text-[22px] font-semibold leading-snug text-droid-text">
          {pr?.title ?? `#${String(number)}`}
        </h1>
      </div>
      <p className="mt-2 text-[13px] text-droid-text-muted">{meta.join(' · ')}</p>
      <div className="mt-6">
        <Description loaded={loaded} body={body} metaError={metaError} />
      </div>
      <ChecksList checks={checks} loading={loading && !loaded} error={checksError} />
      <h2 className="mt-8 text-[12px] text-droid-text-muted">Comments</h2>
    </div>
  );
}

export function PrSummary({
  pr,
  number,
  body,
  loaded,
  loading,
  metaError,
  checks,
  checksError,
  comments,
  commentsError,
  draft,
  posting,
  onDraftChange,
  onSubmit,
}: {
  pr: PullRequest | null;
  number: number;
  body: string;
  loaded: boolean;
  loading: boolean;
  metaError: string | null;
  checks: PrCheck[];
  checksError: string | null;
  comments: PrComment[];
  commentsError: string | null;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <PrConversation
      header={
        <SummaryHeader
          pr={pr}
          number={number}
          body={body}
          loaded={loaded}
          loading={loading}
          metaError={metaError}
          checks={checks}
          checksError={checksError}
        />
      }
      comments={comments}
      loading={loading && !loaded}
      error={commentsError}
      draft={draft}
      posting={posting}
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
    />
  );
}
