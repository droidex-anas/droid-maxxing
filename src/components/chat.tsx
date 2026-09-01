import { Fragment, useMemo, useState, memo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, FileText, Expand as ExpandIcon, MousePointer2, PenLine } from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../types/bridge';
import { Markdown } from './Markdown';
import { hasAppBlock, hasCompleteAppBlock, hasIncompleteAppBlock } from './appBlockRuntime';
import { SpecRenderer } from './SpecRenderer';
import { JsonRender, splitJsonRender, hasJsonRender } from './JsonRender';
import type { FileChange } from '../lib/diff';
import { ImageAttachmentChip } from './media/ImageAttachmentChip';
import { isImagePath } from '../lib/localImage';
import { userMessageAttachments } from '../lib/promptMentions';
import { DiffCard, DiffGroup } from './DiffView';
import { SubagentsDock, type SubagentsDockData } from './SubagentsDock';
import TurnChangesPanel from './TurnChangesPanel';
import {
  toolMeta,
  safeJson,
  stripAnsi,
  formatDuration,
  parseTruncatedTail,
  childSessionInfo,
  isWebSearchTool,
  isWebFetchTool,
  parseWebSearch,
  parseWebFetch,
  looksLikeHtml,
  formatCharCount,
  webSourceName,
  toolArgStringArray,
} from '../lib/tools';
import { classifyEvent } from '../lib/transcript';
import {
  childSessionLatest,
  resolveWaveSessions,
  type ChildSessionActivity,
  type ChildSessionTarget,
} from '../lib/childSessions';
import { WorktreeCreatedCard } from './WorktreeCreatedCard';
import { feedRowId } from '../hooks/conversationViewportAnchor';
import {
  ErrorLine,
  httpHref,
  linkify,
  openLink,
  PlanUpdate,
  RED,
  RED_TINT,
  ShellCard,
  ToolLine,
} from './transcript/cards';
import {
  Caret,
  CompactingIndicator,
  CompactionDivider,
  CopyButton,
  ErrorTag,
  Expand,
  StreamingCaret,
  WorkingIndicator,
  useElapsed,
} from './transcript/primitives';
import {
  appendedFeedItemKeys,
  buildFeed,
  childSessionLineIsRunning,
  correlateResults,
  groupTurns,
  isCompactionCompleteStatus,
  promptAnchorsFromItems,
  rememberFreshAppResponses,
  sameFeedEvents,
  summarizeActivity,
  tailTimestamp,
  trailingSubagentPoll,
  type FeedItem,
  type FreshAppResponseState,
} from '../lib/transcriptFeed';
import type { ToolActivityDensity } from '../lib/toolActivity';

const EASE = [0.16, 1, 0.3, 1] as const;

export {
  ChatSkeleton,
  CompactingIndicator,
  CompactionDivider,
  StreamingCaret,
  TranscriptSkeleton,
  WorkingIndicator,
} from './transcript/primitives';

// A status line that signals compaction is in progress (not the completion
// line). Match the active gerund ("Compacting conversation...") specifically so
// terminal lines ("Compaction complete.", "Nothing to compact.") and rejections
// ("Cannot compact while a turn is active.") don't keep the shimmer running.
export function isCompactingStatus(text?: string): boolean {
  const t = text ?? '';
  return /compacting/i.test(t) && !/complete/i.test(t);
}

/* ── Thinking / Thought ── */
function ThinkingItem({
  text,
  durationMs,
  active,
  startTs,
}: {
  text: string;
  durationMs?: number;
  active?: boolean;
  startTs?: number;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startTs, !!active);
  const label = active
    ? elapsed >= 1000
      ? `Thinking ${formatDuration(elapsed)}`
      : 'Thinking'
    : durationMs != null && durationMs >= 1000
      ? `Thought for ${formatDuration(durationMs)}`
      : 'Thought';
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
          <span className="shimmer-text text-[13px] font-medium">{label}</span>
        ) : (
          <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">
            {label}
          </span>
        )}
      </button>
      <Expand open={open}>
        <div className="mt-2 pl-[18px] text-[12.5px] text-droid-text-muted/55 leading-[1.7] whitespace-pre-wrap break-words">
          {text}
          {active && <StreamingCaret />}
        </div>
      </Expand>
    </div>
  );
}

