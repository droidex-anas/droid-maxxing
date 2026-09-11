# Persistent Terminals and Agent Process Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminals survive chat switches intact, close cleanly, and agent-started processes (dev servers) are visible in a composer chip, stoppable, and never outlive the app.

**Architecture:** Renderer keeps one xterm per terminal tab in a module registry and re-parents its DOM node on mount. The sidecar walks each session's `droid exec` descendants with `ps`/`lsof`, emits `session.processes`, tree-kills on close, and journals pids for crash reaping. The renderer shows a toolbar chip with a popover.

**Tech Stack:** React 18 + `useReducer` store (`src/hooks/useStore.tsx`), xterm.js, Electron main (`electron/*.cjs`, CommonJS, `node:test`), Node sidecar (`sidecar/src`, TypeScript ESM, `node --import tsx --test`), framer-motion, Tailwind with `droid-*` tokens.

**Spec:** `docs/superpowers/specs/2026-09-10-terminal-and-agent-processes-design.md`

## Global Constraints

- No monospace in UI chrome (labels, paths, chips). Monospace only inside xterm and command output.
- Reuse theme tokens (`text-droid-text-secondary`, `bg-droid-elevated`, `border-droid-border`, `text-droid-accent`, `bg-droid-accent`). No new palette, no badges, no glow.
- Files stay under 500 lines. `PromptInput.tsx` and `useStore.tsx` are already oversized: add the minimum to them and put new logic in new files.
- Commit messages: plain, no co-author or generated-with trailers.
- Test commands: renderer `npm test` (or `node --import tsx --test src/path/file.test.ts`), sidecar `npm --prefix sidecar test` (or `node --import tsx --test sidecar/src/path/file.test.ts` from `sidecar/`), Electron `node --test electron/terminal.test.cjs`. Typecheck: `npm run typecheck` and `npm run sidecar:typecheck`.
- Windows: process discovery returns empty; `terminal-has-children` answers `true`.

---

## File map

Renderer (Part 1 and 3)
- Create `src/lib/terminalInstances.ts` (registry) and `src/lib/terminalInstances.test.ts`.
- Rewrite `src/components/terminal/TerminalWorkspace.tsx` (thin mount).
- Modify `src/components/utility/UtilityPane.tsx` (key, close confirmation popover).
- Modify `src/App.tsx` close handler and add a release effect.
- Modify `src/lib/utilityPanel.ts` (`removeSessionPanel`), `src/hooks/useStore.tsx` (prune on delete/archive/close; `agentProcesses` slice), `src/lib/desktop.ts`, `electron/preload.cjs`, `electron/main.cjs`, `electron/terminal.cjs` (`hasChildren`).
- Create `src/components/composer/RunningProcessesChip.tsx`, modify `src/components/PromptInput.tsx`, `src/index.css`, `src/lib/commands.ts`, `src/types/bridge.ts`, `src/lib/bridgeWireValidation.ts`, `src/components/transcript/commandCard.tsx`.

Sidecar (Part 2)
- Create `sidecar/src/processes/processTree.ts`, `listeningPorts.ts`, `AgentProcessMonitor.ts` with tests.
- Modify `sidecar/src/protocol.ts`, `DroidTransport.ts`, `DroidRuntime.ts`, `testing/fakeFactoryRuntime.ts`, `perf/replayRuntime.ts`, `SessionLifecycle.ts`, `ChildSessions.ts`, `childRuntimeOpen.ts`, `sessionRuntimeRetirement.ts`, `SessionManager.ts`, `liveRuntimeJournal.ts`, `sessionAdoption.ts`.

---

### Task 1: `terminal-has-children` IPC

**Files:**
- Modify: `electron/terminal.cjs` (manager API, near `summary()` at line ~431 and the `return {...}` at ~532)
- Modify: `electron/main.cjs:617-625` (add handler next to `terminal-kill`)
- Modify: `electron/preload.cjs:205-210`
- Modify: `src/lib/desktop.ts:285-287` (API type) and `:555-560` (helper)
- Test: `electron/terminal.test.cjs`

**Interfaces:**
- Produces: `manager.hasChildren(id): Promise<boolean>`; IPC `terminal-has-children {id}`; renderer `terminalHasChildren(id: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test** (append to `electron/terminal.test.cjs`)

```js
test('hasChildren asks the child-pid lister for the shell pid', async () => {
  const calls = [];
  const { manager } = fixture({
    listChildPids: async (pid) => {
      calls.push(pid);
      return pid === 4242 ? [5000] : [];
    },
  });
  const info = await manager.create({ appSessionId: 's1', cwd: '/w' });
  assert.equal(await manager.hasChildren(info.id), true);
  assert.deepEqual(calls, [4242]);
  assert.equal(await manager.hasChildren('missing'), false);
});
```

In `fixture()` pass `listChildPids: options.listChildPids` to `createTerminalManager` and give the mock pty a `pid: 4242` property on `instance`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test electron/terminal.test.cjs`
Expected: FAIL, `manager.hasChildren is not a function`.

- [ ] **Step 3: Implement in `electron/terminal.cjs`**

Add near the top:

```js
const { execFile } = require('node:child_process');

// pgrep -P lists direct children of the shell; a non-zero exit means none.
function defaultListChildPids(pid) {
  if (process.platform === 'win32') return Promise.resolve([pid]);
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        String(stdout)
          .split('\n')
          .map((line) => Number(line.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
  });
}
```

In `createTerminalManager`, after `const defaultCwd = config.defaultCwd;`:

```js
  const listChildPids = config.listChildPids || defaultListChildPids;
```

Add the method after `summary`:

```js
  // True while the shell has at least one child process, so closing it would
  // stop something the user started. Exited or unknown terminals answer false.
  async function hasChildren(id) {
    const e = terminals.get(id);
    if (!e || e.exited || !e.pty || typeof e.pty.pid !== 'number') return false;
    const children = await listChildPids(e.pty.pid);
    return children.length > 0;
  }
```

Add `hasChildren,` to the returned object.

- [ ] **Step 4: Wire IPC, preload, and renderer**

`electron/main.cjs`, after the `terminal-kill` handler:

```js
  ipcMain.handle('terminal-has-children', (event, { id }) => {
    assertMainRenderer(event);
    return terminalManager.hasChildren(id);
  });
```

`electron/preload.cjs`, after `terminalKill`:

```js
  terminalHasChildren: (id) => ipcRenderer.invoke('terminal-has-children', { id }),
```

`src/lib/desktop.ts`: in the API interface after `terminalKill` add `terminalHasChildren: (id: string) => Promise<boolean>;` and after `killTerminal`:

```ts
export async function terminalHasChildren(id: string): Promise<boolean> {
  const api = desktopApi();
  if (!api) return false;
  return api.terminalHasChildren(id);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test electron/terminal.test.cjs electron/preload.test.cjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/terminal.cjs electron/terminal.test.cjs electron/main.cjs electron/preload.cjs src/lib/desktop.ts
git commit -m "feat(terminal): report whether a shell has child processes"
```

---

### Task 2: Terminal instance registry

**Files:**
- Create: `src/lib/terminalInstances.ts`
- Test: `src/lib/terminalInstances.test.ts`

**Interfaces:**
- Consumes: `ensureTerminalForTab`, `closeTerminalForTab` (`src/lib/terminal.ts`), `subscribeTerminal`, `unsubscribeTerminal`, `resizeTerminal` (`src/lib/desktop.ts`), `createTerminalOutputPump` (`src/lib/terminalOutputPump.ts`).
- Produces:

```ts
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'error';
export interface TerminalInstanceState {
  terminalId: string | null;
  shellName: string;
  status: TerminalStatus;
  error: string;
  truncated: boolean;
}
export interface TerminalInstanceOptions { appSessionId: string; cwd: string; terminalId?: string }
export interface TerminalInstance {
  readonly tabId: string;
  readonly element: HTMLDivElement;
  getState(): TerminalInstanceState;
  subscribe(listener: () => void): () => void;
  attach(host: HTMLElement): void;   // append element, fit, reveal, focus
  detach(): void;                    // remove element from DOM only
  fit(): void;
  restart(): Promise<void>;
  copySelection(): string;
  clear(): void;
  reset(): void;
}
export function acquireTerminalInstance(tabId: string, options: TerminalInstanceOptions, deps?: TerminalInstanceDeps): TerminalInstance;
export function releaseTerminalInstance(tabId: string): Promise<void>;   // dispose + kill PTY
export function releaseTerminalInstancesExcept(liveTabIds: ReadonlySet<string>): Promise<void>;
export function peekTerminalInstance(tabId: string): TerminalInstance | undefined;
```

`TerminalInstanceDeps` lets tests inject `loadXterm`, `ensureTerminal`, `closeTerminal`, `subscribe`, `unsubscribe`, `resize`, `scheduleFrame`, `cancelFrame`.

