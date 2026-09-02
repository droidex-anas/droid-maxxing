import {
  useMemo,
  useState,
  memo,
  useEffect,
  useRef,
  type ComponentType,
  type RefObject,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Blocks,
  ChevronRight,
  Terminal,
  Copy,
  Check,
  FileText,
  Expand as ExpandIcon,
  FoldVertical,
  MousePointer2,
  PenLine,
  Globe,
  AlertTriangle,
} from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../types/bridge';
import { Markdown } from './Markdown';
import { hasAppBlock } from './appBlockRuntime';
import { SpecRenderer } from './SpecRenderer';
import {
  MAX_DIFF_CARDS_PER_COMMIT,
  createDiffDisclosure,
  mountNextRevealedDiffCards,
  reopenDiffDisclosure,
  revealNextDiffCards,
  type FileChange,
} from '../lib/diff';
import { ImageAttachmentChip } from './media/ImageAttachmentChip';
import { FileChip } from './composer/FileChip';
import { isImagePath } from '../lib/localImage';
import { promptDisplayParts } from '../lib/composePrompt';
import { userMessageAttachments } from '../lib/promptMentions';
import { VisualizeIcon } from './icons/VisualizeIcon';
import { DiffCard } from './DiffView';
import { SubagentsDock, type SubagentsDockData } from './SubagentsDock';
import TurnChangesPanel from './TurnChangesPanel';
import {
  CAT_ICON,
  CAT_LABEL,
  toolMeta,
  safeJson,
  stripAnsi,
  formatDuration,
  childSessionInfo,
  parseTodos,
  isWebSearchTool,
  isWebFetchTool,
  parseWebSearch,
  parseWebFetch,
  looksLikeHtml,
  formatCharCount,
  webSourceName,
  faviconUrl,
  toolArgStringArray,
} from '../lib/tools';
import {
  copyTextForCommand,
  copyTextForMessage,
} from '../features/transcript-reach/transcriptCopy';
import { classifyEvent } from '../lib/transcript';
import {
  childSessionLatest,
  resolveWaveSessions,
  type ChildSessionActivity,
  type ChildSessionTarget,
} from '../lib/childSessions';
import { openExternal } from '../lib/onboarding';
import { useDocumentVisible } from '../hooks/useDocumentVisible';
import type { ConversationViewportLayout } from '../hooks/conversationViewportAnchor';
import { asChunkedSequence } from '../lib/chunkedSequence';
import { ConversationList, type ConversationListHandle } from './ConversationList';
import { takeFeedRowEntrance } from './conversationListState';
import { MessageBody } from './MessageBody';
import { FeedRow, optionalFeedRowProps, type FeedRowsSharedProps } from './messageFeedRows';
import { StreamingCaret } from './StreamingCaret';
import { WorktreeCreatedCard } from './WorktreeCreatedCard';
import {
  appendedFeedItemKeysFromProjection,
  projectFinalResponseKeys,
  rememberFreshAppResponses,
  type FinalResponseKeyState,
  type FreshAppResponseState,
} from './messageFeedState';
import {
  buildFeed,
  isCompactingStatus,
  isCompactionCompleteStatus,
  type FeedItem,
} from './chatFeed';
import { groupTurns, tailTimestamp, trailingSubagentPoll } from './chatFeedTurns';

export { StreamingCaret } from './StreamingCaret';

// Open a link in the OS default browser rather than inside the Electron window.
function openLink(e: React.MouseEvent, url: string) {
  e.preventDefault();
  void openExternal(url);
}

// Only http(s) URLs are safe as an href. Parsed web-search results can carry a
// malformed or non-http token, and onClick alone does not cover middle-click or
// "open in new tab" from the context menu, so a bad URL must never reach href.
function httpHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}

const ACCENT = 'var(--droid-accent)';
const EASE = [0.16, 1, 0.3, 1] as const;

/* ── Live elapsed-time hook: ticks while active and visible. ── */
function useElapsed(startTs: number | undefined, active: boolean): number {
  const visible = useDocumentVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active, visible]);
  return startTs != null ? Math.max(0, now - startTs) : 0;
}

