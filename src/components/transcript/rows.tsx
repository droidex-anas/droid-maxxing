import { useState } from 'react';
import { Check } from 'lucide-react';
import type { TranscriptEvent } from '../../types/bridge';
import {
  describeToolCall,
  toolMeta,
  safeJson,
  stripAnsi,
  formatDuration,
  parseTodos,
  isWebSearchTool,
  isWebFetchTool,
  toolArgString,
  type ToolCallLabel,
  type TodoStatus,
} from '../../lib/tools';
import type { OpenReviewFileHandler } from '../../lib/reviewFocus';
import { classifyEvent } from '../../lib/transcript';
import { compactPath } from '../../lib/pathDisplay';
import { StreamingCaret } from '../StreamingCaret';
import {
  Caret,
  ErrorTag,
  Expand,
  firstLine,
  linkify,
  RED,
  RED_TINT,
  useElapsed,
} from './primitives';
import { CommandCard, CommandLine, ToolCallCard } from './commandCard';
import { LinkBadge } from './LinkBadge';
import { useToolSourceMark } from './toolSourceMark';
import { WebFetchCard, WebSearchCard } from './webCards';

/* ── Thinking / Thought ── */
export function ThinkingItem({
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
        aria-expanded={open}
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
        <div className="mt-2 pl-[18px] text-[13px] text-droid-text-muted/55 leading-[1.7] whitespace-pre-wrap break-words">
          {text}
          {active && <StreamingCaret />}
        </div>
      </Expand>
    </div>
  );
}

/* ── Activity summaries ── */

interface ActivityCounts {
  editedPaths: Set<string>;
  // The one file read when exactly one was, so the fold can name it.
  readFile?: string;
  file: number;
  search: number;
  command: number;
  page: number;
  task: number;
  step: number;
  plan: number;
  onlyExec: boolean;
  onlyWeb: boolean;
  onlyPlan: boolean;
  sawCall: boolean;
}

function emptyCounts(): ActivityCounts {
  return {
    editedPaths: new Set(),
    file: 0,
    search: 0,
    command: 0,
    page: 0,
    task: 0,
    step: 0,
    plan: 0,
    onlyExec: true,
    onlyWeb: true,
    onlyPlan: true,
    sawCall: false,
  };
}

function countToolCall(counts: ActivityCounts, e: TranscriptEvent): void {
  counts.sawCall = true;
  // A TodoWrite is internal plan bookkeeping, not a file/command, so it must
  // not inflate the "Explored N files" summary (#20).
  if (classifyEvent(e) === 'plan_update') {
    counts.plan++;
    counts.onlyExec = false;
    counts.onlyWeb = false;
    return;
  }
  counts.onlyPlan = false;
  const { cat, detail } = toolMeta(e.toolName, e.toolArgs);
  if (cat !== 'exec') counts.onlyExec = false;
  if (cat !== 'web') counts.onlyWeb = false;
  if (cat === 'read') {
    counts.file++;
    // A lone read is named only when it read a file; a listed directory is
    // still "1 file", never "Explored src".
    if (/\.[A-Za-z0-9]{1,8}$/.test(detail)) counts.readFile = detail;
  } else if (cat === 'search') counts.search++;
  else if (cat === 'exec') counts.command++;
  else if (cat === 'web') counts.page++;
  else if (cat === 'task') counts.task++;
  else if (cat === 'skill') counts.step++;
  else counts.step++;
}

function formatCounts(counts: ActivityCounts): string {
  const parts: string[] = [];
  const add = (n: number, s: string, p: string) => {
    if (n > 0) parts.push(`${String(n)} ${n === 1 ? s : p}`);
  };
  if (counts.file === 1 && counts.readFile) parts.push(compactPath(counts.readFile));
  else add(counts.file, 'file', 'files');
  add(counts.search, 'search', 'searches');
  add(counts.command, 'command', 'commands');
  add(counts.page, 'page', 'pages');
  add(counts.task, 'task', 'tasks');
  add(counts.step, 'step', 'steps');
  add(counts.plan, 'plan update', 'plan updates');
  const verb = counts.onlyExec ? 'Ran' : counts.onlyWeb ? 'Fetched' : 'Explored';
  return `${verb} ${parts.join(', ')}`;
}

