import { useContext, useState } from 'react';
import { commandLineContains } from '../../lib/commandLineMatch';
import { LiveProcessesContext } from './liveProcessesContext';
import { stripAnsi } from '../../lib/tools';
import { Caret, ErrorTag, Expand, linkify, RED, ToolPanel } from './primitives';

// A backgrounded server keeps its card "running" after the turn ends as long
// as a live agent process still carries the command the agent typed.
function useCommandStillRunning(command: string): boolean {
  const processes = useContext(LiveProcessesContext);
  if (processes.length === 0) return false;
  const needle = command.trim();
  return (
    needle.length > 3 &&
    processes.some(
      (p) =>
        commandLineContains(p.command, needle) ||
        (p.originCommand !== undefined && commandLineContains(p.originCommand, needle)),
    )
  );
}

/* ── Terminal-style body shared by every tool call: what was called, then
   what came back, in the same bordered panel language as expanded diffs. No
   header chrome — the heading (a `$` prompt for a shell call, the arguments
   for any other tool) says what this is. ── */
export function ToolCallCard({
  heading,
  output,
  error = false,
  running = false,
}: {
  heading: React.ReactNode;
  output?: string;
  error?: boolean;
  running?: boolean;
}) {
  const out = output ? stripAnsi(output).trimEnd() : '';
  return (
    <ToolPanel
      className="group relative"
      style={
        error
          ? { borderColor: 'color-mix(in srgb, var(--droid-red) 30%, var(--droid-border))' }
          : undefined
      }
    >
      <div className="px-3.5 py-2.5 font-mono text-[12px] leading-[1.6]">
        {heading}
        {running && <span className="shimmer-text text-[13px] font-medium">Running</span>}
        {out && (
          <pre
            className="mt-2 pt-2 border-t border-droid-border/60 max-h-56 overflow-auto whitespace-pre-wrap text-[12px] leading-[1.55] break-words text-droid-text-muted"
            style={error ? { color: RED } : undefined}
          >
            {error ? out : linkify(out)}
          </pre>
        )}
      </div>
    </ToolPanel>
  );
}

export function CommandCard({
  command,
  output,
  error = false,
  running = false,
}: {
  command: string;
  output?: string;
  error?: boolean;
  running?: boolean;
}) {
  const alive = useCommandStillRunning(command);
  return (
    <ToolCallCard
      heading={
        <div className="flex gap-2 break-words">
          <span
            className="select-none text-droid-text-muted"
            style={error ? { color: RED } : undefined}
          >
            $
          </span>
          <span className="whitespace-pre-wrap text-droid-text">{command}</span>
        </div>
      }
      output={output}
      error={error}
      running={running || alive}
    />
  );
}

/* ── One-line form of a shell call: "› Ran cmd", expanding to the full
   CommandCard. This is how exec tools render at the compact and balanced
   densities; a failed call carries the error tag on the line itself. ── */
export function CommandLine({
  command,
  output,
  error = false,
  running = false,
  forceOpen = false,
}: {
  command: string;
  output?: string;
  error?: boolean;
  running?: boolean;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const alive = useCommandStillRunning(command);
  const expanded = open || forceOpen;
  const label = (
    <>
      {running || alive ? (
        <span className="shimmer-text shrink-0 font-medium">Running</span>
      ) : (
        <span className="shrink-0 text-droid-text-secondary">Ran</span>
      )}
      <span className="min-w-0 truncate text-droid-text-muted">{command}</span>
    </>
  );
  // Only a still-running turn hides the expander: a finished call whose
  // process is still alive already has captured output, and that output must
  // stay reachable. It keeps the Running indicator in place of "Ran".
  if (running) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-relaxed">
        <span className="w-3 shrink-0" aria-hidden="true" />
        {label}
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[13px] leading-relaxed"
        aria-expanded={expanded}
      >
        <Caret open={expanded} />
        {label}
        {error && <ErrorTag />}
      </button>
      <Expand open={expanded}>
        <div className="mt-1.5 pl-[18px]">
          <CommandCard command={command} output={output} error={error} />
        </div>
      </Expand>
    </div>
  );
}