/* ── Condensed tool group: "Explored 4 files, 1 search" ── */
function summarizeTools(events: TranscriptEvent[], live = false): { verb: string; rest: string } {
  const calls = events.filter((e) => e.kind === 'tool_call');
  if (calls.length === 0) return { verb: 'Tool result', rest: '' };
  const counts = { file: 0, search: 0, command: 0, page: 0, task: 0, step: 0, plan: 0 };
  let onlyExec = true;
  let onlyWeb = true;
  let onlyPlan = true;
  calls.forEach((e) => {
    // A TodoWrite is internal plan bookkeeping, not a file/command, so it must
    // not inflate the "Explored N files" summary (#20).
    if (classifyEvent(e) === 'plan_update') {
      counts.plan++;
      onlyExec = false;
      onlyWeb = false;
      return;
    }
    onlyPlan = false;
    const { cat } = toolMeta(e.toolName, e.toolArgs);
    if (cat !== 'exec') onlyExec = false;
    if (cat !== 'web') onlyWeb = false;
    if (cat === 'read') counts.file++;
    else if (cat === 'search') counts.search++;
    else if (cat === 'exec') counts.command++;
    else if (cat === 'web') counts.page++;
    else if (cat === 'task') counts.task++;
    else if (cat === 'skill') counts.step++;
    else counts.step++;
  });
  if (onlyPlan) return { verb: live ? 'Updating' : 'Updated', rest: 'plan' };
  const parts: string[] = [];
  const add = (n: number, s: string, p: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? s : p}`);
  };
  add(counts.file, 'file', 'files');
  add(counts.search, 'search', 'searches');
  add(counts.command, 'command', 'commands');
  add(counts.page, 'page', 'pages');
  add(counts.task, 'task', 'tasks');
  add(counts.step, 'step', 'steps');
  add(counts.plan, 'plan update', 'plan updates');
  const verb = onlyExec
    ? live
      ? 'Running'
      : 'Ran'
    : onlyWeb
      ? live
        ? 'Fetching'
        : 'Fetched'
      : live
        ? 'Exploring'
        : 'Explored';
  return { verb, rest: parts.join(', ') };
}

function isPlanOnlyTools(events: TranscriptEvent[]): boolean {
  let sawPlan = false;
  for (const e of events) {
    if (e.kind !== 'tool_call') continue;
    if (classifyEvent(e) !== 'plan_update') return false;
    sawPlan = true;
  }
  return sawPlan;
}

function argStr(args: unknown, key: string): string | undefined {
  if (args && typeof args === 'object') {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/* ── Shared source-row chrome for web search results + fetched pages ── */
function WebSourceRow({
  title,
  snippet,
  url,
  emphasize = false,
}: {
  title: string;
  snippet?: React.ReactNode;
  url: string;
  emphasize?: boolean;
}) {
  const href = httpHref(url);
  return (
    <a
      {...(href
        ? {
            href,
            onClick: (e: React.MouseEvent) => {
              openLink(e, href);
            },
          }
        : {})}
      title={url || title}
      className={`block px-3 py-2.5 transition-colors hover:bg-droid-elevated/60 ${
        emphasize ? 'bg-droid-elevated/40' : ''
      }`}
    >
      <div className="truncate text-[13px] font-medium text-droid-text">{title}</div>
      {snippet && (
        <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-droid-text-muted">
          {snippet}
        </div>
      )}
      {url && (
        <div className="mt-1.5 truncate text-[11px] text-droid-text-muted/75">
          <span>{webSourceName(url)}</span>
        </div>
      )}
    </a>
  );
}

function CountBadge({ label }: { label: string }) {
  return (
    <span className="ml-auto shrink-0 rounded-md border border-droid-border bg-droid-elevated/60 px-1.5 py-0.5 tabular-nums text-[11px] text-droid-text-secondary">
      {label}
    </span>
  );
}

function fetchSnippet(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 280);
}

export function fetchSizeBadge(chars: number, truncatedChars: number | null): string | null {
  // The sentinel counts the omitted characters, so include them: the badge
  // reflects the full fetched page size, not just the kept prefix.
  if (truncatedChars != null) return `${formatCharCount(chars + truncatedChars)}+`;
  if (chars > 0) return formatCharCount(chars);
  return null;
}

/* ── In-flight web tool row: shimmer label while the call has no result yet ── */
function WebToolRunningRow({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shimmer-text shrink-0 text-[12.5px] font-medium">{label}</span>
      {detail ? (
        <span
          className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-muted"
          title={detail}
        >
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function WebSearchRunningRow({ isX, query }: { isX: boolean; query: string }) {
  return (
    <WebToolRunningRow
      label={isX ? 'Searching X…' : 'Searching web…'}
      detail={query.length > 0 ? query : undefined}
    />
  );
}

function searchTrailing(error: boolean, total: number): React.ReactNode {
  if (error) return <ErrorTag />;
  if (total > 0) return <CountBadge label={String(total)} />;
  return null;
}

/* ── Web search: a collapsible search row that expands into readable result
   cards (title, snippet, source) instead of a raw text dump. Stays collapsed
   by default — the header (query + result count) is enough until expanded. ── */
export function WebSearchCard({
  event,
  output,
  error = false,
  running = false,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  running?: boolean;
}) {
  const query = argStr(event.toolArgs, 'query') ?? '';
  const { results, count } = useMemo(() => parseWebSearch(output ?? ''), [output]);
  const total = count ?? results.length;
  const raw = useMemo(() => (output ? stripAnsi(output).trim() : ''), [output]);
  const [open, setOpen] = useState(false);
  const isX = toolArgStringArray(event.toolArgs, 'includeDomains').some((d) =>
    /(^|\.)(x|twitter)\.com$/i.test(d),
  );
  if (running) return <WebSearchRunningRow isX={isX} query={query} />;
  const trailing = searchTrailing(error, total);

  let body: React.ReactNode = null;
  if (open && results.length > 0) {
    body = (
      <div className="mt-2 overflow-hidden rounded-lg border border-droid-border/70 bg-droid-surface/30">
        {results.map((r, i) => (
          <div
            key={`${r.url}-${String(i)}`}
            className="border-b border-droid-border/60 last:border-b-0"
          >
            <WebSourceRow title={r.title} snippet={r.snippet} url={r.url} emphasize={i === 0} />
          </div>
        ))}
      </div>
    );
  } else if (open && raw) {
    body = (
      <pre className="mt-2 max-h-44 overflow-auto rounded-lg border border-droid-border/70 bg-droid-surface/30 px-3 py-2.5 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap break-words">
        {linkify(raw)}
      </pre>
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
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">
          {isX ? 'Searched X' : 'Searched web'}
        </span>
        {query ? (
          <span
            title={query}
            className="min-w-0 truncate rounded-md bg-droid-elevated/40 px-1.5 py-0.5 font-mono text-[11.5px] text-droid-text-muted"
          >
            {query}
          </span>
        ) : null}
        {trailing}
        <Caret open={open} />
      </button>
      <Expand open={open}>{open ? body : null}</Expand>
    </div>
  );
}

export function WebFetchBody({
  error,
  hasBody,
  body,
  url,
  title,
  snippet,
}: {
  error: boolean;
  hasBody: boolean;
  body: string;
  url: string;
  title: string;
  snippet: string;
}) {
  if (error && hasBody) {
    return (
      <pre
        className="mt-1.5 max-h-56 overflow-auto rounded-md px-2.5 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words"
        style={{ backgroundColor: RED_TINT, color: RED }}
      >
        {body}
      </pre>
    );
  }
  if (!hasBody && url.length === 0) return null;
  const showBody = hasBody && body.length > 280;
  // A short body renders only as the snippet (no FetchBodyContent below), so
  // linkify it to keep its URLs clickable. It must sit next to the source row,
  // never inside it: the row is itself an anchor, and nested anchors are
  // invalid HTML whose clicks would open both links. A long body keeps the
  // plain-text preview in the row since the full body renders below.
  const rowSnippet = showBody && snippet.length > 0 ? snippet : undefined;
  const snippetNode =
    !showBody && snippet.length > 0 ? (
      <div className="line-clamp-2 px-3 text-[12px] leading-relaxed text-droid-text-muted">
        {linkify(snippet)}
      </div>
    ) : null;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-droid-border/70 bg-droid-surface/30">
      <WebSourceRow title={title} snippet={rowSnippet} url={url} emphasize />
      {showBody ? <FetchBodyContent body={body} /> : snippetNode}
    </div>
  );
}

/* ── Long fetch body: rendered markdown, with a mono fallback for raw HTML ── */
function FetchBodyContent({ body }: { body: string }) {
  // Raw HTML dumps stay mono — they render poorly as markdown.
  if (looksLikeHtml(body)) {
    return (
      <pre className="max-h-44 overflow-auto rounded-lg bg-droid-elevated/30 px-3 py-2 text-[12px] leading-relaxed text-droid-text-muted whitespace-pre-wrap break-words">
        {linkify(body)}
      </pre>
    );
  }
  return (
    <div className="max-h-96 overflow-auto rounded-lg bg-droid-elevated/30 px-3.5 py-2.5">
      {/* Fetched pages are untrusted: diagrams must stay off so an ```svg fence
          in the body can never reach SvgCodeBlock's dangerouslySetInnerHTML. */}
      <Markdown allowGeneratedContent={false}>{body}</Markdown>
    </div>
  );
}