/* ── Condensed tool group: "Explored 4 files, 1 search" ── */
export function summarizeTools(events: TranscriptEvent[]): string {
  const counts = emptyCounts();
  for (const e of events) {
    if (e.kind === 'tool_call') countToolCall(counts, e);
  }
  if (!counts.sawCall) return 'Tool result';
  if (counts.onlyPlan) return 'Updated plan';
  return formatCounts(counts);
}

// A standalone failed result (or a pure error event) rendered as a collapsible
// row: a red "error" tag with the first line, expanding to the full message.
export function ErrorLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = stripAnsi(text).trim();
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[13px] leading-relaxed"
        aria-expanded={open}
      >
        <Caret open={open} />
        <span className="min-w-0 truncate text-droid-text-muted">{firstLine(body)}</span>
        <ErrorTag />
      </button>
      <Expand open={open}>
        <div className="mt-1.5 pl-[18px]">
          <pre
            className="max-h-56 overflow-auto rounded-md px-2.5 py-2 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words"
            style={{ backgroundColor: RED_TINT, color: RED }}
          >
            {linkify(body)}
          </pre>
        </div>
      </Expand>
    </div>
  );
}

// The row's object: a path opens in Review when the transcript can, anything
// else is plain text. Paths compact to their tail with the directory dimmed so
// the file name carries the line.
function ToolTarget({
  call,
  onOpenReviewFile,
}: {
  call: ToolCallLabel;
  onOpenReviewFile?: OpenReviewFileHandler;
}) {
  if (call.objectKind === 'none') return null;
  if (call.objectKind !== 'path') {
    return <span className="min-w-0 truncate text-droid-text-muted">{call.object}</span>;
  }
  const shown = compactPath(call.object);
  const slash = shown.lastIndexOf('/');
  const dir = slash >= 0 ? shown.slice(0, slash + 1) : '';
  const name = slash >= 0 ? shown.slice(slash + 1) : shown;
  const parts = (
    <>
      {dir && <span className="text-droid-text-muted/50">{dir}</span>}
      <span className="text-droid-text-muted transition-colors group-hover/path:text-droid-text">
        {name}
      </span>
    </>
  );
  if (!onOpenReviewFile) return <span className="min-w-0 truncate">{parts}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenReviewFile(call.object);
      }}
      title={`Open ${call.object} in Review`}
      className="group/path min-w-0 truncate text-left"
    >
      {parts}
    </button>
  );
}

// One tool call as a sentence: "Read src/app.tsx", "Searched src", or a
// readable tool name. In flight the verb shimmers in its live form; a body
// (captured output or the error) sits behind the caret.
function ToolLine({
  event,
  output,
  error = false,
  running = false,
  forceOpen = false,
  onOpenReviewFile,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  running?: boolean;
  forceOpen?: boolean;
  onOpenReviewFile?: OpenReviewFileHandler;
}) {
  const call = describeToolCall(event.toolName, event.toolArgs);
  const out = output ? stripAnsi(output).trimEnd() : '';
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen;
  const hasBody = out.length > 0;
  // An MCP tool wears its server's mark instead of spelling its source.
  const mark = useToolSourceMark(call.source);
  const verb = (
    <span className="flex shrink-0 items-center">
      {mark && <LinkBadge link={mark} />}
      {running ? (
        <span className="shimmer-text font-medium">{call.liveVerb}</span>
      ) : (
        <span className="text-droid-text-secondary">{call.verb}</span>
      )}
    </span>
  );
  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-relaxed">
        {hasBody ? (
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
            }}
            aria-expanded={expanded}
            className="group flex shrink-0 items-center gap-1.5 text-left"
          >
            <Caret open={expanded} />
            {verb}
          </button>
        ) : (
          <>
            {/* Caret-width spacer keeps the label flush with the expandable rows. */}
            <span className="w-3 shrink-0" aria-hidden="true" />
            {verb}
          </>
        )}
        <ToolTarget call={call} onOpenReviewFile={onOpenReviewFile} />
        {call.source && !mark && (
          <span className="shrink-0 text-droid-text-muted/60">· {call.source}</span>
        )}
        {error && <ErrorTag />}
      </div>
      {hasBody && (
        <Expand open={expanded}>
          <div className="mt-1.5 pl-[18px]">
            <ToolCallCard
              heading={
                <pre className="whitespace-pre-wrap break-words text-droid-text">
                  {safeJson(event.toolArgs)}
                </pre>
              }
              output={out}
              error={error}
            />
          </div>
        </Expand>
      )}
    </div>
  );
}

