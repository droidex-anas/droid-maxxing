import { useEffect, useRef, useSyncExternalStore } from 'react';
import { RotateCcw, Trash2, RefreshCw } from 'lucide-react';
import { Copy } from '@droidex/icons';
import '@xterm/xterm/css/xterm.css';
import { acquireTerminalInstance, type TerminalInstance } from '../../lib/terminalInstances';
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-droid-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-droid-border bg-droid-bg px-2.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-droid-text-muted" title={cwd}>
          {cwd}
        </span>
        <TerminalButton
          title="Copy selection"
          onClick={() => {
            const selection = instance.copySelection();
            if (selection) void navigator.clipboard.writeText(selection);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton
          title="Clear terminal"
          onClick={() => {
            instance.clear();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton
          title="Reset terminal display"
          onClick={() => {
            instance.reset();
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </TerminalButton>
      </div>
      {state.status === 'starting' && <Banner>{`Starting shell in ${cwd}…`}</Banner>}
      {state.status === 'running' && state.truncated && (
        <Banner>Earlier output was truncated.</Banner>
      )}
      {(state.status === 'exited' || state.status === 'error') && (
        <Banner tone={state.status === 'error' ? 'error' : 'muted'}>
          <span className="min-w-0 flex-1 truncate">{state.error || 'Shell exited.'}</span>
          <button
            type="button"
            onClick={() => void instance.restart()}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-droid-text transition-colors hover:bg-droid-elevated"
          >
            <RefreshCw className="h-3 w-3" />
            Restart
          </button>
        </Banner>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}

function Banner({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b border-droid-border px-3 py-2 text-[11.5px] ${
        tone === 'error' ? 'bg-red-500/10 text-red-200' : 'bg-droid-surface text-droid-text-muted'
      }`}
    >
      {children}
    </div>
  );
}

function TerminalButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
    >
      {children}
    </button>
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