- [ ] **Step 1: Write the failing tests** (`src/lib/terminalInstances.test.ts`)

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireTerminalInstance,
  peekTerminalInstance,
  releaseTerminalInstance,
  releaseTerminalInstancesExcept,
  type TerminalInstanceDeps,
} from './terminalInstances';

class FakeTerminal {
  writes: string[] = [];
  disposed = false;
  opened: HTMLElement | null = null;
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  dataHandler: ((data: string) => void) | null = null;
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  open(host: HTMLElement) { this.opened = host; }
  write(data: string) { this.writes.push(data); }
  onData(handler: (data: string) => void) { this.dataHandler = handler; }
  focus() {}
  dispose() { this.disposed = true; }
  getSelection() { return ''; }
  clear() {}
  reset() {}
}

function fakeDom() {
  const doc = {
    visibilityState: 'visible',
    createElement: () => ({
      isConnected: false,
      clientWidth: 400,
      clientHeight: 300,
      remove() { this.isConnected = false; },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

function deps(overrides: Partial<TerminalInstanceDeps> = {}) {
  const terminal = new FakeTerminal();
  const events: Array<(event: unknown) => void> = [];
  const killed: string[] = [];
  const base: TerminalInstanceDeps = {
    loadXterm: async () => ({
      Terminal: function () { return terminal; } as never,
      FitAddon: function () { return { fit() {} }; } as never,
    }),
    ensureTerminal: async (_tabId, existingId) => ({
      id: existingId ?? 'pty-1',
      appSessionId: 's1',
      cwd: '/w',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
    }),
    closeTerminal: async (_tabId, id) => { if (id) killed.push(id); },
    subscribe: () => ({
      onEvent: (handler) => { events.push(handler); return () => {}; },
      postInput() {},
      close() {},
    }),
    unsubscribe: async () => {},
    resize: async () => {},
    scheduleFrame: (cb) => { cb(); return 1; },
    cancelFrame: () => {},
    ...overrides,
  };
  return { base, terminal, events, killed };
}

test('acquire is idempotent per tab and creates one PTY', async () => {
  fakeDom();
  const d = deps();
  const a = acquireTerminalInstance('tab-a', { appSessionId: 's1', cwd: '/w' }, d.base);
  const b = acquireTerminalInstance('tab-a', { appSessionId: 's1', cwd: '/w' }, d.base);
  assert.equal(a, b);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.getState().terminalId, 'pty-1');
  assert.equal(a.getState().status, 'running');
  await releaseTerminalInstance('tab-a');
});

test('output while detached is buffered and flushed on attach', async () => {
  fakeDom();
  const d = deps();
  const inst = acquireTerminalInstance('tab-b', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  d.events[0]({ kind: 'data', data: 'hello' });
  assert.deepEqual(d.terminal.writes, []);
  const host = { appendChild: (el: { isConnected: boolean }) => { el.isConnected = true; } };
  inst.attach(host as unknown as HTMLElement);
  assert.deepEqual(d.terminal.writes, ['hello']);
  await releaseTerminalInstance('tab-b');
});

test('release disposes the xterm and kills the PTY once', async () => {
  fakeDom();
  const d = deps();
  acquireTerminalInstance('tab-c', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  await releaseTerminalInstance('tab-c');
  await releaseTerminalInstance('tab-c');
  assert.equal(d.terminal.disposed, true);
  assert.deepEqual(d.killed, ['pty-1']);
  assert.equal(peekTerminalInstance('tab-c'), undefined);
});

test('releaseTerminalInstancesExcept drops tabs that disappeared', async () => {
  fakeDom();
  const d = deps();
  acquireTerminalInstance('keep', { appSessionId: 's1', cwd: '/w' }, d.base);
  acquireTerminalInstance('gone', { appSessionId: 's2', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  await releaseTerminalInstancesExcept(new Set(['keep']));
  assert.ok(peekTerminalInstance('keep'));
  assert.equal(peekTerminalInstance('gone'), undefined);
  await releaseTerminalInstance('keep');
});

test('restart replaces an exited PTY', async () => {
  fakeDom();
  let n = 0;
  const d = deps({
    ensureTerminal: async (_tab, existing) => ({
      id: existing ?? `pty-${++n}`,
      appSessionId: 's1', cwd: '/w', shell: '/bin/zsh', cols: 80, rows: 24,
    }),
  });
  const inst = acquireTerminalInstance('tab-d', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  d.events[0]({ kind: 'exit', exitCode: 0 });
  assert.equal(inst.getState().status, 'exited');
  await inst.restart();
  assert.equal(inst.getState().terminalId, 'pty-2');
  assert.equal(inst.getState().status, 'running');
  assert.deepEqual(d.killed, ['pty-1']);
  await releaseTerminalInstance('tab-d');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test src/lib/terminalInstances.test.ts`
Expected: FAIL, cannot find module `./terminalInstances`.

- [ ] **Step 3: Implement `src/lib/terminalInstances.ts`**

```ts
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
  cancelFrame: (id) => cancelAnimationFrame(id),
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

export async function releaseTerminalInstancesExcept(liveTabIds: ReadonlySet<string>): Promise<void> {
  const gone = [...instances.keys()].filter((tabId) => !liveTabIds.has(tabId));
  await Promise.all(gone.map(releaseTerminalInstance));
}

function createInstance(
  tabId: string,
  options: TerminalInstanceOptions,
  deps: TerminalInstanceDeps,
): TerminalInstance & { dispose(): Promise<void> } {
  const element = document.createElement('div');
  element.className = 'h-full w-full';
  element.setAttribute('data-terminal-input', '');
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
  let unlisten: () => void = () => {};
  let disposed = false;
  let lastSize = { cols: 0, rows: 0 };
  let frame = 0;

  const setState = (patch: Partial<TerminalInstanceState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const isHidden = () =>
    document.visibilityState === 'hidden' ||
    !element.isConnected ||
    element.clientWidth < 8 ||
    element.clientHeight < 8;

  const pump = createTerminalOutputPump({
    write: (data) => terminal?.write(data),
    isHidden,
    scheduleFrame: deps.scheduleFrame,
    cancelFrame: deps.cancelFrame,
  });

  const onVisibility = () => pump.reveal();
  document.addEventListener('visibilitychange', onVisibility);

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
    unlisten = () => {};
    channel?.close();
    channel = null;
    if (state.terminalId) await deps.unsubscribe(state.terminalId);
  };

  void deps
    .loadXterm()
    .then(async ({ Terminal, FitAddon }) => {
      if (disposed) return;
      terminal = new Terminal(XTERM_OPTIONS);
      fitAddon = new FitAddon();
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
      document.removeEventListener('visibilitychange', onVisibility);
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
```

Note on the test fakes: `element.remove` exists on the fake, `host.appendChild` sets `isConnected`. The test for detached buffering relies on `isHidden()` reading `element.isConnected`.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test src/lib/terminalInstances.test.ts && npm run typecheck`
Expected: PASS. If `document` typing complains in tests, the `fakeDom()` cast already covers it; adjust the fake element to include `remove` (it does).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminalInstances.ts src/lib/terminalInstances.test.ts
git commit -m "feat(terminal): keep xterm instances alive across tab mounts"
```

---

### Task 3: Thin `TerminalWorkspace` and keyed tab panel

**Files:**
- Rewrite: `src/components/terminal/TerminalWorkspace.tsx`
- Modify: `src/components/utility/UtilityPane.tsx:175-177`
- Modify: `src/App.tsx:695-712` (`onCreated` still dispatches `UPDATE_UTILITY_TAB`)

**Interfaces:**
- Consumes: Task 2 registry.
- Produces: same `TerminalWorkspace` props as today (`tabId`, `terminalId`, `appSessionId`, `cwd`, `onCreated`).

- [ ] **Step 1: Rewrite the component**

```tsx
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
  if (!instanceRef.current) {
    instanceRef.current = acquireTerminalInstance(tabId, { appSessionId, cwd, terminalId });
  }
  const instance = instanceRef.current;
  const state = useSyncExternalStore(instance.subscribe, instance.getState, instance.getState);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    instance.attach(host);
    const observer = new ResizeObserver(() => instance.fit());
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
        <TerminalButton title="Clear terminal" onClick={() => instance.clear()}>
          <Trash2 className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton title="Reset terminal display" onClick={() => instance.reset()}>
          <RotateCcw className="h-3.5 w-3.5" />
        </TerminalButton>
      </div>
      {state.status === 'starting' && (
        <Banner>{`Starting shell in ${cwd}…`}</Banner>
      )}
      {state.status === 'running' && state.truncated && <Banner>Earlier output was truncated.</Banner>}
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

function Banner({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
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
```

Keep the existing `TerminalButton` and `terminalTheme` functions unchanged at the bottom of the file. Delete the old effect body, `createTerminalOutputPump`, `resizeTerminal`, `subscribeTerminal`, `ensureTerminalForTab`, and `isTerminalTabShortcut` imports from this file (they now live in the registry).

- [ ] **Step 2: Key the tab panel** in `UtilityPane.tsx`

```tsx
      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          <Fragment key={activeTab.id}>{renderTab(activeTab, { overlayOpen: menuOpen })}</Fragment>
        ) : (
```

Add `Fragment` to the React import.

- [ ] **Step 3: Typecheck, lint, existing tests**

Run: `npm run typecheck && npx eslint src/components/terminal src/components/utility src/lib/terminalInstances.ts && node --import tsx --test src/lib/lazySurfaces.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/TerminalWorkspace.tsx src/components/utility/UtilityPane.tsx
git commit -m "feat(terminal): mount persistent xterm instances and key the tab panel"
```

---

### Task 4: Close flow without native dialogs

**Files:**
- Modify: `src/components/utility/UtilityPane.tsx` (close button ref map + popover)
- Modify: `src/App.tsx:648-665`

**Interfaces:**
- Consumes: `terminalHasChildren` (Task 1), `releaseTerminalInstance` (Task 2), `Popover` (`src/components/environment/Popover.tsx`, props `open`, `onClose`, `anchorRef`, `align`, `width`, `label`).
- Produces: `UtilityPane` prop `confirmCloseTabId: string | null`, `onConfirmClose: (tab: UtilityTab) => void`, `onCancelClose: () => void`.

- [ ] **Step 1: Add the confirmation popover to `UtilityPane`**

Add props to the component signature:

```tsx
  confirmCloseTabId = null,
  onConfirmClose,
  onCancelClose,
```

with types `confirmCloseTabId?: string | null; onConfirmClose?: (tab: UtilityTab) => void; onCancelClose?: () => void;`.

Add `const closeButtonRefs = useRef(new Map<string, HTMLButtonElement>());` and on each close button:

```tsx
                    ref={(node) => {
                      if (node) closeButtonRefs.current.set(tab.id, node);
                      else closeButtonRefs.current.delete(tab.id);
                    }}
```

After the existing tool picker `Popover`, add:

```tsx
      {confirmCloseTabId && (
        <Popover
          open
          onClose={() => onCancelClose?.()}
          anchorRef={{ current: closeButtonRefs.current.get(confirmCloseTabId) ?? null }}
          align="right"
          width={240}
          label="Confirm closing terminal"
        >
          <div className="px-3 py-2.5 text-[12px] text-droid-text">
            A process is still running in this terminal.
            <div className="mt-2 flex justify-end gap-1">
              <button
                type="button"
                onClick={() => onCancelClose?.()}
                className="rounded-md px-2 py-1 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => {
                  const tab = panel.tabs.find((candidate) => candidate.id === confirmCloseTabId);
                  if (tab) onConfirmClose?.(tab);
                }}
                className="rounded-md bg-droid-elevated px-2 py-1 text-droid-text transition-colors hover:bg-droid-active"
              >
                Stop and close
              </button>
            </div>
          </div>
        </Popover>
      )}
```

- [ ] **Step 2: Replace the App close handler**

In `App.tsx` add `const [confirmCloseTabId, setConfirmCloseTabId] = useState<string | null>(null);` near the other utility pane state, import `terminalHasChildren` from `./lib/desktop` and `releaseTerminalInstance, peekTerminalInstance` from `./lib/terminalInstances`, and remove the `closeTerminalForTab` import.

```tsx
  const closeTerminalTab = useCallback(
    (tab: UtilityTab) => {
      setConfirmCloseTabId(null);
      void releaseTerminalInstance(tab.id).finally(() => {
        dispatch({
          type: 'CLOSE_UTILITY_TAB',
          tabId: tab.id,
          appSessionId: activeSession.appSessionId,
        });
      });
    },
    [dispatch, activeSession.appSessionId],
  );
```

Replace the `onCloseTab` body:

```tsx
                    onCloseTab={(tab) => {
                      if (tab.tool === 'terminal') {
                        const status = peekTerminalInstance(tab.id)?.getState().status;
                        if (!tab.terminalId || status !== 'running') {
                          closeTerminalTab(tab);
                          return;
                        }
                        void terminalHasChildren(tab.terminalId).then((busy) => {
                          if (busy) setConfirmCloseTabId(tab.id);
                          else closeTerminalTab(tab);
                        });
                        return;
                      }
                      if (tab.tool === 'browser') setExpandedBrowserAppSessionId(null);
                      dispatch({ type: 'CLOSE_UTILITY_TAB', tabId: tab.id });
                    }}
                    confirmCloseTabId={confirmCloseTabId}
                    onConfirmClose={closeTerminalTab}
                    onCancelClose={() => setConfirmCloseTabId(null)}
```

`activeSession` is the value already in scope in that render block; if it is nullable there, use `activeSession?.appSessionId ?? ''` consistent with the surrounding code.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/App.tsx src/components/utility/UtilityPane.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/utility/UtilityPane.tsx
git commit -m "feat(terminal): close idle shells instantly and confirm busy ones in-app"
```

---

### Task 5: Release terminals when a chat is deleted, archived, or closed

**Files:**
- Modify: `src/lib/utilityPanel.ts` (add `removeSessionPanel`)
- Modify: `src/hooks/useStore.tsx:982`, `:1039`, `:1049`
- Modify: `src/App.tsx` (release effect)
- Test: `src/lib/utilityPanel.test.ts`

**Interfaces:**
- Produces: `removeSessionPanel(panels, appSessionId): Record<string, UtilityPanelState>`.

- [ ] **Step 1: Failing test** (append to `src/lib/utilityPanel.test.ts`, matching its existing import style)

```ts
test('removeSessionPanel drops only the given session', () => {
  const panels = {
    a: { open: true, tabs: [], activeTabId: null },
    b: { open: false, tabs: [], activeTabId: null },
  };
  const next = removeSessionPanel(panels, 'a');
  assert.deepEqual(Object.keys(next), ['b']);
  assert.equal(removeSessionPanel(next, 'zzz'), next);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test src/lib/utilityPanel.test.ts`
Expected: FAIL, `removeSessionPanel` not exported.

- [ ] **Step 3: Implement**

`src/lib/utilityPanel.ts`:

```ts
export function removeSessionPanel(
  panels: Record<string, UtilityPanelState>,
  appSessionId: string,
): Record<string, UtilityPanelState> {
  if (!(appSessionId in panels)) return panels;
  const next = { ...panels };
  delete next[appSessionId];
  return next;
}
```

`useStore.tsx`: import it, then in `ARCHIVE_CHAT` and `DELETE_CHAT`:

```ts
    case 'ARCHIVE_CHAT': {
      const chatMetadata = archiveChat(state.chatMetadata, action.appSessionId, Date.now());
      const utilityPanels = removeSessionPanel(state.utilityPanels, action.appSessionId);
      if (!chatMetadata && utilityPanels === state.utilityPanels) return state;
      return { ...state, chatMetadata: chatMetadata ?? state.chatMetadata, utilityPanels };
    }
```

Same shape for `DELETE_CHAT`. In `SESSION_CLOSED`, add `utilityPanels: removeSessionPanel(state.utilityPanels, action.appSessionId),` to the returned object.

`App.tsx`: add an effect that releases instances whose tab is gone:

```tsx
  const liveTerminalTabIds = useStoreSelector((current) =>
    Object.values(current.utilityPanels)
      .flatMap((panel) => panel.tabs)
      .filter((tab) => tab.tool === 'terminal')
      .map((tab) => tab.id)
      .join('\n'),
  );
  useEffect(() => {
    void releaseTerminalInstancesExcept(new Set(liveTerminalTabIds.split('\n').filter(Boolean)));
  }, [liveTerminalTabIds]);
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test src/lib/utilityPanel.test.ts src/hooks/useStoreUtilityPanel.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utilityPanel.ts src/lib/utilityPanel.test.ts src/hooks/useStore.tsx src/App.tsx
git commit -m "fix(terminal): release terminals when their chat goes away"
```

---

### Task 6: Process tree and listening-port parsers

**Files:**
- Create: `sidecar/src/processes/processTree.ts`, `sidecar/src/processes/listeningPorts.ts`
- Test: `sidecar/src/processes/processTree.test.ts`, `sidecar/src/processes/listeningPorts.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ProcessRecord { pid: number; ppid: number; startedAt: number; command: string }
export type CommandRunner = (file: string, args: string[]) => Promise<string>; // stdout
export function parsePsTable(stdout: string, now: number): ProcessRecord[];
export function descendantsOf(table: readonly ProcessRecord[], roots: Iterable<number>): ProcessRecord[];
export function listProcesses(run: CommandRunner, now: () => number): Promise<ProcessRecord[]>;
export function parseLsofListeners(stdout: string): Map<number, number[]>;
export function listListeningPorts(run: CommandRunner): Promise<Map<number, number[]>>;
export function defaultCommandRunner(file: string, args: string[]): Promise<string>;
```

- [ ] **Step 1: Failing tests**

`processTree.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { descendantsOf, parsePsTable } from './processTree.js';

const TABLE = [
  '    1     0     0 /sbin/launchd',
  '  500     1   500 /Applications/DROIDEX.app/Contents/MacOS/DROIDEX',
  '  600   500   600 /usr/local/bin/droid exec --input-format stream-jsonrpc',
  '  700   600   700 /bin/zsh -c npm run dev',
  '  800   700   700 node /w/node_modules/.bin/vite',
  '  900     1   900 unrelated',
].join('\n');

test('parsePsTable reads pid, ppid, elapsed seconds and command', () => {
  const rows = parsePsTable(TABLE, 10_000);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[4], { pid: 800, ppid: 700, startedAt: 10_000 - 700 * 1000, command: 'node /w/node_modules/.bin/vite' });
});

test('descendantsOf walks the tree under the roots only', () => {
  const rows = parsePsTable(TABLE, 10_000);
  assert.deepEqual(descendantsOf(rows, [600]).map((r) => r.pid), [700, 800]);
  assert.deepEqual(descendantsOf(rows, [999]), []);
});
```

The third column in the fixture is elapsed seconds (`etimes`). `parsePsTable` computes `startedAt = now - etimes * 1000`.

`listeningPorts.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLsofListeners } from './listeningPorts.js';

test('parseLsofListeners groups ports by pid', () => {
  const out = ['p800', 'n*:5173', 'n[::1]:5173', 'p900', 'n127.0.0.1:3000', 'n127.0.0.1:3001'].join('\n');
  const ports = parseLsofListeners(out);
  assert.deepEqual(ports.get(800), [5173]);
  assert.deepEqual(ports.get(900), [3000, 3001]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sidecar && node --import tsx --test src/processes/processTree.test.ts src/processes/listeningPorts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`processTree.ts`:

```ts
import { execFile } from 'node:child_process';

export interface ProcessRecord {
  pid: number;
  ppid: number;
  startedAt: number;
  command: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export function defaultCommandRunner(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(String(stdout));
    });
  });
}

// `ps -axo pid=,ppid=,etimes=,command=`: three numeric columns then the rest
// of the line is the command with its arguments.
export function parsePsTable(stdout: string, now: number): ProcessRecord[] {
  const rows: ProcessRecord[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: now - Number(match[3]) * 1000,
      command: match[4].trim(),
    });
  }
  return rows;
}

export function descendantsOf(
  table: readonly ProcessRecord[],
  roots: Iterable<number>,
): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const row of table) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const out: ProcessRecord[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export async function listProcesses(run: CommandRunner, now: () => number): Promise<ProcessRecord[]> {
  if (process.platform === 'win32') return [];
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,etimes=,command=']);
  return parsePsTable(stdout, now());
}
```

`listeningPorts.ts`:

```ts
import type { CommandRunner } from './processTree.js';

// `lsof -F pn` prints one field per line: `p<pid>` starts a process block and
// each `n<addr>` names a socket; only `:port` at the end matters here.
export function parseLsofListeners(stdout: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith('n') || pid === 0) continue;
    const match = /:(\d+)$/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    const list = ports.get(pid) ?? [];
    if (!list.includes(port)) list.push(port);
    ports.set(pid, list);
  }
  return ports;
}

export async function listListeningPorts(run: CommandRunner): Promise<Map<number, number[]>> {
  if (process.platform === 'win32') return new Map();
  try {
    const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    return parseLsofListeners(stdout);
  } catch {
    // lsof exits 1 when nothing listens; that is an empty result, not a failure.
    return new Map();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd sidecar && node --import tsx --test src/processes/processTree.test.ts src/processes/listeningPorts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/processes
git commit -m "feat(sidecar): parse process tree and listening ports"
```

---

### Task 7: `AgentProcessMonitor`

**Files:**
- Create: `sidecar/src/processes/AgentProcessMonitor.ts`
- Test: `sidecar/src/processes/AgentProcessMonitor.test.ts`

**Interfaces:**
- Consumes: Task 6 functions.
- Produces:

```ts
export interface AgentProcess { pid: number; name: string; command: string; startedAt: number; ports: number[] }
export interface AgentProcessMonitorDependencies {
  listProcesses: () => Promise<ProcessRecord[]>;
  listListeningPorts: () => Promise<Map<number, number[]>>;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  now: () => number;
}
export class AgentProcessMonitor {
  constructor(d: AgentProcessMonitorDependencies);
  track(appSessionId: string, rootPid: number): void;
  untrack(rootPid: number): void;
  processesFor(appSessionId: string): AgentProcess[];
  hasProcesses(appSessionId: string): boolean;
  snapshotPids(): Array<{ appSessionId: string; pid: number; startedAt: number }>;
  stop(appSessionId: string, pid: number): Promise<boolean>;       // tree-kill one, validated
  killSession(appSessionId: string): Promise<void>;                // tree-kill all descendants of the session's roots
  killRecorded(entries: ReadonlyArray<{ pid: number; startedAt: number }>): Promise<void>; // crash reaping
  scan(): Promise<void>;
  dispose(): void;
}
export function displayNameFor(command: string): string;
```

Constants: `TICK_MS = 2000`, `PORT_SCAN_EVERY = 3`, `MIN_AGE_MS = 1500`, `KILL_GRACE_MS = 3000`.

- [ ] **Step 1: Failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProcessMonitor, displayNameFor } from './AgentProcessMonitor.js';
import type { ProcessRecord } from './processTree.js';

function harness(rows: ProcessRecord[], ports = new Map<number, number[]>()) {
  const emitted: Array<[string, unknown]> = [];
  const killed: Array<[number, string]> = [];
  let timers: Array<() => void> = [];
  let time = 100_000;
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => rows,
    listListeningPorts: async () => ports,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      rows = rows.filter((r) => r.pid !== pid);
    },
    emit: (id, processes) => emitted.push([id, processes]),
    schedule: (cb) => {
      timers.push(cb);
      return { cancel() { timers = timers.filter((t) => t !== cb); } };
    },
    now: () => time,
  });
  const tick = async () => {
    const pending = timers;
    timers = [];
    for (const cb of pending) cb();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { monitor, emitted, killed, tick, advance: (ms: number) => { time += ms; }, setRows: (r: ProcessRecord[]) => { rows = r; } };
}

const rows: ProcessRecord[] = [
  { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
  { pid: 700, ppid: 600, startedAt: 0, command: '/bin/zsh -c npm run dev' },
  { pid: 800, ppid: 700, startedAt: 0, command: 'node /w/node_modules/.bin/vite' },
];

test('displayNameFor uses the leaf basename and a non-flag first argument', () => {
  assert.equal(displayNameFor('node /w/node_modules/.bin/vite'), 'vite');
  assert.equal(displayNameFor('/usr/bin/python3 -m http.server'), 'python3');
  assert.equal(displayNameFor('/w/node_modules/.bin/next dev'), 'next dev');
});

test('scan hides shell wrappers, emits once per change, and attaches ports', async () => {
  const h = harness(rows, new Map([[800, [5173]]]));
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  assert.deepEqual(h.emitted[0], ['s1', [{ pid: 800, name: 'vite', command: 'node /w/node_modules/.bin/vite', startedAt: 0, ports: [5173] }]]);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
});

test('processes younger than MIN_AGE_MS are not shown yet', async () => {
  const young = rows.map((r) => (r.pid === 800 ? { ...r, startedAt: 99_500 } : r));
  const h = harness(young);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 0);
  h.advance(2000);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
});

test('stop validates the pid against the session snapshot and tree-kills it', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(await h.monitor.stop('s1', 4242), false);
  assert.equal(await h.monitor.stop('s1', 800), true);
  assert.deepEqual(h.killed[0], [800, 'SIGTERM']);
});

test('killSession kills every descendant deepest first and emits an empty list', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  await h.monitor.killSession('s1');
  assert.deepEqual(h.killed.map(([pid]) => pid), [800, 700]);
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
});

test('killRecorded only touches pids whose start time still matches', async () => {
  const h = harness(rows);
  await h.monitor.killRecorded([{ pid: 800, startedAt: 0 }, { pid: 700, startedAt: 12345 }]);
  assert.deepEqual(h.killed.map(([pid]) => pid), [800]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sidecar && node --import tsx --test src/processes/AgentProcessMonitor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { descendantsOf, type ProcessRecord } from './processTree.js';

export interface AgentProcess {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  ports: number[];
}

export interface AgentProcessMonitorDependencies {
  listProcesses: () => Promise<ProcessRecord[]>;
  listListeningPorts: () => Promise<Map<number, number[]>>;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  now: () => number;
}

export const TICK_MS = 2000;
const PORT_SCAN_EVERY = 3;
const MIN_AGE_MS = 1500;
const KILL_GRACE_MS = 3000;
const WRAPPER = /^(?:\S*\/)?(?:sh|zsh|bash|fish|dash)\s+-l?c\b/;

export function displayNameFor(command: string): string {
  const words = command.split(/\s+/).filter(Boolean);
  let index = 0;
  const base = (word: string) => word.split('/').pop() ?? word;
  // Interpreters name the script, not themselves.
  if (/^(?:node|bun|deno|python\d*|ruby|perl)$/.test(base(words[0] ?? '')) && words[1] && !words[1].startsWith('-')) {
    index = 1;
  }
  const head = base(words[index] ?? command);
  const next = words[index + 1];
  return next && !next.startsWith('-') && !next.includes('/') ? `${head} ${next}` : head;
}

function sameList(a: AgentProcess[], b: AgentProcess[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.pid === y.pid && x.command === y.command && x.ports.join(',') === y.ports.join(',');
  });
}

export class AgentProcessMonitor {
  private readonly roots = new Map<number, string>(); // rootPid -> appSessionId
  private readonly current = new Map<string, AgentProcess[]>();
  private readonly descendants = new Map<string, ProcessRecord[]>();
  private ports = new Map<number, number[]>();
  private ticks = 0;
  private timer: { cancel(): void } | null = null;
  private scanning: Promise<void> | null = null;

  constructor(private readonly d: AgentProcessMonitorDependencies) {}

  track(appSessionId: string, rootPid: number): void {
    this.roots.set(rootPid, appSessionId);
    this.arm();
  }

  untrack(rootPid: number): void {
    this.roots.delete(rootPid);
    if (this.roots.size === 0) this.disarm();
  }

  processesFor(appSessionId: string): AgentProcess[] {
    return this.current.get(appSessionId) ?? [];
  }

  hasProcesses(appSessionId: string): boolean {
    return (this.descendants.get(appSessionId)?.length ?? 0) > 0;
  }

  snapshotPids(): Array<{ appSessionId: string; pid: number; startedAt: number }> {
    const out: Array<{ appSessionId: string; pid: number; startedAt: number }> = [];
    for (const [appSessionId, rows] of this.descendants) {
      for (const row of rows) out.push({ appSessionId, pid: row.pid, startedAt: row.startedAt });
    }
    return out;
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async stop(appSessionId: string, pid: number): Promise<boolean> {
    const rows = this.descendants.get(appSessionId) ?? [];
    const target = rows.find((row) => row.pid === pid);
    if (!target) return false;
    await this.killTree([target, ...descendantsOf(rows, [pid])]);
    await this.scan();
    return true;
  }

  async killSession(appSessionId: string): Promise<void> {
    await this.scan();
    const rows = this.descendants.get(appSessionId) ?? [];
    await this.killTree(rows);
    this.descendants.set(appSessionId, []);
    this.publish(appSessionId, []);
    for (const [pid, id] of this.roots) if (id === appSessionId) this.roots.delete(pid);
    if (this.roots.size === 0) this.disarm();
  }

  async killRecorded(entries: ReadonlyArray<{ pid: number; startedAt: number }>): Promise<void> {
    if (entries.length === 0) return;
    const table = await this.d.listProcesses();
    const alive = new Map(table.map((row) => [row.pid, row]));
    const matches = entries.flatMap((entry) => {
      const row = alive.get(entry.pid);
      // A reused pid has a different start time; leave it alone.
      return row && Math.abs(row.startedAt - entry.startedAt) < 2000 ? [row] : [];
    });
    await this.killTree(matches);
  }

  dispose(): void {
    this.disarm();
    this.roots.clear();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = this.d.schedule(() => {
      this.timer = null;
      void this.scan().finally(() => {
        if (this.roots.size > 0) this.arm();
      });
    }, TICK_MS);
  }

  private disarm(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private async scanOnce(): Promise<void> {
    if (this.roots.size === 0) return;
    const table = await this.d.listProcesses();
    const now = this.d.now();
    const bySession = new Map<string, number[]>();
    for (const [pid, appSessionId] of this.roots) {
      const list = bySession.get(appSessionId) ?? [];
      list.push(pid);
      bySession.set(appSessionId, list);
    }
    let sawNew = false;
    const nextDescendants = new Map<string, ProcessRecord[]>();
    for (const [appSessionId, rootPids] of bySession) {
      const rows = descendantsOf(table, rootPids);
      const known = new Set((this.descendants.get(appSessionId) ?? []).map((row) => row.pid));
      if (rows.some((row) => !known.has(row.pid))) sawNew = true;
      nextDescendants.set(appSessionId, rows);
    }
    for (const appSessionId of this.descendants.keys()) {
      if (!nextDescendants.has(appSessionId)) nextDescendants.set(appSessionId, []);
    }
    this.descendants.clear();
    for (const [id, rows] of nextDescendants) this.descendants.set(id, rows);
    this.ticks += 1;
    if (sawNew || this.ticks % PORT_SCAN_EVERY === 1) this.ports = await this.d.listListeningPorts();
    for (const [appSessionId, rows] of nextDescendants) {
      const visible = rows
        .filter((row) => now - row.startedAt >= MIN_AGE_MS && !WRAPPER.test(row.command))
        .map((row) => ({
          pid: row.pid,
          name: displayNameFor(row.command),
          command: row.command,
          startedAt: row.startedAt,
          ports: [...(this.ports.get(row.pid) ?? [])].sort((a, b) => a - b),
        }));
      this.publish(appSessionId, visible);
    }
  }

  private publish(appSessionId: string, processes: AgentProcess[]): void {
    const previous = this.current.get(appSessionId) ?? [];
    if (sameList(previous, processes)) return;
    this.current.set(appSessionId, processes);
    this.d.emit(appSessionId, processes);
  }

  // Deepest first so a parent cannot respawn a child we already signalled.
  private async killTree(rows: readonly ProcessRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const ordered = [...rows].reverse();
    for (const row of ordered) this.signal(row.pid, 'SIGTERM');
    await new Promise<void>((resolve) => {
      this.d.schedule(resolve, KILL_GRACE_MS);
    });
    const table = await this.d.listProcesses();
    const alive = new Set(table.map((row) => row.pid));
    for (const row of ordered) if (alive.has(row.pid)) this.signal(row.pid, 'SIGKILL');
  }

  private signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.d.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
```

In the test harness, `schedule` pushes callbacks; `killTree` awaits a scheduled grace timer, so the `stop`/`killSession` tests need to fire timers. Update the harness: make `schedule` invoke the callback on `setImmediate` when `ms === KILL_GRACE_MS`... simpler: in the harness `schedule: (cb, ms) => { if (ms === 3000) { setImmediate(cb); return { cancel() {} }; } timers.push(cb); ... }`. Apply that when the tests hang.

- [ ] **Step 4: Run tests**

Run: `cd sidecar && node --import tsx --test src/processes/AgentProcessMonitor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/processes
git commit -m "feat(sidecar): monitor agent-started processes per session"
```

---

### Task 8: Protocol, runtime pid handle, and renderer wire types

**Files:**
- Modify: `sidecar/src/protocol.ts` (ClientCommand near line 613, ServerEvent near line 799)
- Modify: `sidecar/src/DroidTransport.ts`, `sidecar/src/DroidRuntime.ts:90-96` and `createClient`
- Modify: `sidecar/src/testing/fakeFactoryRuntime.ts:434`, `sidecar/src/perf/replayRuntime.ts:184`
- Modify: `src/types/bridge.ts` (mirror both unions), `src/lib/bridgeWireValidation.ts:138`, `src/lib/commands.ts`
- Test: `sidecar/src/DroidTransport.test.ts`, `src/lib/bridgeWireValidation.test.ts` (extend if present)

**Interfaces:**
- Produces:

```ts
// protocol.ts and src/types/bridge.ts
export interface AgentProcess { pid: number; name: string; command: string; startedAt: number; ports: number[] }
| { type: 'session.processes'; appSessionId: string; processes: AgentProcess[] }     // ServerEvent
| { type: 'session.processes.stop'; appSessionId: string; pid: number }              // ClientCommand
// DroidTransport.ts
export type ConnectableDroidTransport = DroidClientTransport & { connect(): Promise<void>; readonly processId: number | undefined };
// DroidRuntime.ts FactoryRuntime
processIdOf(session: FactorySession): number | undefined;
// src/lib/commands.ts
export const stopAgentProcess = (appSessionId: string, pid: number) => void;
```

- [ ] **Step 1: Failing transport test** (append to `sidecar/src/DroidTransport.test.ts`)

```ts
test('processId reads the wrapped process pid', () => {
  const inner = {
    isConnected: true,
    childProcess: { pid: 777 },
    send() {}, onMessage() {}, onError() {}, close: async () => {},
  };
  const transport = wrapDroidTransport(inner as never);
  assert.equal(transport.processId, 777);
});
```

Export a `wrapDroidTransport(inner)` helper used by `createDroidTransport`.

- [ ] **Step 2: Implement**

`DroidTransport.ts`:

```ts
export type ConnectableDroidTransport = DroidClientTransport & {
  connect(): Promise<void>;
  readonly processId: number | undefined;
};

export function createDroidTransport(options: ProcessTransportOptions): ConnectableDroidTransport {
  return wrapDroidTransport(new ProcessTransport(options));
}

export function wrapDroidTransport(inner: DroidClientTransport): ConnectableDroidTransport {
  return new PermissionNormalizingTransport(inner);
}
```

and inside the class:

```ts
  // The SDK keeps the child private; the pid is the only thing read from it.
  get processId(): number | undefined {
    const child = (this.inner as { childProcess?: { pid?: number } }).childProcess;
    return typeof child?.pid === 'number' ? child.pid : undefined;
  }
```

`DroidRuntime.ts`: add `processIdOf(session: FactorySession): number | undefined;` to `FactoryRuntime`. In `DroidRuntime` add `private readonly processIds = new WeakMap<object, number>();` and:

```ts
  processIdOf(session: FactorySession): number | undefined {
    return this.processIds.get(session);
  }
```

In `createSession` and `loadSession`, after constructing `new DroidSession(...)`, before returning:

```ts
      const session = new DroidSession(client, init.sessionId, init);
      const pid = transport.processId;
      if (pid !== undefined) this.processIds.set(session, pid);
      return session;
```

`createClient` returns `transport` typed as `ConnectableDroidTransport` (change the return type annotation).

`fakeFactoryRuntime.ts` and `replayRuntime.ts`: add `processIdOf(): number | undefined { return undefined; }`.

`protocol.ts`: add the `AgentProcess` interface next to `SessionSummary`, the command after `session.close`, the event after `session.closed`. Mirror both in `src/types/bridge.ts` at the same places.

`bridgeWireValidation.ts`, in the `serverWireMessage` switch:

```ts
    case 'session.processes':
      return (
        typeof value.appSessionId === 'string' &&
        Array.isArray(value.processes) &&
        value.processes.every(
          (p: unknown) =>
            isRecord(p) &&
            typeof p.pid === 'number' &&
            typeof p.name === 'string' &&
            typeof p.command === 'string' &&
            typeof p.startedAt === 'number' &&
            Array.isArray(p.ports),
        )
      );
```

`commands.ts`:

```ts
export const stopAgentProcess = (appSessionId: string, pid: number) => {
  bridge.send({ type: 'session.processes.stop', appSessionId, pid });
};
```

- [ ] **Step 3: Typecheck both sides and run transport test**

Run: `npm run typecheck && npm run sidecar:typecheck && cd sidecar && node --import tsx --test src/DroidTransport.test.ts`
Expected: PASS. The sidecar `SessionManager` switch over `ClientCommand` may now fail exhaustiveness; add a temporary `case 'session.processes.stop': return;` there, replaced in Task 9.

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/protocol.ts sidecar/src/DroidTransport.ts sidecar/src/DroidTransport.test.ts sidecar/src/DroidRuntime.ts sidecar/src/testing/fakeFactoryRuntime.ts sidecar/src/perf/replayRuntime.ts sidecar/src/SessionManager.ts src/types/bridge.ts src/lib/bridgeWireValidation.ts src/lib/commands.ts
git commit -m "feat(bridge): add session.processes event and stop command"
```

---

### Task 9: Wire the monitor into session lifecycle, retirement, shutdown, and adoption

**Files:**
- Modify: `sidecar/src/SessionLifecycle.ts` (deps interface ~line 82, open at ~167 and ~255, `closeSessionResources` ~466)
- Modify: `sidecar/src/ChildSessions.ts` (deps, `closeRuntime` ~989) and `sidecar/src/childRuntimeOpen.ts` (~216-230, after `loaded = result`)
- Modify: `sidecar/src/sessionRuntimeRetirement.ts:30-62` and its deps (~132, ~242)
- Modify: `sidecar/src/SessionManager.ts` (construct monitor, pass deps, handle command, journal pids, shutdown)
- Modify: `sidecar/src/liveRuntimeJournal.ts` (`processes` array), `sidecar/src/sessionAdoption.ts` (write pids, reap on start)
- Test: `sidecar/src/SessionManager.sessionRetirement.test.ts` (one case), `sidecar/src/SessionLifecycle.test.ts` (one case)

**Interfaces:**
- Consumes: `AgentProcessMonitor` (Task 7), `FactoryRuntime.processIdOf` (Task 8).
- Produces: `SessionLifecycleDependencies.agentProcesses: Pick<AgentProcessMonitor, 'track' | 'untrack' | 'killSession'>`; `SessionRetirementFacts.hasAgentProcesses: boolean`; journal `processes: Array<{ appSessionId: string; pid: number; startedAt: number }>`.

- [ ] **Step 1: Failing lifecycle test** (add to `SessionLifecycle.test.ts`, using its existing fixture builder; the fixture takes overrides for dependencies)

```ts
test('closing a session tracks, then kills, its agent processes', async () => {
  const calls: string[] = [];
  const agentProcesses = {
    track: (id: string, pid: number) => { calls.push(`track:${id}:${String(pid)}`); },
    untrack: (pid: number) => { calls.push(`untrack:${String(pid)}`); },
    killSession: async (id: string) => { calls.push(`kill:${id}`); },
  };
  const fx = fixture({ agentProcesses, runtime: fakeRuntimeWithPid(4321) });
  const appSessionId = await fx.open();
  await fx.lifecycle.close(appSessionId);
  assert.deepEqual(calls, [`track:${appSessionId}:4321`, `kill:${appSessionId}`, 'untrack:4321']);
});
```

Where `fakeRuntimeWithPid` wraps the suite's fake runtime so `processIdOf` returns the given pid. Adapt names to the fixture that file already has (read its top 80 lines first).

- [ ] **Step 2: Wire `SessionLifecycle`**

Add to `SessionLifecycleDependencies`:

```ts
  agentProcesses: Pick<AgentProcessMonitor, 'track' | 'untrack' | 'killSession'>;
```

After `d.registry.register(liveSession);` in the create path (~line 197) and after the equivalent register in the load path (~255 onwards), add:

```ts
      const processId = d.runtime.processIdOf(session);
      if (processId !== undefined) d.agentProcesses.track(appSessionId, processId);
```

In `closeSessionResources`, after `await run(() => liveSession.session.close());`:

```ts
    await run(() => d.agentProcesses.killSession(liveSession.summary.appSessionId));
    const processId = d.runtime.processIdOf(liveSession.session);
    if (processId !== undefined) d.agentProcesses.untrack(processId);
```

Compaction swaps the provider session (`sessionCompactionExecution.ts:128,197` call `loadSession`). Where the swap installs the replacement session on the live session, add the same `track` for the new pid and `untrack` for the old one; search for `liveSession.session = ` in `sessionCompactionExecution.ts` and `SessionCompaction.ts` and apply at that assignment. Pass `agentProcesses` through their dependency types the same way.

- [ ] **Step 3: Wire child runtimes**

`ChildSessionsTypes.ts`: add `agentProcesses: Pick<AgentProcessMonitor, 'track' | 'untrack'>;` to the dependencies interface and `runtime: Pick<FactoryRuntime, 'loadSession' | 'processIdOf'>`.

`childRuntimeOpen.ts`, right after `loaded = result;`:

```ts
    const childPid = host.d.runtime.processIdOf(loaded);
    if (childPid !== undefined) host.d.agentProcesses.track(identity.parentAppSessionId, childPid);
```

`ChildSessions.ts` `closeRuntime`, before building `cleanupTasks`:

```ts
    const childPid = this.d.runtime.processIdOf(runtime.session);
    if (childPid !== undefined) this.d.agentProcesses.untrack(childPid);
```

Child descendants are killed by the parent's `killSession` because they are tracked under the parent id; a child runtime closing on its own (retirement, eviction) leaves its servers until the parent closes, which is acceptable for v1.

- [ ] **Step 4: Retirement fact**

`sessionRuntimeRetirement.ts`: add `hasAgentProcesses: boolean;` to `SessionRetirementFacts`, add `!facts.hasAgentProcesses &&` to `isRetirableSession`, add `hasAgentProcesses: (appSessionId: string) => boolean;` to the dependencies interface, and `hasAgentProcesses: d.hasAgentProcesses(appSessionId),` where facts are built (~line 242). Where `adoptedSessionFacts` builds facts in `sessionAdoption.ts`, pass `hasAgentProcesses: false`.

- [ ] **Step 5: `SessionManager` construction, command, journal, shutdown**

In the constructor, before `this.lifecycle = new SessionLifecycle({...})`:

```ts
    this.agentProcesses = new AgentProcessMonitor({
      listProcesses: () => listProcesses(defaultCommandRunner, Date.now),
      listListeningPorts: () => listListeningPorts(defaultCommandRunner),
      kill: (pid, signal) => process.kill(pid, signal),
      emit: (appSessionId, processes) => {
        this.emit({ type: 'session.processes', appSessionId, processes });
      },
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      },
      now: Date.now,
    });
```

Declare `private readonly agentProcesses: AgentProcessMonitor;`. Pass `agentProcesses: this.agentProcesses` into `SessionLifecycle`, `ChildSessions`, and `hasAgentProcesses: (id) => this.agentProcesses.hasProcesses(id)` into `SessionRuntimeRetirement`.

Command handling, replacing the temporary case from Task 8:

```ts
      case 'session.processes.stop':
        await this.agentProcesses.stop(cmd.appSessionId, cmd.pid);
        this.runtimeRetirement.arm();
        return;
```

Shutdown: `manager.shutdown()` already closes every session through `lifecycle.closeAll()`, which now kills descendants. After that, call `this.agentProcesses.dispose()`.

Journal: `liveRuntimeJournal.ts` adds `processes: Array<{ appSessionId: string; pid: number; startedAt: number }>` to `LiveRuntimeIdentities` with sanitizing (numbers finite and positive, string id), defaulting to `[]`. `sessionAdoption.ts` `persistLiveSet` includes `processes: this.dependencies.recordedProcesses()` where the dependency is `() => this.agentProcesses.snapshotPids()`. In `adoptOnce`, before resurrecting sessions:

```ts
    await this.dependencies.reapProcesses(identities.processes);
```

with `reapProcesses: (entries) => this.agentProcesses.killRecorded(entries)`. Also call `persistLiveSet` from the monitor's `emit` path so the journal tracks pids as they appear: in the `emit` dependency above, after `this.emit(...)`, call `this.adoption.persistLiveSet()` (make that method public if it is private).

- [ ] **Step 6: Retirement test** (add to `SessionManager.sessionRetirement.test.ts` following its fixture)

```ts
test('a session with live agent processes is not retired', async () => {
  // Arrange the suite's idle session fixture, then make the monitor report processes.
  // Assert that after the idle window elapses the session is still live.
});
```

Write it against the fixture that file uses (read it first): set `hasAgentProcesses` through the injected dependency the fixture exposes, or stub `agentProcesses.hasProcesses` on the manager instance.

- [ ] **Step 7: Run the sidecar suite**

Run: `npm run sidecar:typecheck && npm --prefix sidecar test`
Expected: PASS. Fix fixtures that construct `SessionLifecycle`, `ChildSessions`, or `SessionRuntimeRetirement` directly by adding the new dependency with no-op fakes (`track() {}`, `untrack() {}`, `killSession: async () => {}`, `hasAgentProcesses: () => false`).

- [ ] **Step 8: Commit**

```bash
git add sidecar/src
git commit -m "feat(sidecar): track, kill, and journal agent processes per session"
```

---

### Task 10: Store slice for agent processes

**Files:**
- Modify: `src/hooks/useStore.tsx` (state ~263, initial ~688, action union ~390, reducer, event mapping ~2145, `SESSION_CLOSED`)
- Test: `src/hooks/useStoreUtilityPanel.test.ts` style, new file `src/hooks/useStoreAgentProcesses.test.ts`

**Interfaces:**
- Produces: `state.agentProcesses: Record<string, AgentProcess[]>`; action `{ type: 'SESSION_PROCESSES'; appSessionId: string; processes: AgentProcess[] }`.

- [ ] **Step 1: Failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { reducer, initialState } from './useStore';   // use whatever the existing store tests import

test('session.processes replaces the list and session close clears it', () => {
  const processes = [{ pid: 1, name: 'vite', command: 'vite', startedAt: 0, ports: [5173] }];
  let state = reducer(initialState(), { type: 'SESSION_PROCESSES', appSessionId: 's1', processes });
  assert.deepEqual(state.agentProcesses.s1, processes);
  state = reducer(state, { type: 'SESSION_PROCESSES', appSessionId: 's1', processes: [] });
  assert.equal('s1' in state.agentProcesses, false);
  state = reducer(state, { type: 'SESSION_PROCESSES', appSessionId: 's1', processes });
  state = reducer(state, { type: 'SESSION_CLOSED', appSessionId: 's1' });
  assert.equal('s1' in state.agentProcesses, false);
});
```

Match the import names used by `useStoreUtilityPanel.test.ts`.

- [ ] **Step 2: Implement**

State: `agentProcesses: Record<string, AgentProcess[]>;` initial `{}` (not persisted). Action union: `| { type: 'SESSION_PROCESSES'; appSessionId: string; processes: AgentProcess[] }`. Reducer:

```ts
    case 'SESSION_PROCESSES': {
      const agentProcesses = { ...state.agentProcesses };
      if (action.processes.length === 0) delete agentProcesses[action.appSessionId];
      else agentProcesses[action.appSessionId] = action.processes;
      return { ...state, agentProcesses };
    }
```

`SESSION_CLOSED`: add `agentProcesses: removeKey(state.agentProcesses, action.appSessionId)` using the same `Object.fromEntries(...filter...)` pattern the case already uses. Event mapping:

```ts
    case 'session.processes':
      return { type: 'SESSION_PROCESSES', appSessionId: ev.appSessionId, processes: ev.processes };
```

- [ ] **Step 3: Run**

Run: `node --import tsx --test src/hooks/useStoreAgentProcesses.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useStore.tsx src/hooks/useStoreAgentProcesses.test.ts
git commit -m "feat(store): hold agent processes per session"
```

---

### Task 11: Composer chip and popover

**Files:**
- Create: `src/components/composer/RunningProcessesChip.tsx`
- Modify: `src/components/PromptInput.tsx:1712-1722` (after the Chat/Spec button)
- Modify: `src/index.css` (breathe keyframe)

**Interfaces:**
- Consumes: `state.agentProcesses`, `stopAgentProcess`, `openBrowser` (`src/lib/commands.ts`), `OPEN_UTILITY_TOOL`.
- Produces: `<RunningProcessesChip appSessionId={string} />`.

- [ ] **Step 1: CSS** (append inside the existing `@layer` block that holds `@keyframes shimmer`, following the file's pattern)

```css
  @keyframes process-breathe {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }
  .process-live-dot {
    animation: process-breathe 2.4s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .process-live-dot { animation: none; opacity: 1; }
  }
```

- [ ] **Step 2: Component**

```tsx
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Globe, Square } from 'lucide-react';
import { useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { openBrowser, stopAgentProcess } from '../../lib/commands';
import type { AgentProcess } from '../../types/bridge';

function elapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

export function RunningProcessesChip({ appSessionId }: { appSessionId: string }) {
  const processes = useStoreSelector((state) => state.agentProcesses[appSessionId]);
  const dispatch = useStoreDispatch();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!processes?.length) setOpen(false);
  }, [processes?.length]);

  if (!processes?.length) return null;
  const label = processes.length === 1 ? processes[0].name : `${String(processes.length)} running`;

  const openInBrowser = (process: AgentProcess) => {
    const port = process.ports[0];
    if (port === undefined) return;
    dispatch({ type: 'OPEN_UTILITY_TOOL', tool: 'browser' });
    openBrowser({ appSessionId, url: `http://localhost:${String(port)}` });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Processes started by the agent"
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors ${
          open
            ? 'bg-droid-bg/60 text-droid-text'
            : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
        }`}
      >
        <span className="process-live-dot h-1.5 w-1.5 rounded-full bg-droid-accent" />
        <span className="truncate max-w-[140px]">{label}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full left-0 mb-3 w-[300px] z-50"
          >
            <div className="rounded-2xl border border-droid-border bg-droid-elevated shadow-2xl shadow-black/50 overflow-hidden p-1">
              {processes.map((process) => {
                const port = process.ports[0];
                return (
                  <div
                    key={process.pid}
                    className="group flex h-8 items-center gap-2 rounded-xl px-2 text-[12px] transition-colors hover:bg-droid-bg/40"
                  >
                    <span className="process-live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-droid-accent" />
                    <span className="truncate text-droid-text" title={process.command}>
                      {process.name}
                    </span>
                    {port !== undefined && (
                      <span className="truncate text-droid-text-secondary">{`localhost:${String(port)}`}</span>
                    )}
                    <span className="ml-auto shrink-0 tabular-nums text-[11px] text-droid-text-muted group-hover:hidden">
                      {elapsed(process.startedAt, now)}
                    </span>
                    <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      {port !== undefined && (
                        <button
                          type="button"
                          title={`Open localhost:${String(port)}`}
                          onClick={() => openInBrowser(process)}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
                        >
                          <Globe className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Stop"
                        onClick={() => stopAgentProcess(appSessionId, process.pid)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
                      >
                        <Square className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="absolute -bottom-1.5 left-7 w-3 h-3 rotate-45 bg-droid-elevated border-r border-b border-droid-border" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 3: Mount in `PromptInput.tsx`**

After the Chat/Spec `</button>` and before `<div className="flex-1 min-w-0" />`:

```tsx
            {activeSession && <RunningProcessesChip appSessionId={activeSession.appSessionId} />}
```

Import `{ RunningProcessesChip } from './composer/RunningProcessesChip'`. If `PromptInput.tsx` grows past its current line count by more than these three lines, do not add anything else there.

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/composer/RunningProcessesChip.tsx src/components/PromptInput.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/composer/RunningProcessesChip.tsx src/components/PromptInput.tsx src/index.css
git commit -m "feat(composer): show agent processes in a toolbar chip"
```

---

### Task 12: Command card stays running while its process is alive

**Files:**
- Modify: `src/components/transcript/commandCard.tsx:9-20` and `:57-70` (`CommandLine`)

**Interfaces:**
- Consumes: `state.agentProcesses`, `state.activeAppSessionId`.

- [ ] **Step 1: Add the selector**

In `commandCard.tsx`:

```tsx
import { useStoreSelector } from '../../hooks/useStore';

// A backgrounded server keeps its card "running" after the turn ends as long
// as a live agent process still carries the command the agent typed.
function useCommandStillRunning(command: string): boolean {
  return useStoreSelector((state) => {
    const id = state.activeAppSessionId;
    const processes = id ? state.agentProcesses[id] : undefined;
    if (!processes?.length) return false;
    const needle = command.trim();
    return needle.length > 3 && processes.some((p) => p.command.includes(needle));
  });
}
```

In `CommandCard`, after the props: `const alive = useCommandStillRunning(command);` and use `running || alive` wherever `running` drives the shimmer. Do the same in `CommandLine` for its running indicator.

- [ ] **Step 2: Typecheck, lint, transcript tests**

Run: `npm run typecheck && npx eslint src/components/transcript/commandCard.tsx && node --import tsx --test src/components/transcript/*.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/transcript/commandCard.tsx
git commit -m "feat(transcript): keep command cards running while the process lives"
```

---

### Task 13: End-to-end verification in an isolated Electron instance

**Files:** none committed; scripts live in the scratchpad.

- [ ] **Step 1: Build and launch** following the memory note `isolated-electron-verification.md`: `npx vite build && npm run sidecar:build`, then Playwright `_electron.launch` with a scratch `HOME`, `DROIDEX_USER_DATA_DIR`, `--user-data-dir`, onboarding pre-completed, and `BRIDGE_PORT`/`BRIDGE_TOKEN`/`DROID_PATH`/`FACTORY_API_KEY`/`ELECTRON_START_URL` removed from the env.

- [ ] **Step 2: Terminal checks**
  - Open a terminal (Ctrl+`), run `seq 1 400`, scroll up 100 lines, switch chat, switch back. Expect the same scroll offset and no re-render flash; `document.querySelectorAll('.xterm').length === 1`.
  - Open two terminals, exit one with `exit`, switch between them. Expect the "Shell exited" line only on the exited tab; click Restart, expect a new prompt.
  - Run `sleep 300` in a terminal and press its close button. Expect the in-app "Stop and close" popover, not a native dialog. Close an idle terminal: no prompt.
  - Delete the chat. Expect `terminal-list` for that session to return `[]` (via `window` bridge `terminalList`).

- [ ] **Step 3: Process checks** (needs a real `droid` in the scratch env; otherwise simulate by launching `node -e "require('http').createServer().listen(5173)"` as a child of a fake root and calling the sidecar monitor directly in a Node script)
  - Chip appears within 4 s with the name and `localhost:5173`; the popover Open action opens the browser tool at that URL; Stop removes the row and the chip fades.
  - Close the chat: `lsof -iTCP:5173` is empty.
  - `kill -9` the sidecar while a server runs, relaunch: the server is reaped on start.

- [ ] **Step 4: Full suites**

Run: `npm test && npm --prefix sidecar test && npm run lint && npm run typecheck && npm run sidecar:typecheck && npm run electron:check`
Expected: PASS.

- [ ] **Step 5: Record findings** in the final report; no commit unless a bug was fixed.

---

### Task 14: Terminal chrome redesign

**Files:**
- Modify: `src/components/terminal/TerminalWorkspace.tsx` (header, status lines, viewport padding)
- Modify: `src/index.css` (xterm viewport scrollbar and selection polish, inside the existing `@layer` that styles `::-webkit-scrollbar`)
- Modify: `src/lib/terminalInstances.ts` only if an xterm option (`fontSize`, `lineHeight`, `letterSpacing`, `scrollback`) needs tuning

**Interfaces:**
- Consumes: `TerminalInstance` from Task 2 (`getState().shellName`, `status`, `error`, `truncated`; `copySelection`, `clear`, `reset`, `restart`).
- Produces: no new interfaces.

**Design direction (the user's words on 2026-09-11: the terminal shell UI is "so bad and full of monospace ugly UI"):**

- Monospace is allowed only inside the xterm viewport. Every other text in the panel uses the system sans and the `droid-*` tokens.
- **Header (32 px):** left, the shell name from `shellName` in `text-[12px] text-droid-text` followed by the working directory's last path segment in `text-droid-text-secondary`, the full path in a `HoverTooltip` (`src/components/HoverTooltip.tsx`). Right, the actions Copy selection, Clear, and Reset as 28 px icon buttons that sit at `opacity-0` and become visible on header hover or focus-within (`group` on the header, `group-hover:opacity-100 focus-visible:opacity-100`). No borders around icons, no filled boxes. When the shell has exited, a Restart action replaces Clear and Reset and is always visible.
- **Status lines:** remove the tinted banners. `starting` shows one muted line inside the viewport area, `Starting zsh…`, in `text-[12px] text-droid-text-muted`, centered vertically, replaced by the viewport once running. `exited` shows a single hairline-bordered row above the viewport, `Shell exited` in `text-droid-text-secondary` with the Restart action inline (`text-droid-text`, hover `bg-droid-elevated`). `error` uses the same row with the message in `text-droid-red` (the `--droid-red` token exists). `truncated` is a one-line muted note `Earlier output was trimmed` that fades in above the viewport and never tints the background.
- **Viewport:** 12 px padding on the xterm host, background equal to `theme.bg`, and the `.xterm-viewport` scrollbar styled like the app's thin scrollbar (reuse the values from the existing `::-webkit-scrollbar-thumb` rule in `src/index.css`, scoped to `.xterm-viewport`). Selection color stays the accent at 20 percent.
- **Motion:** header actions fade over 120 ms; nothing else animates.

- [ ] **Step 1: Implement the header, status lines, and viewport styling** per the direction above. Keep `TerminalWorkspace.tsx` under 220 lines; extract `TerminalHeader` and `TerminalStatusRow` as local components in the same file only if it stays readable.

- [ ] **Step 2: Visual verification in an isolated Electron instance** following the memory note `isolated-electron-verification.md`: `npx vite build`, launch with a scratch `HOME`, `DROIDEX_USER_DATA_DIR`, `--user-data-dir`, pre-completed onboarding, and the sidecar env removed. Open a terminal (Ctrl+`), run `ls`, and screenshot the pane in both themes (`resize_window`-equivalent via `page.emulateMedia({ colorScheme })`). Then `exit` the shell and screenshot the exited row. Save screenshots to the plan workspace and list their paths in the report.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/terminal src/lib/terminalInstances.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/TerminalWorkspace.tsx src/index.css src/lib/terminalInstances.ts
git commit -m "feat(terminal): redesign the terminal chrome"
```

---

## Self-review

- Terminal chrome redesign (T14) added 2026-09-11 at the user's request.
- Spec coverage: registry (T2), thin component and key (T3), close flow (T1, T4), chat deletion (T5), restart line (T2/T3), sans header (T3), parsers (T6), monitor and stop command (T7, T9), retirement fact (T9), journal reaping (T9), shutdown (T9 via `closeAll`), event and command wire types (T8), store (T10), chip and popover (T11), command card (T12), verification (T13).
- Known gap accepted: child runtime retirement leaves that child's servers until the parent closes (noted in T9).
- Names are consistent: `agentProcesses`, `AgentProcess`, `session.processes`, `session.processes.stop`, `stopAgentProcess`, `terminalHasChildren`, `acquireTerminalInstance` / `releaseTerminalInstance` / `releaseTerminalInstancesExcept` / `peekTerminalInstance`, `processIdOf`.