/* ── Working indicator — minimal shimmer label, no icons/dots/bars ── */
export function WorkingIndicator({
  label = 'Working',
  startTs,
}: {
  label?: string;
  startTs?: number;
}) {
  const elapsed = useElapsed(startTs, true);
  const suffix = startTs != null && elapsed >= 1000 ? ` ${formatDuration(elapsed)}` : '';
  return (
    <span className="shimmer-text text-[13px] font-medium tracking-tight" aria-live="polite">
      {label}
      {suffix}…
    </span>
  );
}

/* ── Loading skeleton — animated neutral shimmer blocks that stand in for an
   assistant reply while a transcript restores or a fresh turn spins up. Tones
   come only from the grayscale token scale (see .skeleton-block in index.css). ── */
function SkeletonLine({ width }: { width: string }) {
  return <div className="skeleton-block h-3" style={{ width }} />;
}

export function ChatSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <SkeletonLine width="92%" />
      <SkeletonLine width="84%" />
      <SkeletonLine width="67%" />
    </div>
  );
}

// A couple of stacked reply blocks so a restoring conversation reads like
// content is streaming in, not like an empty or broken view.
export function TranscriptSkeleton() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <ChatSkeleton />
      <div className="space-y-2.5">
        <SkeletonLine width="38%" />
        <SkeletonLine width="88%" />
        <SkeletonLine width="74%" />
      </div>
    </div>
  );
}

/* ── Compaction indicator — centered, larger shimmer while compacting ── */
export function CompactingIndicator() {
  return (
    <div className="flex justify-center py-3">
      <span className="shimmer-text text-[16px] font-semibold tracking-tight" aria-live="polite">
        Compacting…
      </span>
    </div>
  );
}

/* ── Compaction divider — persistent marker once compaction has completed ── */
export function CompactionDivider({ compactType }: { compactType?: 'auto' | 'manual' }) {
  const manual = compactType === 'manual';
  const label = manual ? 'Session compacted' : 'Context automatically compacted';
  return (
    <div
      className={`flex items-center gap-3 py-1 ${manual ? 'text-droid-text-secondary' : 'text-droid-text-muted'}`}
    >
      <div className="h-px flex-1 bg-droid-border/70" />
      <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        <FoldVertical className="h-3.5 w-3.5" />
        {label}
      </span>
      <div className="h-px flex-1 bg-droid-border/70" />
    </div>
  );
}

/* ── Subtle expand affordance ── */
function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`}
    />
  );
}

/* ── Animated expand/collapse, no chrome ── */
function Expand({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="overflow-hidden"
          style={{ contain: 'layout paint' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
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
function summarizeTools(events: TranscriptEvent[]): string {
  const calls = events.filter((e) => e.kind === 'tool_call');
  if (calls.length === 0) return 'Tool result';
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
  if (onlyPlan) return 'Updated plan';
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
  const verb = onlyExec ? 'Ran' : onlyWeb ? 'Fetched' : 'Explored';
  return `${verb} ${parts.join(', ')}`;
}

function argStr(args: unknown, key: string): string | undefined {
  if (args && typeof args === 'object') {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      clearTimeout(timer.current ?? undefined);
    },
    [],
  );
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopied(false);
        }, 1200);
      }}
      title="Copy"
      className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// Turn bare URLs in captured tool output into clickable links, so a web search
// or page fetch shows the links it visited and the user can open them.
const URL_RE = /(https?:\/\/[^\s<>()[\]"'`]+)/g;
function linkify(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    let url = m[0];
    const tail = /[.,;:!?)\]}]+$/.exec(url)?.[0] ?? '';
    if (tail) url = url.slice(0, url.length - tail.length);
    nodes.push(
      <a
        key={m.index}
        href={url}
        onClick={(e) => {
          openLink(e, url);
        }}
        className="underline underline-offset-2 hover:opacity-80 break-all"
        style={{ color: ACCENT }}
      >
        {url}
      </a>,
    );
    if (tail) nodes.push(tail);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : text;
}

const RED = 'var(--droid-red)';
const RED_TINT = 'color-mix(in srgb, var(--droid-red) 8%, transparent)';

// A small red "error" pill shown on the right of a failed tool's header row.
function ErrorTag() {
  return (
    <span
      className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--droid-red) 15%, transparent)',
        color: RED,
      }}
    >
      error
    </span>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.trim();
}

