import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  resizeTerminal,
  subscribeTerminal,
  unsubscribeTerminal,
  type TerminalDataChannel,
  type TerminalSessionInfo,
} from './desktop';
import { closeTerminalForTab, ensureTerminalForTab } from './terminal';
import { createTerminalOutputPump } from './terminalOutputPump';
import { isTerminalTabShortcut } from './keyboardShortcuts';

export type TerminalStatus = 'starting' | 'running' | 'exited' | 'error';

export interface TerminalInstanceState {
  terminalId: string | null;
  shellName: string;
  status: TerminalStatus;
  error: string;
  truncated: boolean;
}

export interface TerminalInstanceOptions {
  appSessionId: string;
  cwd: string;
  terminalId?: string;
}

export interface TerminalInstanceDeps {
  loadXterm: () => Promise<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon }>;
  ensureTerminal: typeof ensureTerminalForTab;
  closeTerminal: typeof closeTerminalForTab;
  subscribe: typeof subscribeTerminal;
  unsubscribe: typeof unsubscribeTerminal;
  resize: typeof resizeTerminal;
  scheduleFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
}

export interface TerminalInstance {
  readonly tabId: string;
  readonly element: HTMLDivElement;
  getState(): TerminalInstanceState;
  subscribe(listener: () => void): () => void;
  attach(host: HTMLElement): void;
  detach(): void;
  fit(): void;
  restart(): Promise<void>;
  copySelection(): string;
  clear(): void;
  reset(): void;
  setTheme(theme: Record<string, string>): void;
}

const XTERM_OPTIONS = {
  cursorBlink: true,
  cursorStyle: 'bar' as const,
  fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
  lineHeight: 1.25,
  scrollback: 5_000,
  smoothScrollDuration: 90,
  allowProposedApi: false,
};

const defaultDeps: TerminalInstanceDeps = {
  loadXterm: async () => {
    const [xterm, fit] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  },
  ensureTerminal: ensureTerminalForTab,
  closeTerminal: closeTerminalForTab,
  subscribe: subscribeTerminal,
  unsubscribe: unsubscribeTerminal,
  resize: resizeTerminal,
  scheduleFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => {
    cancelAnimationFrame(id);
  },
};

const instances = new Map<string, TerminalInstance & { dispose(): Promise<void> }>();

export function peekTerminalInstance(tabId: string): TerminalInstance | undefined {
  return instances.get(tabId);
}

export function acquireTerminalInstance(
  tabId: string,
  options: TerminalInstanceOptions,
  deps: TerminalInstanceDeps = defaultDeps,
): TerminalInstance {
  const existing = instances.get(tabId);
  if (existing) return existing;
  const instance = createInstance(tabId, options, deps);
  instances.set(tabId, instance);
  return instance;
}

export async function releaseTerminalInstance(tabId: string): Promise<void> {
  const instance = instances.get(tabId);
  if (!instance) return;
  instances.delete(tabId);
  await instance.dispose();
}

export async function releaseTerminalInstancesExcept(
  liveTabIds: ReadonlySet<string>,
): Promise<void> {
  const gone = [...instances.keys()].filter((tabId) => !liveTabIds.has(tabId));
  await Promise.all(gone.map(releaseTerminalInstance));
}

