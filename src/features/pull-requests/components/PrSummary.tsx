import { CheckStatusIcon, Octicon } from '../../../components/environment/GithubIcons';
import { bucketToStatus, checksSummary } from '../../../lib/github';
import { openExternal } from '../../../lib/onboarding';
import type { PrCheck, PrComment, PrCommit, PullRequest } from '../../../types/vcs';
import { prCommentBlocks } from '../lib/prCommentBody';
import { TONE_TEXT_CLASS, checksBadge, hasMergeConflicts } from '../lib/prMeta';
import { prRelativeTime } from '../lib/prTime';
import { PrBody } from './PrBody';
import { PrConversation } from './PrConversation';
import { PrHeader } from './PrHeader';
import { PrSection } from './PrSection';
import { PrTimeline } from './PrTimeline';

function CheckRow({ check }: { check: PrCheck }) {
  const finished = prRelativeTime(check.completedAt ?? check.startedAt);
  return (
    <button
      type="button"
      onClick={() => {
        if (check.link) void openExternal(check.link);
      }}
      disabled={!check.link}
      title={check.link ? 'Open run on GitHub' : check.description || check.state}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-droid-active disabled:cursor-default disabled:hover:bg-transparent"
    >
      <CheckStatusIcon status={bucketToStatus(check.bucket)} size={14} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-droid-text">{check.name}</span>
        {check.workflow ? (
          <span className="mt-0.5 block truncate text-[11.5px] text-droid-text-muted">
            {check.workflow}
          </span>
        ) : null}
      </span>
      {finished ? (
        <span className="shrink-0 text-[11.5px] text-droid-text-muted">{finished}</span>
      ) : null}
      {check.link ? (
        <Octicon name="link-external" size={12} className="shrink-0 text-droid-text-muted" />
      ) : null}
    </button>
  );
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
      <div className="-ml-1">
        {error ? <p className="mb-1 text-[13px] text-droid-text-muted">{error}</p> : null}
        {checks.map((check) => (
          <CheckRow
            // A matrix job or a re-run reports the same name and workflow
            // twice; the run link is what tells the two runs apart.
            key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`}
            check={check}
          />
        ))}
      </div>
    );
  }
  if (loading) return <div className="h-12 rounded-xl bg-droid-elevated/40" />;
  return <p className="text-[13px] text-droid-text-muted">{error ?? 'No checks reported'}</p>;
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
  // Generated descriptions carry the same disclosures, footers, and badge links
  // as bot comments, so they go through the same renderer.
  const blocks = body ? prCommentBlocks(body) : [];
  if (blocks.length === 0) {
    return <p className="text-[13px] text-droid-text-muted">{metaError ?? 'No description.'}</p>;
  }
  return (
    <>
      {/* A refresh that fails after the description loaded still has to report
          the failure; the cached body must not read as a successful load. */}
      {metaError ? <p className="mb-2 text-[13px] text-droid-text-muted">{metaError}</p> : null}
      <PrBody blocks={blocks} />
    </>
  );
}

// Conflicts are resolved in a checkout or on github.com, so this section states
// the fact and links out instead of offering a resolve button it cannot honor.
function MergeConflicts({ pr }: { pr: PullRequest }) {
  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/30 px-3 py-2.5">
      <p className="text-[13px] text-droid-text-secondary">
        <span className="text-droid-text">{pr.headRefName ?? 'This branch'}</span> cannot be merged
        into <span className="text-droid-text">{pr.baseRefName ?? 'the base branch'}</span>{' '}
        automatically. Resolve the conflicts in a checkout of the branch.
      </p>
      <button
        type="button"
        onClick={() => {
          void openExternal(pr.url);
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-droid-border px-2 py-1 text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-active hover:text-droid-text"
      >
        <Octicon name="link-external" size={12} />
        View conflicts on GitHub
      </button>
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
  commits,
  viewerLogin,
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
  commits: PrCommit[];
  viewerLogin: string | null;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const summary = checksSummary(checks);
  const badge = checksBadge(summary);
  const pending = loading && !loaded;

  return (
    <PrConversation
      viewerLogin={viewerLogin}
      draft={draft}
      posting={posting}
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
    >
      <PrHeader
        pr={pr}
        number={number}
        commentCount={comments.length}
        checks={checks}
        checksLoading={pending}
        checksError={checksError}
      />

      <PrSection title="Description">
        <Description loaded={loaded} body={body} metaError={metaError} />
      </PrSection>

      <PrSection
        title="Checks"
        count={checks.length > 0 ? checks.length : undefined}
        meta={
          badge ? (
            <span className={`text-[12px] ${TONE_TEXT_CLASS[badge.tone]}`}>{badge.label}</span>
          ) : null
        }
        // Failures, work in progress, and a load error all need to be read
        // without opening the section first.
        defaultOpen={
          summary.status === 'failure' || summary.status === 'pending' || checksError !== null
        }
      >
        <ChecksBody checks={checks} loading={pending} error={checksError} />
      </PrSection>

      {pr && hasMergeConflicts(pr) ? (
        <PrSection title="Merge conflicts">
          <MergeConflicts pr={pr} />
        </PrSection>
      ) : null}

      <PrSection
        title="Conversation"
        count={comments.length}
        meta={
          commits.length > 0 ? (
            <span className="text-[12px] text-droid-text-muted">
              {commits.length} {commits.length === 1 ? 'commit' : 'commits'}
            </span>
          ) : null
        }
      >
        <PrTimeline
          pr={pr}
          comments={comments}
          commits={commits}
          loading={pending}
          error={commentsError}
        />
      </PrSection>
    </PrConversation>
  );
}