// A standalone failed result (or a pure error event) rendered as a collapsible
// row: a red "error" tag with the first line, expanding to the full message.
function ErrorLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = stripAnsi(text).trim();
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] leading-relaxed"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: RED }} />
        <span className="min-w-0 truncate text-droid-text-muted">{firstLine(body)}</span>
        <ErrorTag />
        <Caret open={open} />
      </button>
      <Expand open={open}>
        {open ? (
          <pre
            className="mt-1.5 max-h-56 overflow-auto rounded-md px-2.5 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words"
            style={{ backgroundColor: RED_TINT, color: RED }}
          >
            {linkify(body)}
          </pre>
        ) : null}
      </Expand>
    </div>
  );
}

/* ── Terminal-style command card ── */
function CommandCard({
  command,
  output,
  title,
  error = false,
}: {
  command: string;
  output?: string;
  title?: string;
  error?: boolean;
}) {
  const out = output ? stripAnsi(output).trimEnd() : '';
  const [open, setOpen] = useState(false);
  const body = (
    <div className="px-3.5 py-3 font-mono text-[11.5px] leading-[1.6]">
      <div className="flex gap-2 break-words">
        <span className="select-none text-droid-text-muted" style={{ color: error ? RED : ACCENT }}>
          $
        </span>
        <span className="whitespace-pre-wrap text-droid-text">{command}</span>
      </div>
      {out && (
        <pre
          className="mt-2.5 pt-2.5 border-t border-droid-border/60 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] break-words"
          style={error ? { color: RED } : undefined}
        >
          {error ? out : linkify(out)}
        </pre>
      )}
    </div>
  );
  // A failed command collapses to a compact header with an "error" tag; expand
  // to inspect the command and its error output.
  if (error) {
    return (
      <div
        className="rounded-xl border overflow-hidden bg-droid-bg/40"
        style={{ borderColor: 'color-mix(in srgb, var(--droid-red) 30%, var(--droid-border))' }}
      >
        <button
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="group flex w-full items-center gap-2 h-8 px-3 bg-droid-surface/60 border-b border-droid-border text-left"
        >
          <Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: RED }} />
          <span className="min-w-0 truncate text-[10.5px] font-medium uppercase tracking-wider text-droid-text-muted">
            {title || 'Terminal'}
          </span>
          <ErrorTag />
          <Caret open={open} />
        </button>
        <Expand open={open}>{open ? body : null}</Expand>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-droid-border overflow-hidden bg-droid-bg/40">
      <div className="flex items-center gap-2 h-8 px-3 bg-droid-surface/60 border-b border-droid-border">
        <Terminal className="w-3.5 h-3.5 text-droid-text-muted shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wider text-droid-text-muted">
          {title || 'Terminal'}
        </span>
        <CopyButton text={copyTextForCommand(command, output)} />
      </div>
      {body}
    </div>
  );
}

