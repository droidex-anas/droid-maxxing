import { useEffect, useRef, useState } from 'react';
import { Globe, Square } from '@droidex/icons';
import { Popover } from './environment/Popover';
import { useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { openBrowser, stopAgentProcess } from '../lib/commands';
import type { AgentProcess } from '../types/bridge';

// Stable identity for the common empty case, so an idle session never
// re-renders the header on an unrelated store change.
const NONE: AgentProcess[] = [];

function elapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

/**
 * Live dev servers and other processes the agent started, as one button beside
 * the chat title that opens the list. Absent entirely while nothing is
 * running.
 */
export function RunningProcessesMenu({ appSessionId }: { appSessionId: string }) {
  const processes = useStoreSelector((state) => state.agentProcesses[appSessionId] ?? NONE);
  const dispatch = useStoreDispatch();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const buttonRef = useRef<HTMLButtonElement>(null);
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

  // Stopping the last process takes the button away, so the list goes with it.
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  if (count === 0) return null;

  const openInBrowser = (port: number) => {
    dispatch({ type: 'OPEN_UTILITY_TOOL', tool: 'browser' });
    openBrowser({ appSessionId, url: `http://localhost:${String(port)}` });
    setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={`${String(count)} running ${count === 1 ? 'process' : 'processes'} started by the agent`}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/60 ${
          open
            ? 'bg-droid-elevated text-droid-text'
            : 'bg-droid-elevated/60 text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
        }`}
      >
        <Globe className="h-3.5 w-3.5" />
        {count}
      </button>

      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={buttonRef}
        label="Running processes"
        align="left"
        width={260}
      >
        <div className="max-h-[min(70vh,400px)] overflow-y-auto p-1">
          {processes.map((process) => {
            const port = process.ports.at(0);
            return (
              <div
                key={process.pid}
                className="group flex h-8 items-center gap-2 rounded-lg px-2 text-[12px] transition-colors hover:bg-droid-elevated/60"
              >
                <span className="min-w-0 flex-1 truncate text-droid-text" title={process.command}>
                  {process.name}
                </span>
                {port !== undefined && (
                  <span className="shrink-0 truncate text-droid-text-muted">{`localhost:${String(port)}`}</span>
                )}
                {/* Fixed-width slot sized for the two-button cluster, the
                    widest occupant; the elapsed time overlays it
                    absolutely so hover/focus swaps between them without
                    reflowing the row. */}
                <span className="relative ml-2 h-6 w-14 shrink-0">
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 tabular-nums text-[11px] text-droid-text-muted transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                    {elapsed(process.startedAt, now)}
                  </span>
                  <span className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5 pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    {port !== undefined && (
                      <button
                        type="button"
                        title={`Open localhost:${String(port)}`}
                        onClick={() => {
                          openInBrowser(port);
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
                </span>
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