function WebFetchRunningRow({ url }: { url: string }) {
  return (
    <WebToolRunningRow label="Fetching…" detail={url.length > 0 ? webSourceName(url) : undefined} />
  );
}

function fetchTrailing(error: boolean, badge: string | null): React.ReactNode {
  if (error) return <ErrorTag />;
  if (badge) return <CountBadge label={badge} />;
  return null;
}

/* ── Page fetch: same card language as web search (source, title,
   readable body) so expanded tool groups never dump raw mono fetch text.
   Stays collapsed by default — header alone is enough until the user expands. ── */
function WebFetchCard({
  event,
  output,
  error = false,
  running = false,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  running?: boolean;
}) {
  const urlArg =
    argStr(event.toolArgs, 'url') ??
    argStr(event.toolArgs, 'uri') ??
    argStr(event.toolArgs, 'href') ??
    '';
  const page = useMemo(
    () => parseWebFetch(output ?? '', urlArg.length > 0 ? urlArg : undefined),
    [output, urlArg],
  );
  const url = page.url ?? urlArg;
  const hasBody = page.body.length > 0;
  const [open, setOpen] = useState(false);
  const displayTitle = page.title ?? (url.length > 0 ? webSourceName(url) : 'Page');
  const snippet = useMemo(
    () => (open && hasBody ? fetchSnippet(page.body) : ''),
    [open, hasBody, page.body],
  );
  const badge = fetchSizeBadge(page.chars, page.truncatedChars);
  const trailing = fetchTrailing(error, badge);

  if (running) return <WebFetchRunningRow url={url} />;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">Fetched</span>
        <span
          title={url || displayTitle}
          className="min-w-0 truncate rounded-md bg-droid-elevated/40 px-1.5 py-0.5 font-mono text-[11.5px] text-droid-text-muted"
        >
          {url.length > 0 ? webSourceName(url) : displayTitle}
        </span>
        {trailing}
        <Caret open={open} />
      </button>
      <Expand open={open}>
        {open ? (
          <WebFetchBody
            error={error}
            hasBody={hasBody}
            body={page.body}
            url={url}
            title={displayTitle}
            snippet={snippet}
          />
        ) : null}
      </Expand>
    </div>
  );
}

function renderToolEvents(events: TranscriptEvent[], live = false): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const { resultByCall, consumed } = correlateResults(events);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_call') {
      if (classifyEvent(e) === 'plan_update') {
        nodes.push(<PlanUpdate key={e.id} event={e} live={live && !resultByCall.get(e)} />);
        continue;
      }
      const result = resultByCall.get(e);
      const isError = !!result?.isError;
      // A call without its result while the group is live is still in flight —
      // web/fetch cards show a shimmer until the result lands.
      const running = live && !result;
      const { cat, detail } = toolMeta(e.toolName, e.toolArgs);
      // WebSearch's name matches the generic /search/ category, so route it by
      // name (not cat) to the readable result-card renderer.
      if (isWebSearchTool(e.toolName)) {
        nodes.push(
          <WebSearchCard
            key={e.id}
            event={e}
            output={result?.text}
            error={isError}
            running={running}
          />,
        );
      } else if (isWebFetchTool(e.toolName) || cat === 'web') {
        // FetchUrl / page fetches get the same source-card treatment as search.
        nodes.push(
          <WebFetchCard
            key={e.id}
            event={e}
            output={result?.text}
            error={isError}
            running={running}
          />,
        );
      } else if (cat === 'exec') {
        const command =
          argStr(e.toolArgs, 'command') ??
          argStr(e.toolArgs, 'cmd') ??
          argStr(e.toolArgs, 'script') ??
          detail ??
          e.toolName ??
          'command';
        nodes.push(
          <ShellCard
            key={e.id}
            command={command}
            output={result?.text}
            title={argStr(e.toolArgs, 'summary')}
            error={isError}
            running={running}
          />,
        );
      } else {
        nodes.push(<ToolLine key={e.id} event={e} output={result?.text} error={isError} />);
      }
      continue;
    }
    // A result already shown as its call's inline output (or a silently consumed
    // plan result) must not also render as raw activity.
    if (e.kind === 'tool_result' && consumed.has(e)) continue;
    const body = stripAnsi(e.text ?? safeJson(e.toolArgs)).trimEnd();
    if (!body) continue;
    // A failed result with no call to fold into (e.g. a failed edit that broke
    // its diff run) renders as a compact, expandable error rather than a dump.
    if (e.kind === 'tool_result' && e.isError) {
      nodes.push(<ErrorLine key={e.id} text={body} />);
      continue;
    }
    nodes.push(
      <pre
        key={e.id}
        className="max-h-48 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap break-words"
      >
        {linkify(body)}
      </pre>,
    );
  }
  return nodes;
}

