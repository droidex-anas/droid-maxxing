import { TriangleAlert } from 'lucide-react';

export function AppBlockErrorFallback({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="my-2 flex min-h-28 items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
        <TriangleAlert className="h-4 w-4" />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-[13px] font-medium text-droid-text">Interactive App couldn’t start</p>
        <p className="mt-1 text-[12px] leading-5 text-droid-text-secondary">
          Ask Droid to fix this visualization, then play the revised App.
        </p>
        <p className="mt-2 truncate font-mono text-[10.5px] text-droid-text-muted" title={message}>
          {message}
        </p>
      </div>
    </div>
  );
}
