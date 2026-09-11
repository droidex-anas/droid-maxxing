# Persistent terminals and agent process visibility

Date: 2026-09-10. Branch: `claude/terminal-agent-processes-865943`, based on `origin/main` at `da5af47a`.

## Problems

1. **Terminals break across chat switches.** The utility pane mounts only the active tab, so leaving a chat disposes the xterm instance. Returning creates a fresh xterm and replays up to 2 MiB of raw PTY output into it. The replay was produced at the old pane size, the scroll position is gone, and escape state that scrolled out of the buffer is reconstructed wrong. Users see a terminal that does not scroll or looks corrupted.
2. **Terminal state leaks between tabs.** `UtilityPane` renders `renderTab(activeTab)` without a React key, so two terminal tabs share one `TerminalWorkspace` instance. `status` and `truncated` from one tab carry over to the next.
3. **Closing and reopening is rough.** Closing a tab pops a native `window.confirm`, even for a shell that already exited. Revisiting a tab more than 30 s after its shell exited silently spawns a new shell under the same tab. Deleting or archiving a chat never closes its terminals, so PTY slots leak until quit.
4. **Agent-started processes are invisible and outlive the app.** The process chain is Electron main → sidecar → `droid exec` → agent shell → dev server. On quit only the direct `droid` child receives SIGTERM, so its descendants are reparented to launchd and keep running. Nothing records a pid, a listening port, or "still running". The transcript infers "running" from "tool call without result while the turn is live", so a backgrounded server renders as finished as soon as the turn ends.

## Part 1: Persistent terminals (renderer)

### Registry

`src/lib/terminalInstances.ts` owns one live xterm per terminal tab for as long as the tab exists:

```ts
interface TerminalInstance {
  tabId: string;
  terminalId: string | null;      // null until the PTY is created
  element: HTMLDivElement;         // xterm's host, re-parented on mount
  terminal: Terminal;
  fit: FitAddon;
  channel: TerminalDataChannel | null;
  pump: TerminalOutputPump;
  status: 'starting' | 'running' | 'exited' | 'error';
  error: string;
  truncated: boolean;
  listeners: Set<() => void>;      // status change subscribers
}
```

- `acquire(tabId, options)` returns the existing instance or creates one. Creation loads xterm and the fit addon, opens the terminal into a detached `element`, creates the PTY through `ensureTerminalForTab`, subscribes the MessagePort, and wires `onData` to `postInput`.
- `release(tabId)` disposes the xterm, closes the channel, unsubscribes, and drops the entry. Called only when the tab closes or its chat is deleted or archived.
- The pump's `isHidden` is `!element.isConnected || element.clientWidth < 8 || document.hidden`, so output arriving while the tab is unmounted is buffered exactly as it is today for a hidden pane. The MessagePort stays subscribed while unmounted, so main's replay buffer is only consulted after a renderer reload.
- `restart(tabId)` kills the exited PTY, creates a new one, and resets the xterm. This replaces the silent respawn.

### Component

`TerminalWorkspace` becomes a thin mount: on mount it appends `instance.element` into its host, calls `fit`, `pump.reveal()`, and focuses; on unmount it removes the element from the DOM without disposing. Status, error, and truncation come from the instance through a `useSyncExternalStore` subscription. The header path label uses the system sans, not monospace. An exited shell shows a single line with a Restart action.

`UtilityPane` keys the tab panel with `key={activeTab.id}`.

### Lifecycle

- **Close tab.** If the shell has exited, close immediately. Otherwise ask main whether the PTY has child processes (`terminal-has-children`, a `pgrep -P <shell pid>` check in `electron/terminal.cjs`; Windows answers true so the confirmation stays). Idle shell: close immediately. Running child: show the existing `Popover` anchored to the close button with one line ("Stop `vite` and close?") and a Stop button. No native dialogs.
- **Delete or archive chat.** `DELETE_CHAT` and `ARCHIVE_CHAT` reducers prune `utilityPanels[appSessionId]` (`SESSION_CLOSED` does not: idle runtime retirement closes the provider process while the chat and its PTYs stay); a store effect releases every terminal instance whose tab disappeared and kills its PTY.
- **Renderer reload.** Instances are lost with the document; the existing replay path restores content on the next mount.

### Tests

- `terminalInstances.test.ts`: acquire is idempotent per tab, release disposes once, hidden output buffers until reveal, restart replaces the PTY id.
- Extend `utilityPanel.test.ts` for chat deletion pruning.

## Part 2: Agent process monitor (sidecar)

### Process tree

