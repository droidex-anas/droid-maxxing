import { useState } from 'react';
import { stripAnsi } from '../../lib/tools';
import { copyTextForCommand } from '../../features/transcript-reach/transcriptCopy';
import { Caret, CopyButton, ErrorTag, Expand, linkify, RED, ToolPanel } from './primitives';

/* ── Terminal-style command body: the command and its captured output, in the
   same bordered panel language as expanded diffs. No header chrome — the `$`
   prompt says what this is. Rendered inline at the detailed density and as the
   expansion of a CommandLine. ── */
export function CommandCard({
  command,
  output,
  error = false,
}: {
  command: string;
  output?: string;
  error?: boolean;
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
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100 transition-opacity">
        <CopyButton text={copyTextForCommand(command, output)} />
      </div>
      <div className="px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.6]">
        <div className="flex gap-2 break-words">
          <span
            className="select-none text-droid-text-muted"
            style={error ? { color: RED } : undefined}
          >
            $
          </span>
          <span className="whitespace-pre-wrap text-droid-text">{command}</span>
        </div>
        {out && (
          <pre
            className="mt-2 pt-2 border-t border-droid-border/60 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] break-words text-droid-text-muted"
            style={error ? { color: RED } : undefined}
          >
            {error ? out : linkify(out)}
          </pre>
        )}
      </div>
    </ToolPanel>
  );
}

/* ── One-line form of a shell call: "› Ran `cmd`", expanding to the full
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
  const expanded = open || forceOpen;
  if (running) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shimmer-text shrink-0 text-[12.5px] font-medium">Running</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-droid-text-muted">
          {command}
        </span>
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] leading-relaxed"
        aria-expanded={expanded}
      >
        <Caret open={expanded} />
        <span className="shrink-0 text-droid-text-secondary">Ran</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-droid-text-muted">
          {command}
        </span>
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