function ToolGroupItem({ events, active }: { events: TranscriptEvent[]; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const { verb, rest } = useMemo(() => summarizeTools(events, active), [events, active]);
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
        <span
          className={
            active
              ? 'shimmer-text shrink-0 text-[13px] font-medium'
              : 'shrink-0 text-[13px] text-droid-text-secondary'
          }
        >
          {verb}
        </span>
        {rest ? (
          <span className="min-w-0 truncate text-[13px] text-droid-text-muted">{rest}</span>
        ) : null}
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-2 space-y-2.5 pl-[18px]">{renderToolEvents(events, active)}</div>
        ) : null}
      </Expand>
    </div>
  );
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function BrowserReferenceChip({ reference }: { reference: BrowserTranscriptReference }) {
  const Icon = reference.kind === 'element' ? MousePointer2 : PenLine;
  return (
    <span
      title={
        reference.selector
          ? `${reference.selector}\n${reference.url ?? ''}`
          : (reference.url ?? `Design reference: ${reference.label}`)
      }
      className="flex min-w-0 items-center gap-1.5 rounded-lg bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-text ring-1 ring-inset ring-droid-accent/30"
    >
      {reference.imageDataUrl ? (
        <img
          src={reference.imageDataUrl}
          alt={reference.label}
          className="h-5 max-w-12 rounded-sm object-cover"
        />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-droid-accent" />
      )}
      <span className="max-w-40 truncate">@{reference.label}</span>
    </span>
  );
}

