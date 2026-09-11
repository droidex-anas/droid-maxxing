import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Copy } from '@droidex/icons';
import '@xterm/xterm/css/xterm.css';
import { acquireTerminalInstance, type TerminalInstance } from '../../lib/terminalInstances';
import { HoverTooltip } from '../HoverTooltip';
import { useStoreSelector } from '../../hooks/useStore';
import type { ThemeConfig } from '../../hooks/persistedThemePreferences';

export function TerminalWorkspace({
  tabId,
  terminalId,
  appSessionId,
  cwd,
  onCreated,
}: {
  tabId: string;
  terminalId?: string;
  appSessionId: string;
  cwd: string;
  onCreated: (terminalId: string, label: string) => void;
}) {
  const theme = useStoreSelector((state) => state.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<TerminalInstance | null>(null);
  instanceRef.current ??= acquireTerminalInstance(tabId, { appSessionId, cwd, terminalId });
  const instance = instanceRef.current;
  const state = useSyncExternalStore(
    (listener) => instance.subscribe(listener),
    () => instance.getState(),
    () => instance.getState(),
  );
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    instance.attach(host);
    const observer = new ResizeObserver(() => {
      instance.fit();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      instance.detach();
    };
  }, [instance]);

  useEffect(() => {
    instance.setTheme(terminalTheme(theme));
  }, [instance, theme]);

  useEffect(() => {
    if (state.terminalId && state.terminalId !== terminalId) {
      onCreatedRef.current(state.terminalId, state.shellName);
    }
  }, [state.terminalId, state.shellName, terminalId]);

  const stopped = state.status === 'exited' || state.status === 'error';
  const restart = () => {
    void instance.restart();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-droid-bg">
      <TerminalHeader shellName={state.shellName} cwd={cwd} stopped={stopped}>
        <HeaderAction
          label="Copy selection"
          onClick={() => {
            const selection = instance.copySelection();
            if (selection) {
              void navigator.clipboard.writeText(selection);
            }
          }}
        >
          <Copy className="h-4 w-4" />
        </HeaderAction>
        {!stopped && (
          <>
            <HeaderAction
              label="Clear"
              onClick={() => {
                instance.clear();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </HeaderAction>
            <HeaderAction
              label="Reset"
              onClick={() => {
                instance.reset();
              }}
            >
              <RotateCcw className="h-4 w-4" />
            </HeaderAction>
          </>
        )}
      </TerminalHeader>
      {stopped && (
        <TerminalStatusRow
          message={state.status === 'error' ? state.error || 'Shell failed' : 'Shell exited'}
          tone={state.status === 'error' ? 'error' : 'muted'}
          onRestart={restart}
        />
      )}
      {state.status === 'running' && state.truncated && (
        <div className="shrink-0 animate-fade-in px-3 pb-0.5 pt-1.5 text-[12px] leading-none text-droid-text-muted">
          Earlier output was trimmed
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full overflow-hidden p-3" />
        {state.status === 'starting' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-droid-text-muted">
            {state.shellName === 'Terminal' ? 'Starting shell…' : `Starting ${state.shellName}…`}
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalHeader({
  shellName,
  cwd,
  stopped,
  children,
}: {
  shellName: string;
  cwd: string;
  stopped: boolean;
  children: ReactNode;
}) {
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return (
    <div className="group flex h-8 shrink-0 items-center gap-0.5 border-b border-droid-border pl-3 pr-1.5">
      {/* HoverTooltip's anchor is `shrink-0`; let it shrink here so a long
          folder name ellipsizes instead of pushing the actions off the row. */}
      <div className="flex min-w-0 flex-1 items-center [&>span]:min-w-0 [&>span]:shrink">
        <HoverTooltip label={cwd} placement="bottom">
          <span
            className={`truncate text-[12px] leading-none ${stopped ? 'text-droid-text-secondary' : 'text-droid-text'}`}
          >
            {shellName}
            <span className="text-droid-text-secondary"> · {folder}</span>
          </span>
        </HoverTooltip>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover:opacity-100">
        {children}
      </div>
    </div>
  );
}

function TerminalStatusRow({
  message,
  tone,
  onRestart,
}: {
  message: string;
  tone: 'muted' | 'error';
  onRestart: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-droid-border pl-3 pr-1.5 text-[12px]">
      <span
        className={`min-w-0 flex-1 truncate ${tone === 'error' ? 'text-droid-red' : 'text-droid-text-secondary'}`}
      >
        {message}
      </span>
      <button
        type="button"
        onClick={onRestart}
        className="shrink-0 rounded-md px-2 py-1 leading-none text-droid-text transition-colors hover:bg-droid-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent"
      >
        Restart
      </button>
    </div>
  );
}

function HeaderAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <HoverTooltip label={label} placement="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-7 w-7 items-center justify-center rounded-md text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent"
      >
        {children}
      </button>
    </HoverTooltip>
  );
}

function terminalTheme(theme: ThemeConfig) {
  return {
    background: theme.bg,
    foreground: theme.fg,
    cursor: theme.accent,
    cursorAccent: theme.bg,
    selectionBackground: /^#[0-9a-f]{6}$/i.test(theme.accent) ? `${theme.accent}33` : theme.accent,
    black: theme.surface,
    brightBlack: theme.border,
  };
}
