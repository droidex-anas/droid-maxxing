import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, FoldVertical } from 'lucide-react';
import { useDocumentVisible } from '../../hooks/useDocumentVisible';
import { formatDuration } from '../../lib/tools';
import { openExternal } from '../../lib/onboarding';

const ACCENT = 'var(--droid-accent)';
export const RED = 'var(--droid-red)';
export const RED_TINT = 'color-mix(in srgb, var(--droid-red) 8%, transparent)';

/* ── Live elapsed-time hook: ticks while active and visible. ── */
export function useElapsed(startTs: number | undefined, active: boolean): number {
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

// Open a link in the OS default browser rather than inside the Electron window.
export function openLink(e: React.MouseEvent, url: string) {
  e.preventDefault();
  e.stopPropagation();
  void openExternal(url);
}

export function httpHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/* ── Subtle expand affordance ── */
export function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`}
    />
  );
}

/* ── Animated expand/collapse, no chrome. Children stay mounted once opened so
   re-expanding is instant and inner state (scroll, selection) survives. ── */
export function Expand({ open, children }: { open: boolean; children: React.ReactNode }) {
  const cachedChildren = useRef<React.ReactNode>(null);
  const hasOpened = useRef(open);
  if (open) {
    hasOpened.current = true;
    if (children != null) cachedChildren.current = children;
  }
  const renderedChildren = hasOpened.current ? (open ? children : cachedChildren.current) : null;

  return (
    <div
      aria-hidden={!open}
      className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        open
          ? 'pointer-events-auto grid-rows-[1fr] opacity-100'
          : 'pointer-events-none grid-rows-[0fr] opacity-0'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{renderedChildren}</div>
    </div>
  );
}

/* ── Bordered panel used for expanded tool/diff bodies. ── */
export function ToolPanel({
  children,
  className = '',
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`droid-tool-panel ${className}`} style={style}>
      {children}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
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
        void navigator.clipboard.writeText(text);
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

// A small red "error" pill shown on the right of a failed tool's header row.
export function ErrorTag() {
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

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.trim();
}

// Turn bare URLs in captured tool output into clickable links, so a web search
// or page fetch shows the links it visited and the user can open them.
const URL_RE = /(https?:\/\/[^\s<>()[\]"'`]+)/g;
export function linkify(text: string): React.ReactNode {
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