function createInstance(
  tabId: string,
  options: TerminalInstanceOptions,
  deps: TerminalInstanceDeps,
): TerminalInstance & { dispose(): Promise<void> } {
  const doc = globalThis.document;
  const element = doc.createElement('div');
  element.className = 'h-full w-full';
  if (typeof element.setAttribute === 'function') {
    element.setAttribute('data-terminal-input', '');
  }
  const listeners = new Set<() => void>();
  let state: TerminalInstanceState = {
    terminalId: options.terminalId ?? null,
    shellName: 'Terminal',
    status: 'starting',
    error: '',
    truncated: false,
  };
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let channel: TerminalDataChannel | null = null;
  let unlisten: () => void = () => {
    /* no-op */
  };
  let disposed = false;
  let lastSize = { cols: 0, rows: 0 };
  let frame = 0;

  const setState = (patch: Partial<TerminalInstanceState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const isHidden = () =>
    globalThis.document.visibilityState === 'hidden' ||
    !element.isConnected ||
    element.clientWidth < 8 ||
    element.clientHeight < 8;

  const pump = createTerminalOutputPump({
    write: (data) => terminal?.write(data),
    isHidden,
    scheduleFrame: deps.scheduleFrame,
    cancelFrame: deps.cancelFrame,
  });

  const onVisibility = () => {
    pump.reveal();
  };
  globalThis.document.addEventListener('visibilitychange', onVisibility);

  const applyFit = () => {
    frame = 0;
    if (disposed || !terminal || !fitAddon || isHidden()) return;
    fitAddon.fit();
    pump.reveal();
    const next = { cols: terminal.cols, rows: terminal.rows };
    if (state.terminalId && (next.cols !== lastSize.cols || next.rows !== lastSize.rows)) {
      lastSize = next;
      void deps.resize(state.terminalId, next.cols, next.rows);
    }
  };
  const scheduleFit = () => {
    if (!frame) frame = deps.scheduleFrame(applyFit);
  };

  const connect = async (existingId: string | undefined) => {
    if (!terminal) return;
    const info: TerminalSessionInfo = await deps.ensureTerminal(tabId, existingId, {
      appSessionId: options.appSessionId,
      cwd: options.cwd,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    if (disposed) {
      if (info.id !== existingId) await deps.closeTerminal(tabId, info.id);
      return;
    }
    lastSize = { cols: 0, rows: 0 };
    setState({
      terminalId: info.id,
      shellName: info.shell.split(/[\\/]/).pop() ?? 'Terminal',
      status: 'running',
      error: '',
      truncated: false,
    });
    channel = deps.subscribe(info.id);
    if (!channel) {
      setState({ status: 'error', error: 'Terminal is only available in the desktop app.' });
      return;
    }
    unlisten = channel.onEvent((event) => {
      if (event.kind === 'data' || event.kind === 'replay') {
        if (event.truncated) setState({ truncated: true });
        pump.push(event.data);
        return;
      }
      if (event.kind === 'error') {
        setState({ status: 'error', error: event.message });
        return;
      }
      const failed = event.exitCode !== 0;
      setState({
        status: failed ? 'error' : 'exited',
        error: failed ? `Shell exited with code ${String(event.exitCode ?? 'unknown')}.` : '',
      });
    });
    scheduleFit();
  };

  const disconnect = async () => {
    unlisten();
    unlisten = () => {
      /* no-op */
    };
    channel?.close();
    channel = null;
    if (state.terminalId) await deps.unsubscribe(state.terminalId);
  };

  void deps
    .loadXterm()
    .then(async ({ Terminal: xtermCtor, FitAddon: fitAddonCtor }) => {
      if (disposed) return;
      terminal = new xtermCtor(XTERM_OPTIONS);
      fitAddon = new fitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.attachCustomKeyEventHandler((event) => {
        if (!isTerminalTabShortcut(event)) return true;
        event.preventDefault();
        event.stopPropagation();
        return false;
      });
      terminal.open(element);
      terminal.onData((data) => channel?.postInput(data));
      await connect(options.terminalId);
    })
    .catch((reason: unknown) => {
      if (disposed) return;
      setState({
        status: 'error',
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });

  return {
    tabId,
    element,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(host) {
      host.appendChild(element);
      applyFit();
      terminal?.focus();
    },
    detach() {
      element.remove();
    },
    fit: scheduleFit,
    async restart() {
      const previous = state.terminalId;
      await disconnect();
      if (previous) await deps.closeTerminal(tabId, previous);
      terminal?.reset();
      setState({ terminalId: null, status: 'starting', error: '', truncated: false });
      await connect(undefined);
    },
    copySelection: () => terminal?.getSelection() ?? '',
    clear: () => terminal?.clear(),
    reset: () => terminal?.reset(),
    setTheme(theme) {
      if (terminal) terminal.options.theme = theme;
    },
    async dispose() {
      disposed = true;
      if (frame) deps.cancelFrame(frame);
      globalThis.document.removeEventListener('visibilitychange', onVisibility);
      pump.dispose();
      await disconnect();
      const id = state.terminalId;
      terminal?.dispose();
      terminal = null;
      fitAddon = null;
      element.remove();
      if (id) await deps.closeTerminal(tabId, id);
      else await deps.closeTerminal(tabId);
    },
  };
}