// Same ring language as the composer's plan strip: filled when done, a ring
// otherwise, with the running step's ring in the text colour.
function TodoMark({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return (
      <span className="mt-[5px] flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-droid-text-muted">
        <Check className="h-2 w-2 text-droid-bg" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={`mt-[5px] h-3 w-3 shrink-0 rounded-full border-[1.5px] ${
        status === 'in_progress' ? 'border-droid-text' : 'border-droid-text-muted/40'
      }`}
    />
  );
}

function TodoChecklist({ event }: { event: TranscriptEvent }) {
  const todos = parseTodos(event.toolArgs);
  if (todos.length === 0)
    return <div className="text-[13px] text-droid-text-secondary">Updated plan</div>;
  return (
    <div className="space-y-1">
      {todos.map((t, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 text-[13px] leading-relaxed break-words ${
            t.status === 'completed'
              ? 'text-droid-text-muted line-through'
              : 'text-droid-text-secondary'
          }`}
        >
          <TodoMark status={t.status} />
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
  let unmatchedIdlessCalls = 0;
  for (let i = 0; i < events.length; i++) {
    const call = events[i];
    if (call.kind === 'tool_result' && !call.toolUseId) {
      unmatchedIdlessCalls = Math.max(0, unmatchedIdlessCalls - 1);
    }
    if (call.kind !== 'tool_call') continue;
    let result: TranscriptEvent | undefined;
    if (call.toolUseId) {
      result = resultById.get(call.toolUseId);
    } else {
      unmatchedIdlessCalls++;
      const next = events.at(i + 1);
      // Multiple outstanding calls cannot be correlated safely without IDs.
      if (unmatchedIdlessCalls === 1 && next?.kind === 'tool_result' && !next.toolUseId) {
        result = next;
      }
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

// Render one tool group's calls as readable rows. `detailed` shows bodies
// inline (the detailed density); otherwise rows are lines that expand to their
// bodies on click.
export function renderToolEvents(
  events: TranscriptEvent[],
  live = false,
  detailed = false,
  onOpenReviewFile?: OpenReviewFileHandler,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const { resultByCall, consumed } = correlateResults(events);
  for (const e of events) {
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
            forceOpen={detailed}
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
            forceOpen={detailed}
          />,
        );
      } else if (cat === 'exec') {
        const command =
          toolArgString(e.toolArgs, 'command') ??
          toolArgString(e.toolArgs, 'cmd') ??
          toolArgString(e.toolArgs, 'script') ??
          detail;
        // Detailed density shows the terminal body inline; other densities keep
        // a one-line row that expands to it (a live call shimmers until done).
        nodes.push(
          detailed ? (
            <CommandCard
              key={e.id}
              command={command}
              output={result?.text}
              error={isError}
              running={running}
            />
          ) : (
            <CommandLine
              key={e.id}
              command={command}
              output={result?.text}
              error={isError}
              running={running}
              forceOpen={false}
            />
          ),
        );
      } else {
        nodes.push(
          <ToolLine
            key={e.id}
            event={e}
            output={result?.text}
            error={isError}
            running={running}
            forceOpen={detailed}
            onOpenReviewFile={onOpenReviewFile}
          />,
        );
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
        className="max-h-48 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[12px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap break-words"
      >
        {linkify(body)}
      </pre>,
    );
  }
  return nodes;
}