function ToolLine({
  event,
  output,
  error = false,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
}) {
  const { cat, detail } = toolMeta(event.toolName, event.toolArgs);
  const Icon = CAT_ICON[cat];
  const out = output ? stripAnsi(output).trimEnd() : '';
  const raw = detail || event.toolName || '';
  const slash = raw.lastIndexOf('/');
  const looksLikePath = slash > 0 && !raw.includes(' ');
  const dir = looksLikePath ? raw.slice(0, slash + 1) : '';
  const name = looksLikePath ? raw.slice(slash + 1) : raw;
  const [open, setOpen] = useState(false);
  const label = (
    <>
      <Icon
        className={`w-3.5 h-3.5 shrink-0 ${error ? '' : 'text-droid-text-muted'}`}
        style={error ? { color: RED } : undefined}
      />
      <span className="text-droid-text-secondary shrink-0">{CAT_LABEL[cat]}</span>
      {raw && (
        <span className="font-mono text-[11.5px] min-w-0 truncate">
          {dir && <span className="text-droid-text-muted/50">{dir}</span>}
          <span className="text-droid-text-muted">{name}</span>
        </span>
      )}
    </>
  );
  // A failed tool collapses to its header row with an "error" tag; expand to
  // read the error output.
  if (error) {
    return (
      <div>
        <button
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="group flex w-full items-center gap-1.5 text-[12.5px] leading-relaxed min-w-0 text-left"
        >
          {label}
          <ErrorTag />
          <Caret open={open} />
        </button>
        {out && (
          <Expand open={open}>
            {open ? (
              <pre
                className="mt-1.5 max-h-56 overflow-auto rounded-md px-2.5 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words"
                style={{ backgroundColor: RED_TINT, color: RED }}
              >
                {out}
              </pre>
            ) : null}
          </Expand>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[12.5px] leading-relaxed min-w-0">{label}</div>
      {/* web/fetch tools render via WebFetchCard; keep a collapsible dump only
          for generic search/other tools that still land here. */}
      {(cat === 'other' || cat === 'search') && out && (
        <pre className="mt-1.5 max-h-44 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap break-words">
          {linkify(out)}
        </pre>
      )}
    </div>
  );
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  if (failed || !src) return <Globe className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-3.5 w-3.5 shrink-0 rounded-sm"
      onError={() => {
        setFailed(true);
      }}
    />
  );
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
      className={`block rounded-lg px-3 py-2 transition-colors hover:bg-droid-elevated/60 ${
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
        <div className="mt-1.5 flex items-center gap-1.5">
          <Favicon url={url} />
          <span className="truncate text-[11px] text-droid-text-secondary">
            {webSourceName(url)}
          </span>
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
function WebToolRunningRow({
  icon,
  label,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {icon}
      <span className="shimmer-text shrink-0 text-[12.5px] font-medium">{label}</span>
      {detail ? (
        <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-muted">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function WebSearchRunningRow({ isX, query }: { isX: boolean; query: string }) {
  return (
    <WebToolRunningRow
      icon={
        isX ? (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] font-bold leading-none text-droid-text-muted">
            𝕏
          </span>
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        )
      }
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
function WebSearchCard({
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
      <div className="mt-2 space-y-1">
        {results.map((r, i) => (
          <WebSourceRow
            key={`${r.url}-${String(i)}`}
            title={r.title}
            snippet={r.snippet}
            url={r.url}
            emphasize={i === 0}
          />
        ))}
      </div>
    );
  } else if (open && raw) {
    body = (
      <pre className="mt-1.5 max-h-44 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap break-words">
        {linkify(raw)}
      </pre>
    );
  }

  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        {isX ? (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] font-bold leading-none text-droid-text-muted">
            𝕏
          </span>
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        )}
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">
          {isX ? 'Searched X' : 'Searched web'}
        </span>
        {query ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-muted">
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
    <div className="mt-2 space-y-1">
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
    <WebToolRunningRow
      icon={
        url.length > 0 ? (
          <Favicon url={url} />
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        )
      }
      label="Fetching…"
      detail={url.length > 0 ? url : undefined}
    />
  );
}

function fetchTrailing(error: boolean, badge: string | null): React.ReactNode {
  if (error) return <ErrorTag />;
  if (badge) return <CountBadge label={badge} />;
  return null;
}

/* ── Page fetch: same card language as web search (favicon, source, title,
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
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        {url.length > 0 ? (
          <Favicon url={url} />
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        )}
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">Fetched</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-muted">
          {url.length > 0 ? url : displayTitle}
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

function TodoChecklist({ event }: { event: TranscriptEvent }) {
  const todos = parseTodos(event.toolArgs);
  if (todos.length === 0)
    return <div className="text-[12.5px] text-droid-text-secondary">Updated plan</div>;
  const mark = { completed: '✓', in_progress: '◐', pending: '○' } as const;
  return (
    <div className="space-y-1">
      {todos.map((t, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 text-[12.5px] leading-relaxed break-words ${
            t.status === 'completed'
              ? 'text-droid-text-muted line-through'
              : 'text-droid-text-secondary'
          }`}
        >
          <span className="select-none text-droid-text-muted">{mark[t.status]}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// Pair each tool_call with its tool_result across the whole group. Results
// correlate by toolUseId wherever they sit (replayed transcripts batch several
// calls before their results, so the result is often not adjacent); id-less
// live results fall back to the call they immediately follow. Returns the
// inline output for non-plan calls plus the set of results already accounted
// for, so the renderer never shows a correlated result a second time as raw
// activity. A plan_update's own *successful* result is consumed silently (the
// checklist conveys it); a failed one is left to surface.
export function correlateResults(events: TranscriptEvent[]): {
  resultByCall: Map<TranscriptEvent, TranscriptEvent>;
  consumed: Set<TranscriptEvent>;
} {
  const resultByCall = new Map<TranscriptEvent, TranscriptEvent>();
  const consumed = new Set<TranscriptEvent>();
  const resultById = new Map<string, TranscriptEvent>();
  for (const e of events)
    if (e.kind === 'tool_result' && e.toolUseId) resultById.set(e.toolUseId, e);
  for (let i = 0; i < events.length; i++) {
    const call = events[i];
    if (call.kind !== 'tool_call') continue;
    let result: TranscriptEvent | undefined;
    if (call.toolUseId) {
      result = resultById.get(call.toolUseId);
    } else {
      const next = events[i + 1];
      if (next?.kind === 'tool_result' && !next.toolUseId) result = next;
    }
    if (!result || consumed.has(result)) continue;
    // A failed plan result must surface (the checklist cannot convey a failure),
    // so it is left unconsumed. Every other result — success or failure —
    // attaches to its call so a failure folds into the tool card as an "error".
    if (result.isError && classifyEvent(call) === 'plan_update') continue;
    if (classifyEvent(call) !== 'plan_update') resultByCall.set(call, result);
    consumed.add(result);
  }
  return { resultByCall, consumed };
}

function renderToolEvents(events: TranscriptEvent[], live = false): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const { resultByCall, consumed } = correlateResults(events);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_call') {
      if (classifyEvent(e) === 'plan_update') {
        nodes.push(<TodoChecklist key={e.id} event={e} />);
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
          <CommandCard
            key={e.id}
            command={command}
            output={result?.text}
            title={argStr(e.toolArgs, 'summary')}
            error={isError}
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

function ToolGroupItem({
  events,
  active,
  defaultOpen = false,
}: {
  events: TranscriptEvent[];
  active?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = useMemo(() => summarizeTools(events), [events]);
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex items-center gap-1.5 text-left"
      >
        <Caret open={open} />
        {active ? (
          <span className="shimmer-text text-[13px] font-medium">{summary}</span>
        ) : (
          <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">
            {summary}
          </span>
        )}
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-2 pl-[18px] space-y-2.5">{renderToolEvents(events, active)}</div>
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

function PromptChip({
  icon: Icon,
  label,
  title,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  title?: string;
}) {
  return (
    <span
      title={title ?? label}
      className="inline-flex items-center gap-1.5 font-medium text-droid-skill"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}

export function UserBubble({
  event,
}: {
  event: Pick<TranscriptEvent, 'text' | 'skills' | 'files' | 'browserRefs' | 'steered'>;
}) {
  const browserRefs = event.browserRefs ?? [];
  // A replayed message has no files metadata, only the composed text it was sent
  // as, so attachments are recovered from its trailing @mention block.
  const message = userMessageAttachments(event.text, event.files);
  const display = promptDisplayParts(message.text, event.skills);
  const images = message.files.filter((f) => isImagePath(f));
  const files = message.files.filter((f) => !isImagePath(f));
  const hasAttachments = message.files.length > 0 || browserRefs.length > 0;
  const hasPrompt = Boolean(display.text) || display.skills.length > 0 || display.visualize;
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
            <FileChip key={f} path={f} />
          ))}
        </div>
      )}
      {hasPrompt && (
        <div className="flex max-w-[80%] flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-relaxed text-droid-text">
          {display.visualize && <PromptChip icon={VisualizeIcon} label="Visualize" />}
          {display.skills.map((skill) => (
            <PromptChip key={skill} icon={Blocks} label={skill} title={`Skill: ${skill}`} />
          ))}
          {display.text ? (
            <span className="whitespace-pre-wrap break-words">{display.text}</span>
          ) : null}
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

export interface FeedItemViewProps {
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
  // When true, nested collapsible groups (tool runs, diff runs) render expanded.
  // Set inside a "Worked for …" disclosure so opening it reveals the actual tool
  // calls and edits directly instead of a second layer of collapsed groups.
  expandGroups?: boolean;
}

// Two feed items render identically when they wrap the same underlying transcript
// event objects. The store keeps prior events referentially stable and only swaps
// the streaming tail event for a new object, so this ref check is enough: every
// other FeedItem field (diff stats, durations, summaries) is a pure function of
// these events.
export function sameFeedEvents(a: FeedItem, b: FeedItem): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === 'tools' && b.type === 'tools') {
    return a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);
  }
  if (a.type === 'diffs' && b.type === 'diffs') {
    return (
      a.changes.length === b.changes.length &&
      a.changes.every((c, i) => c.event === b.changes[i].event)
    );
  }
  if (a.type === 'child_sessions' && b.type === 'child_sessions') {
    return a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]);
  }
  // message | thinking | status | error | diff | child session each carry one event.
  return (a as { event: TranscriptEvent }).event === (b as { event: TranscriptEvent }).event;
}