export function UserBubble({
  event,
}: {
  event: Pick<TranscriptEvent, 'text' | 'skills' | 'files' | 'browserRefs' | 'steered'>;
}) {
  const skills = event.skills ?? [];
  const browserRefs = event.browserRefs ?? [];
  // A replayed message has no files metadata, only the composed text it was sent
  // as, so attachments are recovered from its trailing @mention block.
  const message = userMessageAttachments(event.text, event.files);
  const images = message.files.filter((f) => isImagePath(f));
  const files = message.files.filter((f) => !isImagePath(f));
  const hasAttachments = message.files.length > 0 || browserRefs.length > 0;
  return (
    <div className="flex flex-col items-end gap-1.5 py-1">
      {event.steered && (
        <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
          <svg
            className="h-3 w-3"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
          Steered the conversation
        </span>
      )}
      {hasAttachments && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {browserRefs.map((reference) => (
            <BrowserReferenceChip key={`${reference.kind}:${reference.id}`} reference={reference} />
          ))}
          {images.map((f) => (
            <ImageAttachmentChip key={f} path={f} />
          ))}
          {files.map((f) => (
            <span
              key={f}
              title={f}
              className="flex items-center gap-1 rounded-lg border border-droid-border bg-droid-elevated/80 px-2 py-1 text-[11px] text-droid-text-secondary"
            >
              <FileText className="h-3 w-3 text-droid-text-muted" />
              {baseName(f)}
            </span>
          ))}
        </div>
      )}
      {(message.text || skills.length > 0) && (
        <div className="flex max-w-[80%] flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-relaxed text-droid-text">
          {skills.map((skill) => (
            <span key={skill} title={`Skill: ${skill}`} className="font-medium text-droid-skill">
              {skill}
            </span>
          ))}
          {message.text && <span className="whitespace-pre-wrap break-words">{message.text}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Collapsed spec card shown inline in chat (chevron to expand) ── */
const InlineSpecCard = memo(function InlineSpecCard({
  content,
  onOpenWiki,
}: {
  content: string;
  onOpenWiki?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = useMemo(
    () => /^#{1,3}\s+(.+)$/m.exec(content)?.[1]?.trim() ?? 'Specification',
    [content],
  );
  const sections = useMemo(() => (content.match(/^#{1,3}\s+/gm) ?? []).length, [content]);

  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          onClick={() => {
            setExpanded((e) => !e);
          }}
          className="flex items-center gap-2 flex-1 min-w-0 text-left group"
        >
          <ChevronRight
            className={`w-4 h-4 shrink-0 text-droid-text-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
          <FileText className="w-4 h-4 shrink-0 text-droid-text-muted" />
          <span className="truncate text-[13px] font-medium text-droid-text">{title}</span>
          {sections > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-droid-text-muted/70">
              {sections} sections
            </span>
          )}
        </button>
        {onOpenWiki && (
          <button
            onClick={onOpenWiki}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-droid-text-secondary bg-droid-elevated/50 border border-droid-border hover:bg-droid-elevated/80 hover:text-droid-text transition-colors"
          >
            <ExpandIcon className="w-3.5 h-3.5" />
            Read spec
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: 'linear' }}
          >
            <div className="px-4 pb-4 pt-2 border-t border-droid-border">
              <SpecRenderer content={content} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ── Assistant message body: interleaves Markdown with <json-render> blocks ── */
const MessageBody = memo(function MessageBody({
  text,
  live,
  autoPlayAppBlocks,
}: {
  text: string;
  live: boolean;
  autoPlayAppBlocks: boolean;
}) {
  // Strip the history "[truncated N chars]" sentinel so the raw marker never
  // shows; the cut itself is intentionally not surfaced.
  const { body, truncatedChars } = parseTruncatedTail(text);
  const hasCompleteApp = hasCompleteAppBlock(body);
  const buildingAppBlocks = live && hasAppBlock(body);
  // History caps message text. When that cut landed inside an App fence the
  // source can never run, so the block says so instead of offering a Play
  // control that would start an empty App. Only replayed text can be cut: a
  // live answer whose tail merely looks like the sentinel is still streaming.
  const cutOffAppBlocks = !live && truncatedChars !== null && hasIncompleteAppBlock(body);
  const shouldAutoPlayAppBlocks = autoPlayAppBlocks && hasCompleteApp;
  if (!hasJsonRender(body))
    return (
      <Markdown
        autoPlayAppBlocks={shouldAutoPlayAppBlocks}
        buildingAppBlocks={buildingAppBlocks}
        cutOffAppBlocks={cutOffAppBlocks}
      >
        {body}
      </Markdown>
    );
  const segments = splitJsonRender(body);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'json-render' ? (
          <JsonRender key={i} source={seg.value} />
        ) : seg.value.trim() ? (
          <Markdown
            key={i}
            autoPlayAppBlocks={shouldAutoPlayAppBlocks}
            buildingAppBlocks={buildingAppBlocks}
            cutOffAppBlocks={cutOffAppBlocks}
          >
            {seg.value}
          </Markdown>
        ) : null,
      )}
    </>
  );
});

interface FeedItemViewProps {
  item: FeedItem;
  live: boolean;
  autoPlayAppBlocks?: boolean;
  // True while the whole turn is still streaming, regardless of where this item
  // sits. Subagent waves need this rather than `live`: work continues after the
  // wave stops being the last item (a plan update or assistant text follows it),
  // and treating that as settled froze the card on "Never started".
  sessionLive?: boolean;
  compacting?: boolean;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  openDiffLabel?: string;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  // Store child sessions + models for the subagents dock. Every child_sessions
  // wave item resolves its own subset from this list and renders one card per
  // wave. Wave items only exist when this is set; views without it (Mission
  // Control, child-session views) get per-spawn child_session lines instead.
  subagentsDock?: SubagentsDockData;
  liveTiming?: boolean;
  specContent?: string;
  isFinalResponse?: boolean;
}

// Lets memo skip the many static items while a response streams, re-rendering
// only the growing tail.
function feedItemPropsEqual(prev: FeedItemViewProps, next: FeedItemViewProps): boolean {
  // Live-updating items (spawn lines, dock wave cards, worked groups with
  // ticking timers) always re-render. The static types never read
  // subagentsDock, so it is intentionally absent from the comparison below.
  if (
    next.item.type === 'child_session' ||
    next.item.type === 'child_sessions' ||
    next.item.type === 'worked' ||
    (next.item.type === 'activity' && next.item.active)
  )
    return false;
  return (
    prev.live === next.live &&
    prev.autoPlayAppBlocks === next.autoPlayAppBlocks &&
    prev.sessionLive === next.sessionLive &&
    prev.compacting === next.compacting &&
    prev.liveTiming === next.liveTiming &&
    prev.specContent === next.specContent &&
    prev.cwd === next.cwd &&
    prev.openDiffLabel === next.openDiffLabel &&
    prev.isFinalResponse === next.isFinalResponse &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenReviewFile === next.onOpenReviewFile &&
    prev.onOpenChildSession === next.onOpenChildSession &&
    prev.childSessionActivity === next.childSessionActivity &&
    sameFeedEvents(prev.item, next.item)
  );
}

// The feed rebuilds item objects on every streamed token, but an untouched
// wave's events keep their identity, so settled waves bail out of per-token
// re-renders. Live waves still update: the dock object changes identity when
// the store's child sessions or models change.
const ChildSessionsWave = memo(
  function ChildSessionsWave({
    item,
    dock,
    live,
    onOpen,
    activity,
  }: {
    item: Extract<FeedItem, { type: 'child_sessions' }>;
    dock: SubagentsDockData;
    live?: boolean;
    onOpen?: (target: ChildSessionTarget) => void;
    activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  }) {
    // Wave-scoped: resolve only this run's spawns so the card shows this
    // turn's agents, not the session's cumulative list.
    const sessions = useMemo(
      () => resolveWaveSessions(item.events, dock.sessions),
      [item.events, dock.sessions],
    );
    return (
      <SubagentsDock
        sessions={sessions}
        models={dock.models}
        live={live}
        onOpen={onOpen}
        activity={activity}
      />
    );
  },
  (prev, next) =>
    prev.dock === next.dock &&
    prev.live === next.live &&
    prev.onOpen === next.onOpen &&
    prev.activity === next.activity &&
    sameFeedEvents(prev.item, next.item),
);

const FeedItemView = memo(function FeedItemView({
  item,
  live,
  autoPlayAppBlocks = false,
  sessionLive,
  compacting,
  cwd,
  onOpenDiff,
  openDiffLabel,
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  liveTiming,
  specContent,
  isFinalResponse,
}: FeedItemViewProps) {
  switch (item.type) {
    case 'message': {
      if (item.event.author === 'user') return <UserBubble event={item.event} />;
      const text = item.event.text ?? '';
      // The spec is rendered in the pinned card. Suppress an assistant message
      // only when it is exactly that spec text (avoid double-rendering the same
      // plan); never hide other prose just because spec mode is active (#14).
      if (specContent && text.trim() && text.trim() === specContent.trim()) return null;
      const appOwnsLiveStatus = live && hasAppBlock(text);
      return (
        <div className="group/msg">
          <MessageBody text={text} live={live} autoPlayAppBlocks={autoPlayAppBlocks} />
          {live && !appOwnsLiveStatus ? (
            <StreamingCaret />
          ) : (
            !live &&
            isFinalResponse &&
            text.trim() && (
              <div className="mt-1.5 -ml-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
                <CopyButton text={parseTruncatedTail(text).body} />
              </div>
            )
          )}
        </div>
      );
    }
    case 'thinking':
      return (
        <ThinkingItem
          text={item.event.text ?? ''}
          durationMs={item.durationMs}
          active={live}
          startTs={liveTiming ? item.event.ts : undefined}
        />
      );
    case 'child_session':
      return (
        <ChildSessionLine
          event={item.event}
          onOpen={onOpenChildSession}
          activity={childSessionActivity?.({
            toolUseId: item.event.toolUseId,
            label: childSessionInfo(item.event.toolArgs).label,
          })}
        />
      );
    case 'child_sessions': {
      // Wave items are only built when dock data is passed (buildFeed gates on
      // it), so a missing dock here is a wiring bug; views that keep per-spawn
      // lines produce child_session items, never this case.
      if (!subagentsDock) return null;
      return (
        <ChildSessionsWave
          item={item}
          dock={subagentsDock}
          live={sessionLive}
          onOpen={onOpenChildSession}
          activity={childSessionActivity}
        />
      );
    }
    case 'status': {
      const text = item.event.text ?? '';
      if (item.event.kind === 'compaction') return <CompactionDivider compactType="auto" />;
      if (compacting) return <CompactingIndicator />;
      if (isCompactionCompleteStatus(text))
        return <CompactionDivider compactType={item.event.compactType} />;
      return live ? (
        <span className="shimmer-text text-[13px] font-medium">{text}</span>
      ) : (
        <span className="block text-[13px] text-droid-text-muted leading-relaxed break-words">
          {text}
        </span>
      );
    }
    case 'error':
      return <ErrorLine text={item.event.text ?? ''} />;
    case 'diff':
      return (
        <DiffCard
          change={item.change}
          cwd={cwd}
          openLabel={openDiffLabel}
          onOpen={
            onOpenDiff
              ? () => {
                  onOpenDiff(item.change);
                }
              : undefined
          }
        />
      );
    case 'diffs':
      return (
        <DiffGroup
          changes={item.changes}
          cwd={cwd}
          onOpenDiff={onOpenDiff}
          openLabel={openDiffLabel}
        />
      );
    case 'tools':
      return isPlanOnlyTools(item.events) ? (
        <div className="space-y-2.5">{renderToolEvents(item.events, live)}</div>
      ) : (
        <ToolGroupItem events={item.events} active={live} />
      );
    case 'turnChanges':
      return <TurnChangesPanel item={item} cwd={cwd} onOpenFile={onOpenReviewFile} />;
    case 'worked':
      return (
        <WorkedGroup
          item={item}
          cwd={cwd}
          onOpenDiff={onOpenDiff}
          openDiffLabel={openDiffLabel}
          onOpenChildSession={onOpenChildSession}
          childSessionActivity={childSessionActivity}
          subagentsDock={subagentsDock}
          specContent={specContent}
        />
      );
    case 'activity':
      return (
        <ActivityGroup
          item={item}
          cwd={cwd}
          onOpenDiff={onOpenDiff}
          openDiffLabel={openDiffLabel}
          onOpenChildSession={onOpenChildSession}
          childSessionActivity={childSessionActivity}
          subagentsDock={subagentsDock}
          specContent={specContent}
        />
      );
  }
}, feedItemPropsEqual);
function activityHeadline(summary: string): { verb: string; rest: string } {
  const space = summary.indexOf(' ');
  if (space < 0) return { verb: summary, rest: '' };
  return { verb: summary.slice(0, space), rest: summary.slice(space + 1) };
}

/* ── Compact tool activity: one Factory-style summary line, nested rows stay closed ── */
function ActivityGroup({
  item,
  cwd,
  onOpenDiff,
  openDiffLabel,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
}: {
  item: Extract<FeedItem, { type: 'activity' }>;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  openDiffLabel?: string;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  subagentsDock?: SubagentsDockData;
  specContent?: string;
}) {
  const [open, setOpen] = useState(false);
  const { verb, rest } = activityHeadline(summarizeActivity(item.items, item.active));
  const lastIdx = item.items.length - 1;
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
        <span
          className={
            item.active
              ? 'shimmer-text shrink-0 text-[13px] font-medium'
              : 'shrink-0 text-[13px] text-droid-text-secondary'
          }
        >
          {verb}
        </span>
        {rest ? (
          <span className="min-w-0 truncate text-[13px] text-droid-text-muted">{rest}</span>
        ) : null}
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-2 space-y-2.5 pl-[18px]">
            {item.items.map((child, idx) => (
              <FeedItemView
                key={child.key}
                item={child}
                live={item.active && idx === lastIdx}
                cwd={cwd}
                onOpenDiff={onOpenDiff}
                openDiffLabel={openDiffLabel}
                onOpenChildSession={onOpenChildSession}
                childSessionActivity={childSessionActivity}
                subagentsDock={subagentsDock}
                specContent={specContent}
              />
            ))}
          </div>
        ) : null}
      </Expand>
    </div>
  );
}

/* ── Worked-for group: a completed turn's steps folded into one disclosure ── */
function WorkedGroup({
  item,
  cwd,
  onOpenDiff,
  openDiffLabel,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
}: {
  item: Extract<FeedItem, { type: 'worked' }>;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  openDiffLabel?: string;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  subagentsDock?: SubagentsDockData;
  specContent?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex items-center gap-1.5 text-left"
      >
        <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">
          Worked for {formatDuration(item.durationMs)}
        </span>
        <Caret open={open} />
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-3 space-y-4 border-l border-droid-border pl-4">
            {item.items.map((child) => (
              <FeedItemView
                key={child.key}
                item={child}
                live={false}
                cwd={cwd}
                onOpenDiff={onOpenDiff}
                openDiffLabel={openDiffLabel}
                onOpenChildSession={onOpenChildSession}
                childSessionActivity={childSessionActivity}
                subagentsDock={subagentsDock}
                specContent={specContent}
              />
            ))}
          </div>
        ) : null}
      </Expand>
    </div>
  );
}

/* ── Per-agent name color: deterministic pick so each droid keeps one hue ── */
const CHILD_SESSION_COLORS = [
  '#e0a458',
  '#6ea8fe',
  '#5cc8a8',
  '#c58af9',
  '#e8728f',
  '#7bd88f',
  '#f0a06a',
  '#9d8cff',
] as const;
function childSessionColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return CHILD_SESSION_COLORS[h % CHILD_SESSION_COLORS.length];
}

/* ── In-chat spawned child session: inline thinking-style line + click to navigate ── */
function ChildSessionLine({
  event,
  onOpen,
  activity,
}: {
  event: TranscriptEvent;
  onOpen?: (target: ChildSessionTarget) => void;
  activity?: ChildSessionActivity;
}) {
  const [open, setOpen] = useState(false);
  const { label, description } = childSessionInfo(event.toolArgs);
  const name = label ?? 'child session';
  const color = childSessionColor(name);
  const running = childSessionLineIsRunning(activity);
  const startTs = activity?.startedAt;
  const elapsed = useElapsed(startTs, running);
  const timer = running && startTs != null && elapsed >= 1000 ? formatDuration(elapsed) : '';
  const verb = running ? 'Running' : 'Spawned';
  // Append the literal "child session" only when the name is a real droid label, so a
  // nameless spawn reads "Spawned child session" instead of "Spawned child session child session".
  const tail = [label ? 'child session' : '', timer].filter(Boolean).join(' ');
  const muted = running ? 'shimmer-text font-medium' : 'text-droid-text-muted';
  const latest = childSessionLatest(activity?.latest);
  const navigate = () => onOpen?.({ toolUseId: event.toolUseId, label });
  return (
    <div>
      <div className="group flex items-center gap-1.5 text-[13px]">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="flex items-center"
          aria-label="Toggle child session activity"
        >
          <Caret open={open} />
        </button>
        <span className={muted}>{verb}</span>
        <button
          type="button"
          onClick={navigate}
          className="font-semibold underline-offset-2 hover:underline"
          style={{ color }}
          title="Open child session session"
        >
          {name}
        </button>
        {tail && <span className={muted}>{tail}</span>}
      </div>
      <Expand open={open}>
        <div className="mt-2 pl-[18px]">
          {description && (
            <div className="text-[12.5px] text-droid-text-muted/70 leading-relaxed break-words">
              {description}
            </div>
          )}
          {latest && (
            <div className="mt-1.5 text-[12.5px] leading-relaxed break-words">
              <span
                className={
                  running ? 'shimmer-text font-medium' : 'text-droid-text-secondary font-medium'
                }
              >
                {latest.head}
              </span>
              {latest.body && (
                <span className="ml-1.5 font-mono text-[11.5px] text-droid-text-muted/80">
                  {latest.body}
                </span>
              )}
            </div>
          )}
          {!latest && (
            <div className="mt-1.5 text-[12px] text-droid-text-muted/60">
              No activity captured yet.
            </div>
          )}
          <button
            type="button"
            onClick={navigate}
            className="mt-2 inline-flex items-center gap-1 text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
          >
            Open session
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </Expand>
    </div>
  );
}

// Offscreen feed rows skip layout and paint entirely (content-visibility) so
// long transcripts scroll and chat switches render at the cost of the visible
// screen only. The browser keeps DOM, component state, and animation timelines
// alive: a row scrolling back in repaints the same frame with its shimmer or
// caret exactly where the shared timeline puts it, so nothing ever looks
// paused. The intrinsic-size hint sizes never-rendered rows for the scrollbar;
// 'auto' remembers each row's real height once it has been rendered.
const FEED_ROW_RENDER_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 96px',
} as const;

/* ── The activity feed (list only; parent owns the scroll container) ── */
export function MessageFeed({
  events,
  items: providedItems,
  pending,
  cwd,
  onOpenDiff,
  openDiffLabel = 'Open in Review',
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
  onOpenSpecWiki,
  createdWorktreePath,
  density,
}: {
  events: TranscriptEvent[];
  items?: FeedItem[];
  pending: boolean;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  openDiffLabel?: string;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  // When set (normal chat sessions only), the per-spawn child session lines are
  // replaced by one grouping subagents dock at the first spawn's position.
  subagentsDock?: SubagentsDockData;
  specContent?: string;
  onOpenSpecWiki?: () => void;
  createdWorktreePath?: string;
  density?: ToolActivityDensity;
}) {
  // Child session cards, waiting label, and live timers are enabled only for the
  // chat/spec feed (which supplies onOpenChildSession). Per-turn change summaries
  // are gated separately on onOpenReviewFile: Mission Control supplies
  // onOpenChildSession for its orchestrator view but has no Review tab to open
  // files in, so non-interactive Changes cards must not appear there.
  const rich = !!onOpenChildSession;
  const changes = !!onOpenReviewFile;

  // The parent rebuilds these callbacks every streaming token (they close over
  // the growing transcript). Wrap them in stable identities that read the latest
  // version through a ref, so the memoized FeedItemView can actually skip
  // unchanged items instead of re-rendering the whole feed on every token. Keep
  // them undefined when the parent supplies no handler, so absent affordances
  // (e.g. non-clickable diffs in the chat feed) stay absent.
  const cbRef = useRef({ onOpenDiff, onOpenReviewFile, onOpenChildSession, childSessionActivity });
  cbRef.current = { onOpenDiff, onOpenReviewFile, onOpenChildSession, childSessionActivity };
  const hasOpenDiff = !!onOpenDiff;
  const hasOpenReviewFile = !!onOpenReviewFile;
  const hasChildSessionActivity = !!childSessionActivity;
  const stableOnOpenDiff = useMemo(
    () => (hasOpenDiff ? (c: FileChange) => cbRef.current.onOpenDiff?.(c) : undefined),
    [hasOpenDiff],
  );
  const stableOnOpenReviewFile = useMemo(
    () => (hasOpenReviewFile ? (p: string) => cbRef.current.onOpenReviewFile?.(p) : undefined),
    [hasOpenReviewFile],
  );
  const stableOnOpenChildSession = useMemo(
    () => (rich ? (t: ChildSessionTarget) => cbRef.current.onOpenChildSession?.(t) : undefined),
    [rich],
  );
  const stableChildSessionActivity = useMemo(
    () =>
      hasChildSessionActivity
        ? (t: ChildSessionTarget) => cbRef.current.childSessionActivity?.(t)
        : undefined,
    [hasChildSessionActivity],
  );

  // With the subagents dock, each contiguous run of spawns becomes one wave
  // item: the dock card renders right where that turn spawned its agents (live
  // while the turn is in flight) and folds into the turn's Worked group once
  // the turn completes.
  const dockEnabled = !!subagentsDock;
  const items = useMemo(
    () =>
      providedItems ??
      groupTurns(
        buildFeed(events, { childSessionCards: rich, groupChildSessions: dockEnabled }),
        pending,
        specContent,
        changes,
        density,
      ),
    [providedItems, events, pending, rich, changes, specContent, dockEnabled, density],
  );
  const feedIdentity = `${events[0]?.appSessionId ?? ''}:${events[0]?.sourceSessionId ?? ''}`;
  const freshAppResponsesRef = useRef<FreshAppResponseState | null>(null);
  const freshAppResponseState = useMemo(
    () => rememberFreshAppResponses(freshAppResponsesRef.current, feedIdentity, items, pending),
    [feedIdentity, items, pending],
  );
  useEffect(() => {
    freshAppResponsesRef.current = freshAppResponseState;
  }, [freshAppResponseState]);
  const freshAppResponseTexts = freshAppResponseState.texts;
  const renderedFeedRef = useRef<{ identity: string; keys: Set<string> } | null>(null);
  const previousFeed = renderedFeedRef.current;
  useEffect(() => {
    renderedFeedRef.current = {
      identity: feedIdentity,
      keys: new Set(items.map((item) => item.key)),
    };
  }, [feedIdentity, items]);
  // Track item identity (not list index) so prepended older-history items and
  // every already-rendered item stay still; only genuinely appended tail items
  // enter with the rise animation.
  const animateKeys = appendedFeedItemKeys(items, previousFeed, feedIdentity);

  // Copy only the conversation's last assistant reply, not every turn's answer.
  const lastAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'message' && item.event.author !== 'user') return item.key;
    }
    return undefined;
  }, [items]);
  // The conversation timeline anchors a dot on each user prompt; stamp those
  // rows so the rail (driven by the same data) can scroll to them.
  const promptKeys = useMemo(
    () => new Set(promptAnchorsFromItems(items).map((a) => a.id)),
    [items],
  );
  const worktreeInsertAfter = createdWorktreePath
    ? items.findIndex((item) => item.type === 'message' && item.event.author === 'user')
    : -1;

  const lastIdx = items.length - 1;
  // Empty feeds are real (a fresh session), so the tail is genuinely optional.
  const last: FeedItem | undefined = items.length > 0 ? items[lastIdx] : undefined;
  const showSpecCard = (specContent?.length ?? 0) > 0;

  // Compaction is in progress when the latest status line announces it and no
  // completion marker has arrived yet. Drives the centered "Compacting…" shimmer.
  const compacting = last?.type === 'status' && isCompactingStatus(last.event.text);

  // A child session line or dock card self-indicates only while it is still
  // running (it shows its own "Running … <timer>"). Once everything completes,
  // the orchestrator may still be working, so let the global cue show instead
  // of looking idle.
  const lastChildSessionRunning =
    last?.type === 'child_session' &&
    childSessionActivity?.({
      toolUseId: last.event.toolUseId,
      label: childSessionInfo(last.event.toolArgs).label,
    })?.status === 'running';
  const lastDockRunning =
    last?.type === 'child_sessions' &&
    last.events.some(
      (e) =>
        childSessionActivity?.({
          toolUseId: e.toolUseId,
          label: childSessionInfo(e.toolArgs).label,
        })?.status === 'running',
    );
  // The tail already animates its own shimmer/caret for these; otherwise show an explicit cue.
  const tailSelfIndicates =
    !!last &&
    (last.type === 'thinking' ||
      last.type === 'status' ||
      last.type === 'activity' ||
      (last.type === 'child_session' && lastChildSessionRunning) ||
      (last.type === 'child_sessions' && lastDockRunning) ||
      (last.type === 'message' && last.event.author !== 'user'));
  // While the parent polls its subagents nothing in the feed represents that
  // work, so the cue speaks for it and the settled tail stops animating.
  const subagentPoll = useMemo(
    () => trailingSubagentPoll(events, dockEnabled),
    [events, dockEnabled],
  );
  // A dock tail whose children are still running already speaks for the wave
  // with its own pills, timers and total, so the poll cue would only repeat it.
  const showWorking = pending && (subagentPoll ? !lastDockRunning : !tailSelfIndicates);
  const workingLabel = subagentPoll
    ? 'Checking subagents'
    : last?.type === 'tools'
      ? 'Running'
      : last?.type === 'diff' || last?.type === 'diffs'
        ? 'Updating files'
        : 'Working';
  // Time the check from the poll itself; the visible tail can be minutes old.
  const workingStart = rich ? (subagentPoll?.ts ?? tailTimestamp(last)) : undefined;

  return (
    <div className="space-y-4">
      {showSpecCard && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <InlineSpecCard content={specContent ?? ''} onOpenWiki={onOpenSpecWiki} />
        </div>
      )}

      {items.map((item, idx) => {
        const isNewItem = animateKeys.has(item.key);
        return (
          <Fragment key={item.key}>
            <motion.div
              data-feed-row-id={feedRowId(item)}
              {...(promptKeys.has(item.key) ? { 'data-anchor-id': item.key } : {})}
              style={FEED_ROW_RENDER_STYLE}
              className={`mx-auto min-w-0 ${
                item.type === 'message' &&
                item.event.author !== 'user' &&
                hasAppBlock(item.event.text ?? '')
                  ? 'max-w-4xl'
                  : 'max-w-2xl'
              }`}
              initial={isNewItem ? { opacity: 0, y: 4 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              <FeedItemView
                item={item}
                live={pending && idx === lastIdx && !subagentPoll}
                autoPlayAppBlocks={
                  item.type === 'message' &&
                  item.event.author !== 'user' &&
                  freshAppResponseTexts.has(item.event.text ?? '')
                }
                sessionLive={pending}
                compacting={compacting && idx === lastIdx}
                cwd={cwd}
                onOpenDiff={stableOnOpenDiff}
                openDiffLabel={openDiffLabel}
                onOpenReviewFile={stableOnOpenReviewFile}
                onOpenChildSession={stableOnOpenChildSession}
                childSessionActivity={stableChildSessionActivity}
                subagentsDock={subagentsDock}
                liveTiming={rich}
                specContent={specContent}
                isFinalResponse={item.key === lastAssistantKey}
              />
            </motion.div>
            {idx === worktreeInsertAfter && createdWorktreePath && (
              <div className="mx-auto min-w-0 max-w-2xl">
                <WorktreeCreatedCard path={createdWorktreePath} />
              </div>
            )}
          </Fragment>
        );
      })}

      {showWorking && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <WorkingIndicator label={workingLabel} startTs={workingStart} />
        </div>
      )}
    </div>
  );
}

export type { TurnFile } from './TurnChangesPanel';

export {
  buildFeed,
  buildGroupedFeed,
  groupTurns,
  correlateResults,
  isResultFor,
  collectTurnFiles,
  conversationAnchors,
  promptAnchorsFromItems,
  sameFeedEvents,
  isCancellationArtifact,
  appendedFeedItemKeys,
  trailingSubagentPoll,
  childSessionLineIsRunning,
  completeAppResponsesInLatestTurn,
  rememberFreshAppResponses,
  type FeedItem,
  type GroupedFeedOptions,
  type ConversationAnchor,
} from '../lib/transcriptFeed';
