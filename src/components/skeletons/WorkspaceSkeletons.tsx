function SkeletonLine({ width, height = 'h-3' }: { width: string; height?: string }) {
  return <div className={`skeleton-block ${height}`} style={{ width }} aria-hidden="true" />;
}

export function PanelSkeleton({ title }: { title: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${title}`}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-droid-bg"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-droid-border px-3">
        <SkeletonLine width="28%" height="h-3.5" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden p-4">
        <SkeletonLine width="72%" />
        <SkeletonLine width="88%" />
        <SkeletonLine width="64%" />
        <SkeletonLine width="80%" />
      </div>
    </div>
  );
}

export function UtilityPaneSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading utility workspace"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-droid-bg"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-droid-border px-2">
        <SkeletonLine width="18%" height="h-7" />
        <SkeletonLine width="18%" height="h-7" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden p-4">
        <SkeletonLine width="72%" />
        <SkeletonLine width="88%" />
        <SkeletonLine width="64%" />
      </div>
    </div>
  );
}

export function SettingsPanelSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading settings"
      className="fixed inset-0 z-50 flex bg-droid-bg/80 backdrop-blur-sm"
    >
      <div className="flex h-full w-full max-w-5xl mx-auto border border-droid-border bg-droid-bg shadow-2xl">
        <aside className="w-56 shrink-0 border-r border-droid-border p-4 space-y-3">
          <SkeletonLine width="60%" />
          <SkeletonLine width="80%" />
          <SkeletonLine width="70%" />
          <SkeletonLine width="75%" />
        </aside>
        <main className="flex-1 p-6 space-y-4">
          <SkeletonLine width="40%" height="h-4" />
          <SkeletonLine width="92%" />
          <SkeletonLine width="86%" />
          <SkeletonLine width="78%" />
        </main>
      </div>
    </div>
  );
}

export function CommandPaletteSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[18vh]"
    >
      <div className="w-full max-w-xl rounded-2xl border border-droid-border bg-droid-elevated p-4 shadow-2xl">
        <SkeletonLine width="100%" height="h-10" />
        <div className="mt-3 space-y-2">
          <SkeletonLine width="88%" height="h-8" />
          <SkeletonLine width="76%" height="h-8" />
          <SkeletonLine width="82%" height="h-8" />
        </div>
      </div>
    </div>
  );
}

export function OnboardingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading setup"
      className="fixed inset-0 z-50 flex items-center justify-center bg-droid-bg"
    >
      <div className="w-full max-w-lg space-y-4 px-8">
        <SkeletonLine width="48%" height="h-6" />
        <SkeletonLine width="92%" />
        <SkeletonLine width="84%" />
        <SkeletonLine width="70%" />
      </div>
    </div>
  );
}

export function MissionControlSkeleton() {
  return (
    <div role="status" aria-label="Loading mission control" className="flex h-full flex-col p-6">
      <SkeletonLine width="36%" height="h-5" />
      <div className="mt-6 grid flex-1 grid-cols-2 gap-4">
        <div className="rounded-xl border border-droid-border p-4 space-y-3">
          <SkeletonLine width="54%" />
          <SkeletonLine width="88%" />
          <SkeletonLine width="72%" />
        </div>
        <div className="rounded-xl border border-droid-border p-4 space-y-3">
          <SkeletonLine width="48%" />
          <SkeletonLine width="80%" />
          <SkeletonLine width="66%" />
        </div>
      </div>
    </div>
  );
}

export function PullRequestsSkeleton() {
  return (
    <div role="status" aria-label="Loading pull requests" className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-droid-border px-4">
        <SkeletonLine width="24%" height="h-4" />
      </div>
      <div className="flex-1 space-y-3 p-4">
        <SkeletonLine width="100%" height="h-14" />
        <SkeletonLine width="100%" height="h-14" />
        <SkeletonLine width="100%" height="h-14" />
      </div>
    </div>
  );
}

export function SpecWikiSkeleton() {
  return null;
}