// Lets memo skip the many static items while a response streams, re-rendering
// only the growing tail.
export function feedItemPropsEqual(prev: FeedItemViewProps, next: FeedItemViewProps): boolean {
  // Live-updating spawn lines and worked groups still re-render; a child_sessions
  // wave skips unless this card's events, dock (including throttled snapshots),
  // or liveness changed. Sibling feed rows compare as usual below.
  if (next.item.type === 'child_sessions') {
    return (
      prev.live === next.live &&
      prev.sessionLive === next.sessionLive &&
      prev.subagentsDock === next.subagentsDock &&
      prev.onOpenChildSession === next.onOpenChildSession &&
      prev.childSessionActivity === next.childSessionActivity &&
      sameFeedEvents(prev.item, next.item)
    );
  }
  if (next.item.type === 'child_session' || next.item.type === 'worked') return false;
  return (
    prev.live === next.live &&
    prev.autoPlayAppBlocks === next.autoPlayAppBlocks &&
    prev.sessionLive === next.sessionLive &&
    prev.compacting === next.compacting &&
    prev.liveTiming === next.liveTiming &&
    prev.specContent === next.specContent &&
    prev.cwd === next.cwd &&
    prev.isFinalResponse === next.isFinalResponse &&
    prev.expandGroups === next.expandGroups &&
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
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  liveTiming,
  specContent,
  isFinalResponse,
  expandGroups,
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
          <MessageBody
            text={text}
            live={live}
            autoPlayAppBlocks={autoPlayAppBlocks}
            cacheId={item.key}
          />
          {live && !appOwnsLiveStatus ? (
            <StreamingCaret />
          ) : (
            !live &&
            isFinalResponse &&
            text.trim() && (
              <div className="mt-1.5 -ml-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
                <CopyButton text={copyTextForMessage(text)} />
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
        <DiffGroup changes={item.changes} onOpenDiff={onOpenDiff} defaultOpen={expandGroups} />
      );
    case 'tools':
      return <ToolGroupItem events={item.events} active={live} defaultOpen={expandGroups} />;
    case 'turnChanges':
      return <TurnChangesPanel item={item} cwd={cwd} onOpenFile={onOpenReviewFile} />;
    case 'worked':
      return (
        <WorkedGroup
          item={item}
          onOpenDiff={onOpenDiff}
          onOpenChildSession={onOpenChildSession}
          childSessionActivity={childSessionActivity}
          subagentsDock={subagentsDock}
          specContent={specContent}
        />
      );
  }
}, feedItemPropsEqual);

/* ── Worked-for group: a completed turn's steps folded into one disclosure ── */
function WorkedGroup({
  item,
  onOpenDiff,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
}: {
  item: Extract<FeedItem, { type: 'worked' }>;
  onOpenDiff?: (c: FileChange) => void;
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
                onOpenDiff={onOpenDiff}
                onOpenChildSession={onOpenChildSession}
                childSessionActivity={childSessionActivity}
                subagentsDock={subagentsDock}
                specContent={specContent}
                expandGroups
              />
            ))}
          </div>
        ) : null}
      </Expand>
    </div>
  );
}

