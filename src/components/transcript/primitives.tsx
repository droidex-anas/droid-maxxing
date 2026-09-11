import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronRight, FoldVertical } from 'lucide-react';
import { Copy } from '@droidex/icons';
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
  useLayoutEffect(() => {
    if (open) cachedChildren.current = children;
  }, [open, children]);
  const renderedChildren = open ? children : cachedChildren.current;

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        open
          ? 'pointer-events-auto grid-rows-[1fr] opacity-100'
          : 'pointer-events-none grid-rows-[0fr] opacity-0'
      }`}
    >
      <div
        className={`min-h-0 overflow-hidden transition-transform duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? 'translate-y-0' : '-translate-y-1.5'
        }`}
      >
        {renderedChildren}
      </div>
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
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              setCopied(false);
            }, 1200);
          },
          (error: unknown) => {
            console.warn('Copy failed', error);
          },
        );
      }}
      title="Copy"
      aria-label="Copy"
      className="shrink-0 rounded-md p-1.5 text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-border-hover"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// A small red "error" pill beside the label of a failed tool's header row.
export function ErrorTag() {
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium"
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

/* ── Working indicator — one shimmer label in a fixed line box, fading in so
   the feed's rhythm never jumps when the cue appears ── */
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
    <div className="cue-enter flex h-5 items-center">
      <span className="shimmer-text text-[13px] font-medium tracking-tight">
        <span aria-live="polite">{label}</span>
        <span aria-hidden="true">{suffix}…</span>
      </span>
    </div>
  );
}

/* ── Hover toolbar for a message. It floats over the message's free corner —
   the bottom-right of a reply, the left of a prompt bubble — so it never moves
   the text or changes the row's height, and fades in on hover or keyboard
   focus. The host must carry `group/msg relative`. ── */
export function MessageActions({ text, side }: { text: string; side: 'end' | 'start' }) {
  const place = side === 'end' ? 'bottom-0 right-0 translate-y-1/2' : 'bottom-0 right-full mr-2';
  return (
    <div
      className={`absolute ${place} flex items-center rounded-lg border border-droid-border bg-droid-surface p-0.5 shadow-sm opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/msg:opacity-100`}
    >
      <CopyButton text={text} />
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
