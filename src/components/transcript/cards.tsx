import { useState, type MouseEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, Terminal } from 'lucide-react';
import type { TranscriptEvent } from '../../types/bridge';
import {
  CAT_ICON,
  CAT_LABEL,
  parseTodos,
  stripAnsi,
  toolMeta,
  type TodoStatus,
} from '../../lib/tools';
import { compactPath } from '../../lib/pathDisplay';
import { Caret, CopyButton, ErrorTag, Expand, ToolPanel } from './primitives';
import { openExternal } from '../../lib/onboarding';

const ACCENT = 'var(--droid-accent)';
export const RED = 'var(--droid-red)';
export const RED_TINT = 'color-mix(in srgb, var(--droid-red) 8%, transparent)';

export function openLink(event: MouseEvent, url: string): void {
  event.preventDefault();
  void openExternal(url);
}

export function httpHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}

const URL_RE = /(https?:\/\/[^\s<>()[\]"'`]+)/g;

export function linkify(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    let url = match[0];
    const tail = /[.,;:!?)\]}]+$/.exec(url)?.[0] ?? '';
    if (tail) url = url.slice(0, url.length - tail.length);
    nodes.push(
      <a
        key={match.index}
        href={url}
        onClick={(event) => {
          openLink(event, url);
        }}
        className="break-all underline underline-offset-2 hover:opacity-80"
        style={{ color: ACCENT }}
      >
        {url}
      </a>,
    );
    if (tail) nodes.push(tail);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : text;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((value) => value.trim()) ?? text;
  return line.trim();
}

function readArgument(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
}

function readSummary(path: string, args: unknown): string {
  const offset = readArgument(args, 'offset');
  const limit = readArgument(args, 'limit');
  const details = [
    offset != null ? `offset: ${offset}` : null,
    limit != null ? `limit: ${limit}` : null,
  ].filter((value): value is string => value !== null);
  return [compactPath(path), ...details].filter(Boolean).join(', ');
}

export function ErrorLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = stripAnsi(text).trim();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
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
            className="mt-1.5 max-h-56 overflow-auto rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
            style={{ backgroundColor: RED_TINT, color: RED }}
          >
            {linkify(body)}
          </pre>
        ) : null}
      </Expand>
    </div>
  );
}

function ShellPanel({
  command,
  output,
  title,
  error,
}: {
  command: string;
  output: string;
  title?: string;
  error: boolean;
}) {
  return (
    <ToolPanel className="mt-1.5">
      <div className="flex items-center gap-2 border-b border-droid-border px-3 py-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wider text-droid-text-muted">
          {title ?? 'Shell'}
        </span>
        <CopyButton text={output ? `${command}\n\n${output}` : command} />
      </div>
      <div className="max-h-56 overflow-y-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.6]">
        <div className="flex gap-2 break-words">
          <span className="select-none" style={{ color: error ? RED : ACCENT }}>
            $
          </span>
          <span className="whitespace-pre-wrap text-droid-text">{command}</span>
        </div>
        <pre
          className={`mt-2.5 border-t border-droid-border/60 pt-2.5 text-[11px] leading-[1.55] whitespace-pre-wrap break-words ${
            output ? '' : 'text-droid-text-muted'
          }`}
          style={error ? { color: RED } : undefined}
        >
          {output ? (error ? output : linkify(output)) : 'No output'}
        </pre>
      </div>
    </ToolPanel>
  );
}

export function ShellCard({
  command,
  output,
  title,
  error = false,
  running = false,
}: {
  command: string;
  output?: string;
  title?: string;
  error?: boolean;
  running?: boolean;
}) {
  const out = output ? stripAnsi(output).trimEnd() : '';
  const [open, setOpen] = useState(false);
  const label = running ? 'Running' : error ? 'Failed' : 'Ran';
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <Terminal
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: error ? RED : 'var(--droid-text-muted)' }}
        />
        <span
          className={
            running
              ? 'shimmer-text shrink-0 text-[12.5px] font-medium'
              : 'shrink-0 text-[12.5px] text-droid-text-secondary'
          }
        >
          {label}
        </span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-muted">
          {command}
        </span>
        {error ? <ErrorTag /> : null}
        <Caret open={open} />
      </button>
      <Expand open={open}>
        {open ? <ShellPanel command={command} output={out} title={title} error={error} /> : null}
      </Expand>
    </div>
  );
}