/* ── Folded run of file edits: one collapsible header over individual diffs ── */
function DiffGroup({
  changes,
  onOpenDiff,
  defaultOpen = false,
}: {
  changes: { event: TranscriptEvent; change: FileChange }[];
  onOpenDiff?: (c: FileChange) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [disclosure, setDisclosure] = useState(() => createDiffDisclosure(changes.length));
  const added = changes.reduce((s, c) => s + c.change.added, 0);
  const removed = changes.reduce((s, c) => s + c.change.removed, 0);
  const files = new Set(changes.map((c) => c.change.path));
  const edits = `${changes.length} ${changes.length === 1 ? 'edit' : 'edits'}`;
  const label =
    files.size <= 1
      ? `Edited ${baseName(changes[0].change.path)} · ${edits}`
      : `Edited ${files.size} files · ${edits}`;
  // Mount bounded chunks so neither opening nor disclosing a genuinely huge
  // edit run creates one long renderer commit. No diff content is discarded.
  const shown = changes.slice(0, disclosure.mountedCount);
  const hiddenCount = changes.length - shown.length;
  const revealCount = Math.min(MAX_DIFF_CARDS_PER_COMMIT, hiddenCount);
  const canRevealMore = hiddenCount > 0 && disclosure.mountedCount >= disclosure.revealedCount;

  useEffect(() => {
    if (!open || disclosure.mountedCount >= disclosure.revealedCount) return;
    const frame = requestAnimationFrame(() => {
      setDisclosure((current) => mountNextRevealedDiffCards(current, changes.length));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [changes.length, disclosure.mountedCount, disclosure.revealedCount, open]);

  return (
    <div>
      <button
        onClick={() => {
          if (!open) {
            setDisclosure((current) => reopenDiffDisclosure(current, changes.length));
          }
          setOpen((current) => !current);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 truncate text-[13px] font-medium text-droid-text-muted group-hover:text-droid-text-secondary">
          {label}
        </span>
        <span
          className="ml-auto text-[11px] font-mono shrink-0"
          style={{ color: 'var(--diff-add-fg)' }}
        >
          +{added}
        </span>
        <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--diff-del-fg)' }}>
          −{removed}
        </span>
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-2 space-y-2 border-l border-droid-border pl-3">
            {shown.map((c) => (
              <DiffCard
                key={c.event.id}
                change={c.change}
                onOpen={
                  onOpenDiff
                    ? () => {
                        onOpenDiff(c.change);
                      }
                    : undefined
                }
              />
            ))}
            {canRevealMore && (
              <button
                type="button"
                onClick={() => {
                  setDisclosure((current) => revealNextDiffCards(current, changes.length));
                }}
                className="text-[11px] text-droid-text-muted/70 transition-colors hover:text-droid-text-secondary"
              >
                Show next {revealCount} {revealCount === 1 ? 'edit' : 'edits'} ({hiddenCount}{' '}
                remaining)
              </button>
            )}
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

export function childSessionLineIsRunning(activity?: ChildSessionActivity): boolean {
  return activity?.status === 'running';
}

/* ── The activity feed (list only; parent owns the scroll container) ── */
export function MessageFeed({
  events,
  items: providedItems,
  pending,
  cwd,
  onOpenDiff,
  onOpenReviewFile,
  onOpenChildSession,
  childSessionActivity,
  subagentsDock,
  specContent,
  onOpenSpecWiki,
  createdWorktreePath,
  onMountedRowsChange,
  scrollElementRef,
  viewportLayoutRef,
  listRef,
  initialScrollOffset,
  updateKind = 'full',
  rebuiltFromItemIndex = 0,
}: {
  events: TranscriptEvent[];
  items?: FeedItem[];
  pending: boolean;
  cwd?: string;
  onOpenDiff?: (c: FileChange) => void;
  onOpenReviewFile?: (path: string) => void;
  onOpenChildSession?: (target: ChildSessionTarget) => void;
  childSessionActivity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
  // When set (normal chat sessions only), the per-spawn child session lines are
  // replaced by one grouping subagents dock at the first spawn's position.
  subagentsDock?: SubagentsDockData;
  specContent?: string;
  onOpenSpecWiki?: () => void;
  createdWorktreePath?: string;
  onMountedRowsChange?: (count: number) => void;
  scrollElementRef?: RefObject<HTMLElement | null>;
  viewportLayoutRef?: RefObject<ConversationViewportLayout | null>;
  listRef?: RefObject<ConversationListHandle | null>;
  initialScrollOffset?: number;
  updateKind?: 'full' | 'append' | 'prepend';
  rebuiltFromItemIndex?: number;
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
      asChunkedSequence(
        providedItems ??
          groupTurns(
            buildFeed(events, { childSessionCards: rich, groupChildSessions: dockEnabled }),
            pending,
            specContent,
            changes,
          ),
      ),
    [providedItems, events, pending, rich, changes, specContent, dockEnabled],
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
  const renderedFeedRef = useRef<{ identity: string; items: FeedItem[] } | null>(null);
  const previousFeed = renderedFeedRef.current;
  useEffect(() => {
    renderedFeedRef.current = {
      identity: feedIdentity,
      items,
    };
  }, [feedIdentity, items]);
  // Track item identity (not list index) so prepended older-history items and
  // every already-rendered item stay still; only genuinely appended tail items
  // enter with the rise animation.
  const animateKeys = appendedFeedItemKeysFromProjection(
    items,
    previousFeed,
    feedIdentity,
    updateKind,
    rebuiltFromItemIndex,
  );
  const enteredKeysRef = useRef(new Set<string>());
  const enteredIdentityRef = useRef(feedIdentity);
  if (enteredIdentityRef.current !== feedIdentity) {
    enteredKeysRef.current = new Set();
    enteredIdentityRef.current = feedIdentity;
  }

  // The copy button appears only on a turn's final model response.
  const finalResponseStateRef = useRef<FinalResponseKeyState | null>(null);
  const finalResponseState = useMemo(
    () => projectFinalResponseKeys(finalResponseStateRef.current, feedIdentity, items, updateKind),
    [feedIdentity, items, updateKind],
  );
  useEffect(() => {
    finalResponseStateRef.current = finalResponseState;
  }, [finalResponseState]);
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
  const rowSharedProps = useMemo<FeedRowsSharedProps>(
    () => ({
      pending,
      cwd,
      onOpenDiff: stableOnOpenDiff,
      onOpenReviewFile: stableOnOpenReviewFile,
      onOpenChildSession: stableOnOpenChildSession,
      childSessionActivity: stableChildSessionActivity,
      subagentsDock,
      liveTiming: rich,
      specContent,
    }),
    [
      pending,
      cwd,
      stableOnOpenDiff,
      stableOnOpenReviewFile,
      stableOnOpenChildSession,
      stableChildSessionActivity,
      subagentsDock,
      rich,
      specContent,
    ],
  );
  const optionalItemProps = optionalFeedRowProps(rowSharedProps);
  const subagentPollActive = Boolean(subagentPoll);

  return (
    <div className="space-y-4">
      {showSpecCard && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <InlineSpecCard content={specContent ?? ''} onOpenWiki={onOpenSpecWiki} />
        </div>
      )}

      <ConversationList
        items={items}
        {...(scrollElementRef !== undefined ? { scrollElementRef } : {})}
        {...(viewportLayoutRef !== undefined ? { viewportLayoutRef } : {})}
        {...(listRef !== undefined ? { listRef } : {})}
        {...(initialScrollOffset !== undefined ? { initialScrollOffset } : {})}
        {...(onMountedRowsChange !== undefined ? { onMountedRowsChange } : {})}
      >
        {(item, index) => (
          <>
            <FeedRow
              item={item}
              itemView={FeedItemView}
              areItemPropsEqual={feedItemPropsEqual}
              animateOnMount={takeFeedRowEntrance(item.key, animateKeys, enteredKeysRef.current)}
              live={pending && index === lastIdx && !subagentPollActive}
              autoPlayAppBlocks={
                item.type === 'message' &&
                item.event.author !== 'user' &&
                freshAppResponseTexts.has(item.event.text ?? '')
              }
              sessionLive={pending}
              compacting={compacting && index === lastIdx}
              {...optionalItemProps}
              liveTiming={rowSharedProps.liveTiming}
              isFinalResponse={
                finalResponseState.settledKeys.has(item.key) ||
                finalResponseState.liveKeys.has(item.key)
              }
            />
            {index === worktreeInsertAfter && createdWorktreePath ? (
              <div className="mx-auto min-w-0 max-w-2xl">
                <WorktreeCreatedCard path={createdWorktreePath} />
              </div>
            ) : null}
          </>
        )}
      </ConversationList>

      {showWorking && (
        <div className="mx-auto min-w-0 max-w-2xl">
          <WorkingIndicator label={workingLabel} startTs={workingStart} />
        </div>
      )}
    </div>
  );
}
