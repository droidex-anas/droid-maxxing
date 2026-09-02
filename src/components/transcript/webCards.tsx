import { useMemo, useState } from 'react';
import { Globe } from 'lucide-react';
import type { TranscriptEvent } from '../../types/bridge';
import { Markdown } from '../Markdown';
import {
  stripAnsi,
  parseWebSearch,
  parseWebFetch,
  looksLikeHtml,
  formatCharCount,
  webSourceName,
  faviconUrl,
  toolArgStringArray,
} from '../../lib/tools';
import { Caret, ErrorTag, Expand, httpHref, linkify, openLink, RED, RED_TINT } from './primitives';
import { argStr } from './rows';

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
function WebToolRunningRow({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shimmer-text shrink-0 text-[12.5px] font-medium">{label}</span>
      {detail ? (
        <span className="min-w-0 truncate text-[12px] text-droid-text-muted">{detail}</span>
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
  forceOpen = false,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  running?: boolean;
  forceOpen?: boolean;
}) {
  const query = argStr(event.toolArgs, 'query') ?? '';
  const { results, count } = useMemo(() => parseWebSearch(output ?? ''), [output]);
  const total = count ?? results.length;
  const raw = useMemo(() => (output ? stripAnsi(output).trim() : ''), [output]);
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen;
  const isX = toolArgStringArray(event.toolArgs, 'includeDomains').some((d) =>
    /(^|\.)(x|twitter)\.com$/i.test(d),
  );
  if (running) return <WebSearchRunningRow isX={isX} query={query} />;
  const trailing = searchTrailing(error, total);

  let body: React.ReactNode = null;
  if (expanded && results.length > 0) {
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
  } else if (expanded && raw) {
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
        aria-expanded={expanded}
      >
        <Caret open={expanded} />
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">
          {isX ? 'Searched X' : 'Searched web'}
        </span>
        {query ? (
          <span className="min-w-0 truncate text-[12px] text-droid-text-muted">{query}</span>
        ) : null}
        {trailing}
      </button>
      <Expand open={expanded}>{body}</Expand>
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
  return <WebToolRunningRow label="Fetching…" detail={url.length > 0 ? url : undefined} />;
}

function fetchTrailing(error: boolean, badge: string | null): React.ReactNode {
  if (error) return <ErrorTag />;
  if (badge) return <CountBadge label={badge} />;
  return null;
}

/* ── Page fetch: same card language as web search (favicon, source, title,
   readable body) so expanded tool groups never dump raw mono fetch text.
   Stays collapsed by default — header alone is enough until the user expands. ── */
export function WebFetchCard({
  event,
  output,
  error = false,
  running = false,
  forceOpen = false,
}: {
  event: TranscriptEvent;
  output?: string;
  error?: boolean;
  running?: boolean;
  forceOpen?: boolean;
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
  const expanded = open || forceOpen;
  const displayTitle = page.title ?? (url.length > 0 ? webSourceName(url) : 'Page');
  const snippet = useMemo(
    () => (expanded && hasBody ? fetchSnippet(page.body) : ''),
    [expanded, hasBody, page.body],
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
        aria-expanded={expanded}
      >
        <Caret open={expanded} />
        <span className="shrink-0 text-[12.5px] text-droid-text-secondary">Fetched</span>
        <span className="min-w-0 truncate text-[12px] text-droid-text-muted">
          {url.length > 0 ? url : displayTitle}
        </span>
        {trailing}
      </button>
      <Expand open={expanded}>
        <WebFetchBody
          error={error}
          hasBody={hasBody}
          body={page.body}
          url={url}
          title={displayTitle}
          snippet={snippet}
        />
      </Expand>
    </div>
  );
}
