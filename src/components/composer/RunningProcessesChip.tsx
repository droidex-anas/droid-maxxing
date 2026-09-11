import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Globe, Square } from 'lucide-react';
import { useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { openBrowser, stopAgentProcess } from '../../lib/commands';
import type { AgentProcess } from '../../types/bridge';

// Stable identity for the common empty case, so an idle session never
// re-renders the composer on an unrelated store change.
const NONE: AgentProcess[] = [];

function elapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

// Processes report every port they listen on; the first is the one worth
// opening, and a process with none (a watcher, a build) simply has no link.
function primaryPort(process: AgentProcess): number | undefined {
  return process.ports[0];
}

/**
 * Live dev servers and other processes the agent started, as one toolbar chip
 * that opens a list. Absent entirely while nothing is running.
 */
export function RunningProcessesChip({ appSessionId }: { appSessionId: string }) {
  const processes = useStoreSelector((state) => state.agentProcesses[appSessionId] ?? NONE);
  const dispatch = useStoreDispatch();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const count = processes.length;

  // The elapsed column is the only thing that needs a clock, so it only ticks
  // while the list is on screen.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
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

  // Stopping the last process takes the chip away, so the list goes with it.
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  if (count === 0) return null;
  const label = count === 1 ? processes[0].name : `${String(count)} running`;

  const openInBrowser = (process: AgentProcess) => {
    const port = primaryPort(process);
    if (port === undefined) return;
    dispatch({ type: 'OPEN_UTILITY_TOOL', tool: 'browser' });
    openBrowser({ appSessionId, url: `http://localhost:${String(port)}` });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title="Processes started by the agent"
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors ${
          open
            ? 'bg-droid-bg/60 text-droid-text'
            : 'text-droid-text-secondary hover:text-droid-text hover:bg-droid-bg/40'
        }`}
      >
        <span className="process-live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-droid-accent" />
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
                const port = primaryPort(process);
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
                    {/* Hover swaps the quiet elapsed time for the two actions,
                        so the resting list stays a plain list. */}
                    <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      {port !== undefined && (
                        <button
                          type="button"
                          title={`Open localhost:${String(port)}`}
                          onClick={() => {
                            openInBrowser(process);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-bg/60 hover:text-droid-text"
                        >
                          <Globe className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Stop"
                        onClick={() => {
                          stopAgentProcess(appSessionId, process.pid);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-bg/60 hover:text-droid-text"
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