function PlanMark({ status, live }: { status: TodoStatus; live: boolean }) {
  if (status === 'completed') {
    return (
      <span className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-droid-accent">
        <Check className="h-2 w-2 text-droid-bg" strokeWidth={3} />
      </span>
    );
  }
  const spinning = live && status === 'in_progress';
  return (
    <span
      className={`mt-px h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] ${
        spinning
          ? 'animate-spin border-droid-text-muted/30 border-t-droid-text'
          : status === 'in_progress'
            ? 'border-droid-text-secondary/70'
            : 'border-droid-text-muted/30'
      }`}
      style={spinning ? { animationDuration: '1.4s' } : undefined}
    />
  );
}

export function PlanUpdate({ event, live = false }: { event: TranscriptEvent; live?: boolean }) {
  const todos = parseTodos(event.toolArgs);
  const [open, setOpen] = useState(false);
  const label = (
    <>
      <span
        className={
          live
            ? 'shimmer-text shrink-0 text-[12.5px] font-medium'
            : 'shrink-0 text-[12.5px] text-droid-text-secondary'
        }
      >
        {live ? 'Updating' : 'Updated'}
      </span>
      <span className="min-w-0 truncate text-[12.5px] text-droid-text-muted">plan</span>
    </>
  );

  if (todos.length === 0) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-relaxed">{label}</div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] leading-relaxed"
      >
        {label}
        <Caret open={open} />
      </button>
      <Expand open={open}>
        {open ? (
          <div className="mt-1.5 space-y-1">
            {todos.map((todo, index) => (
              <div
                key={`${String(index)}-${todo.text}`}
                className={`flex items-start gap-2 text-[12.5px] leading-relaxed break-words ${
                  todo.status === 'in_progress'
                    ? 'text-droid-text-secondary'
                    : 'text-droid-text-muted'
                }`}
              >
                <PlanMark status={todo.status} live={live} />
                <span>{todo.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Expand>
    </div>
  );
}

export function ToolLine({
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
  const raw = detail;
  const slash = raw.lastIndexOf('/');
  const looksLikePath = slash > 0 && !raw.includes(' ');
  const dir = looksLikePath ? raw.slice(0, slash + 1) : '';
  const name = looksLikePath ? raw.slice(slash + 1) : raw;
  const expandable = out.length > 0;
  const iconFree = cat === 'read' || cat === 'search';
  const [open, setOpen] = useState(false);
  const label = iconFree ? (
    <>
      <span className="shrink-0 text-[12.5px] text-droid-text-secondary">{CAT_LABEL[cat]}</span>
      {raw ? (
        <span className="min-w-0 truncate text-[12.5px] text-droid-text-muted">
          {cat === 'read' ? readSummary(raw, event.toolArgs) : raw}
        </span>
      ) : null}
    </>
  ) : (
    <>
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${error ? '' : 'text-droid-text-muted'}`}
        style={error ? { color: RED } : undefined}
      />
      <span className="shrink-0 text-[12.5px] text-droid-text-secondary">{CAT_LABEL[cat]}</span>
      {raw ? (
        <span className="min-w-0 truncate font-mono text-[11.5px]">
          {dir && <span className="text-droid-text-muted/50">{dir}</span>}
          <span className="text-droid-text-muted">{name}</span>
        </span>
      ) : null}
    </>
  );

  if (!expandable && !error) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-relaxed">{label}</div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] leading-relaxed"
      >
        {label}
        {error ? <ErrorTag /> : null}
        {cat !== 'read' ? <Caret open={open} /> : null}
      </button>
      <Expand open={open}>
        {open ? (
          <ToolPanel className="mt-1.5">
            <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-droid-text-muted whitespace-pre-wrap break-words">
              {error ? out : linkify(out)}
            </pre>
          </ToolPanel>
        ) : null}
      </Expand>
    </div>
  );
}
