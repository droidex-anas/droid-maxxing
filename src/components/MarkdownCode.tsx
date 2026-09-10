import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Copy, WrapText } from '@droidex/icons';

const LANGUAGE_LABELS: Record<string, string> = {
  sh: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  zsh: 'Bash',
  console: 'Bash',
  shellsession: 'Bash',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  yml: 'YAML',
  yaml: 'YAML',
  md: 'Markdown',
};

function languageLabel(className?: string): string {
  const match = className?.match(/lang(?:uage)?-([\w+#.-]+)/i);
  if (!match) return 'Code';
  const language = match[1].toLowerCase();
  return LANGUAGE_LABELS[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

export async function copyMarkdownCode(
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
  text: string,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CodeCopyButton({ text }: { text: string }) {
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
      onClick={() => {
        void copyMarkdownCode(navigator.clipboard, text).then((didCopy) => {
          if (!didCopy) return;
          setCopied(true);
          clearTimeout(timer.current ?? undefined);
          timer.current = setTimeout(() => {
            setCopied(false);
          }, 1200);
        });
      }}
      className="flex items-center gap-1 text-[10.5px] text-droid-text-muted hover:text-droid-text transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/* ── JSON token highlighting ──
   Per-token spans are fine for a snippet and a long task for a dumped payload. */
export const JSON_HIGHLIGHT_MAX_CHARS = 8_192;

export function HighlightJson({ code }: { code: string }) {
  const nodes = useMemo(() => {
    const tokens = code.split(
      /("(?:\\.|[^"\\])*"|:|true|false|null|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[[\]{}!,])/g,
    );
    return tokens.map((token, i) => {
      if (/^"(?:\\.|[^"\\])*"$/.exec(token)) {
        const next = tokens[i + 1].trimStart();
        if (next.startsWith(':')) {
          return (
            <span key={i} style={{ color: 'var(--droid-accent)' }}>
              {token}
            </span>
          );
        }
        return (
          <span key={i} style={{ color: 'var(--droid-green)' }}>
            {token}
          </span>
        );
      }
      if (token === 'true' || token === 'false')
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (token === 'null')
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      if (/^\d/.exec(token))
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (/^[{}[\],:!]$/.test(token))
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      return <span key={i}>{token}</span>;
    });
  }, [code]);

  return <>{nodes}</>;
}

/* ── Code card chrome ──
   The reader controls the frame: copy stays, soft-wrap tames long lines at the
   cost of the gutter, and blocks past COLLAPSE_LINE_THRESHOLD lines start
   folded so one giant dump stops eating the transcript. */

const COLLAPSE_LINE_THRESHOLD = 24;
const COLLAPSED_LINES = 12;
// Numbers earn their place once a block is long enough to be scrolled.
const GUTTER_MIN_LINES = 4;

function LineGutter({ count, specMode }: { count: number; specMode: boolean }) {
  return (
    <div
      aria-hidden
      className={`select-none shrink-0 border-r border-droid-border/50 pr-2.5 mr-3 text-right font-mono text-droid-text-muted/70 leading-[1.65] ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

// The header's right-hand cluster: the reader-facing controls over the block's
// frame. The language label stays with the card; these travel with their state.
function CardControls({
  collapsible,
  collapsed,
  wrapped,
  onToggleCollapse,
  onToggleWrap,
  code,
}: {
  collapsible: boolean;
  collapsed: boolean;
  wrapped: boolean;
  onToggleCollapse: () => void;
  onToggleWrap: () => void;
  code: string;
}) {
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      {collapsible && (
        <button
          onClick={onToggleCollapse}
          className="text-[10.5px] text-droid-text-muted hover:text-droid-text transition-colors"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      )}
      <button
        onClick={onToggleWrap}
        className={`transition-colors ${wrapped ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text'}`}
        title={wrapped ? 'Disable soft wrap' : 'Soft wrap long lines'}
        aria-pressed={wrapped}
      >
        <WrapText className="w-3 h-3" />
      </button>
      <CodeCopyButton text={code} />
    </div>
  );
}

export function CodeCard({
  code,
  className,
  specMode,
  highlighted,
}: {
  code: string;
  className?: string;
  specMode?: boolean;
  highlighted?: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(false);
  const lines = useMemo(() => code.split('\n'), [code]);
  // Decided at mount only: a fence that streams past the threshold keeps the
  // reader's expanded view instead of folding under their hands.
  const [collapsed, setCollapsed] = useState(() => lines.length > COLLAPSE_LINE_THRESHOLD);
  const showGutter = !wrapped && !collapsed && lines.length >= GUTTER_MIN_LINES;
  const fontSize = specMode ? 13 : 12;
  const padding = specMode ? 16 : 14;
  const collapsedMaxHeight = `calc(${String(fontSize)}px * 1.65 * ${String(COLLAPSED_LINES)} + ${String(padding)}px * 2)`;
  const toggleWrap = () => {
    setWrapped((v) => !v);
  };
  const toggleCollapse = () => {
    setCollapsed((v) => !v);
  };
  const expand = () => {
    setCollapsed(false);
  };

  return (
    <div
      className={`rounded-xl border border-droid-border overflow-hidden bg-droid-elevated/40 ${specMode ? 'my-4' : 'my-2.5'}`}
    >
      <div className="flex items-center justify-between gap-2 h-7 px-3 bg-droid-surface/60 border-b border-droid-border">
        <span className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted truncate">
          {languageLabel(className)}
        </span>
        <CardControls
          collapsible={lines.length > COLLAPSE_LINE_THRESHOLD}
          collapsed={collapsed}
          wrapped={wrapped}
          onToggleCollapse={toggleCollapse}
          onToggleWrap={toggleWrap}
          code={code}
        />
      </div>
      <div className="relative">
        <pre
          className={`scrollbar-on-hover scroll-fade-x overflow-x-auto flex ${specMode ? 'p-4' : 'p-3.5'}`}
          style={collapsed ? { maxHeight: collapsedMaxHeight, overflowY: 'hidden' } : undefined}
        >
          {showGutter && <LineGutter count={lines.length} specMode={Boolean(specMode)} />}
          <code
            className={`font-mono leading-[1.65] text-droid-text-secondary ${wrapped ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'} ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
          >
            {highlighted ?? code}
          </code>
        </pre>
        {collapsed && (
          <button
            onClick={expand}
            className="absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-gradient-to-t from-droid-bg/95 via-droid-bg/70 to-transparent text-[11px] font-medium text-droid-text-secondary hover:text-droid-text transition-colors"
          >
            Show all {String(lines.length)} lines
          </button>
        )}
      </div>
    </div>
  );
}