`sidecar/src/processes/processTree.ts`: one `ps -axo pid=,ppid=,pgid=,lstart=,command=` call returns the whole table; `descendantsOf(rootPids)` walks it. `sidecar/src/processes/listeningPorts.ts`: `lsof -nP -iTCP -sTCP:LISTEN -Fpn` returns `pid → ports[]`. Both are pure parsers over injected command runners so they are unit-testable with captured output. Windows runners return empty results for now.

### Monitor

`sidecar/src/processes/AgentProcessMonitor.ts`:

- Roots: the `droid exec` pid of each live top-level session and of each live child runtime, mapped to the owning `appSessionId`. `DroidTransport` exposes `processId` from the wrapped `ProcessTransport`; `DroidSession` carries it; `SessionLifecycle` registers and unregisters roots on open and close.
- Tick: every 2 s while any root exists, `ps` once; every third tick, or immediately when a new descendant appears, `lsof`. Descendants younger than 1.5 s and shell wrappers (`sh -c`, `zsh -c`, `bash -c`, `droid` itself) are hidden; the displayed name is the leaf executable basename with its first argument when it is not a flag (`vite`, `next dev`) — except for interpreters (`node`, `python`, `ruby`, …), where the script basename alone is shown (`node server.js` displays as `server.js`).
- Emits `session.processes` only when the per-session list changes:

```ts
interface AgentProcess {
  pid: number;
  name: string;         // display name
  command: string;      // full command line
  startedAt: number;
  ports: number[];
}
{ type: 'session.processes'; appSessionId: string; processes: AgentProcess[] }
```

- Command `session.processes.stop { appSessionId, pid }` tree-kills one process (children first, SIGTERM, SIGKILL after 3 s). Pids are validated against the current snapshot for that session so a stale pid cannot hit an unrelated process.

### Cleanup

- `closeSessionResources` tree-kills the session's descendants after `session.close()`, before the browser closes. Runtime retirement and sidecar shutdown reuse the same close, so they inherit it.
- A session with live agent processes is not retirable: `SessionRetirementFacts` gains `hasAgentProcesses`.
- `live-runtime.json` records the descendant pids and start times per session. On sidecar start, `SessionAdoption` reaps any recorded pid whose start time still matches, so a crash or SIGKILL does not leave servers behind.

### Tests

- Parser tests with captured `ps` and `lsof` output.
- Monitor tests with a fake command runner: emits on change only, hides wrappers and infants, stop validates against the snapshot.
- `SessionLifecycle` test: close kills descendants, retirement blocked while processes live.

## Part 3: Surface (renderer)

Store: `agentProcesses: Record<appSessionId, AgentProcess[]>`, updated by `session.processes`, cleared by `SESSION_CLOSED`.

### Chip

`src/components/composer/RunningProcessesChip.tsx` sits in the composer's bottom toolbar, in the left cluster right after the Chat/Spec toggle, and renders only while the active session has processes. It uses the same toolbar button recipe as its neighbours (`px-2 py-1 rounded-lg text-[11px]`, secondary text, `hover:bg-droid-bg/40`, open state `bg-droid-bg/60`), so it reads as part of the row rather than a badge.

Content is a 6 px accent dot followed by a label. One process: its display name (`vite`). Several: `3 running`. The dot breathes with a 2.4 s ease-in-out opacity cycle between 0.45 and 1 and stops under `prefers-reduced-motion`. That breathing is the only indication that something is alive; no glow, no ring, no count bubble.

### Popover

Clicking the chip opens a panel above it using the `ModelSelectorPopover` container recipe: `absolute bottom-full left-0 mb-3`, `motion.div` with the same 8 px rise and 0.98 scale, hairline border, `bg-droid-elevated`, the small rotated caret at the bottom edge. Width 300 px. Escape and outside click close it; the chip toggles it.

Each row: the accent dot, display name in primary text, the address `localhost:5173` in secondary text when a port exists, elapsed time right-aligned in muted tabular numerals. On hover the time yields to two icon buttons in the existing `TerminalButton` style: Open, which opens the in-app browser tool for this session through `OPEN_UTILITY_TOOL` plus `openBrowser` with the URL and closes the popover, and Stop, which sends `session.processes.stop`. A row with no port has only Stop. The panel has no header; when the last process ends the popover closes and the chip fades out with the toolbar's `transition-opacity`.

The transcript command card keeps its "Running" state while a process whose command line contains the tool call's command is alive; otherwise unchanged. No sidebar indicator and no strip above the composer.

## Out of scope

Windows process discovery, correlating processes to specific tool calls beyond the substring match, and a global process panel.
