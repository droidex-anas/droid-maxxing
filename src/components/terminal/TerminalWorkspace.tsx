import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { Copy, RotateCcw, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import {
  resizeTerminal,
  subscribeTerminal,
  unsubscribeTerminal,
  type TerminalDataChannel,
} from '../../lib/desktop';
import { createTerminalOutputPump } from '../../lib/terminalOutputPump';
import { closeTerminalForTab, ensureTerminalForTab } from '../../lib/terminal';
import { useStoreSelector } from '../../hooks/useStore';
import type { ThemeConfig } from '../../hooks/persistedThemePreferences';
import { isTerminalTabShortcut } from '../../lib/keyboardShortcuts';

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
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef(terminalId);
  const onCreatedRef = useRef(onCreated);
  const themeRef = useRef(theme);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>(
    terminalId ? 'running' : 'starting',
  );
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    let cancelled = false;
    const isDisposed = () => cancelled;
    let resizeFrame = 0;
    let unlisten: () => void = () => {
      /* no-op */
    };
    let observer: ResizeObserver | null = null;
    let visibility: (() => void) | null = null;
    let channel: TerminalDataChannel | null = null;
    let pump: ReturnType<typeof createTerminalOutputPump> | null = null;

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(async ([xterm, fit]) => {
        if (isDisposed() || !hostRef.current) return;
        const instance = new xterm.Terminal({
          cursorBlink: true,
          cursorStyle: 'bar',
          fontFamily:
            '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 5_000,
          smoothScrollDuration: 90,
          allowProposedApi: false,
          theme: terminalTheme(themeRef.current),
        });
        const fitAddon = new fit.FitAddon();
        instance.loadAddon(fitAddon);
        instance.attachCustomKeyEventHandler((event) => {
          if (!isTerminalTabShortcut(event)) return true;
          event.preventDefault();
          event.stopPropagation();
          return false;
        });
        instance.open(hostRef.current);
        terminalRef.current = instance;
        fitRef.current = fitAddon;

        const hostIsHidden = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
          const host = hostRef.current;
          if (!host) return true;
          return host.clientWidth < 8 || host.clientHeight < 8;
        };
        pump = createTerminalOutputPump({
          write: (data) => {
            instance.write(data);
          },
          isHidden: hostIsHidden,
          scheduleFrame: (callback) => requestAnimationFrame(callback),
          cancelFrame: (id) => {
            cancelAnimationFrame(id);
          },
        });
        const onVisibility = () => {
          pump?.reveal();
        };
        document.addEventListener('visibilitychange', onVisibility);
        visibility = () => {
          document.removeEventListener('visibilitychange', onVisibility);
        };

        const applyFit = () => {
          resizeFrame = 0;
          if (isDisposed() || !hostRef.current || hostRef.current.clientWidth < 8) return;
          fitAddon.fit();
          pump?.reveal();
          const next = { cols: instance.cols, rows: instance.rows };
          if (
            terminalIdRef.current &&
            (next.cols !== lastSizeRef.current.cols || next.rows !== lastSizeRef.current.rows)
          ) {
            lastSizeRef.current = next;
            void resizeTerminal(terminalIdRef.current, next.cols, next.rows);
          }
        };
        const scheduleFit = () => {
          if (!resizeFrame) resizeFrame = requestAnimationFrame(applyFit);
        };
        observer = new ResizeObserver(scheduleFit);
        observer.observe(hostRef.current);
        applyFit();

        const requestedTerminalId = terminalIdRef.current;
        const info = await ensureTerminalForTab(tabId, requestedTerminalId, {
          appSessionId,
          cwd,
          cols: instance.cols,
          rows: instance.rows,
        });
        if (isDisposed()) {
          if (info.id !== requestedTerminalId) {
            await closeTerminalForTab(tabId, info.id);
          }
          return;
        }
        terminalIdRef.current = info.id;
        setStatus('running');
        const shellName = info.shell.split(/[\\/]/).pop() ?? 'Terminal';
        onCreatedRef.current(info.id, shellName);

        channel = subscribeTerminal(info.id);
        if (!channel) {
          setStatus('error');
          setError('Terminal is only available in the desktop app.');
          return;
        }
        unlisten = channel.onEvent((event) => {
          if (event.kind === 'data' || event.kind === 'replay') {
            if (event.truncated) setTruncated(true);
            pump?.push(event.data);
            return;
          }
          if (event.kind === 'error') {
            setStatus('error');
            setError(event.message);
            return;
          }
          setStatus(event.exitCode === 0 ? 'exited' : 'error');
          if (event.exitCode !== 0) {
            setError(`Shell exited with code ${String(event.exitCode ?? 'unknown')}.`);
          }
        });
        if (isDisposed()) {
          channel.close();
          await unsubscribeTerminal(info.id);
          return;
        }
        instance.onData((data) => {
          channel?.postInput(data);
        });
        instance.focus();
      })
      .catch((reason: unknown) => {
        if (isDisposed()) return;
        setStatus('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      visibility?.();
      unlisten();
      pump?.dispose();
      channel?.close();
      if (terminalIdRef.current) void unsubscribeTerminal(terminalIdRef.current);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [cwd, appSessionId, tabId]);

  useEffect(() => {
    themeRef.current = theme;
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-droid-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-droid-border bg-droid-bg px-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-droid-text-muted">
          {cwd}
        </span>
        <TerminalButton
          title="Copy selection"
          onClick={() => {
            const selection = terminalRef.current?.getSelection();
            if (selection) void navigator.clipboard.writeText(selection);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton title="Clear terminal" onClick={() => terminalRef.current?.clear()}>
          <Trash2 className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton title="Reset terminal display" onClick={() => terminalRef.current?.reset()}>
          <RotateCcw className="h-3.5 w-3.5" />
        </TerminalButton>
      </div>
      {(status !== 'running' || truncated) && (
        <div
          className={`shrink-0 border-b border-droid-border px-3 py-2 text-[11.5px] ${
            status === 'error'
              ? 'bg-red-500/10 text-red-200'
              : 'bg-droid-surface text-droid-text-muted'
          }`}
        >
          {terminalStatusCopy(status, cwd, error)}
        </div>
      )}
      <div ref={hostRef} data-terminal-input className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}

function terminalStatusCopy(
  status: 'starting' | 'running' | 'exited' | 'error',
  cwd: string,
  error: string,
): string {
  if (status === 'starting') return `Starting shell in ${cwd}…`;
  if (status === 'running') return 'Earlier output was truncated.';
  return error || 'Terminal process exited.';
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
