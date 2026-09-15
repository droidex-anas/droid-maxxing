import { Download } from 'lucide-react';
import { Spinner } from '@droidex/icons';
import { useStoreSelector } from '../hooks/useStore';
import { requestAppUpdate, useAppUpdate } from '../lib/appUpdate';
import { hasActiveSessionWork } from '../lib/sessions';

export function SidebarAppUpdateButton() {
  const { update, downloading } = useAppUpdate();
  const hasActiveWork = useStoreSelector(hasActiveSessionWork);
  return (
    <AppUpdateButtonView
      latest={update?.updateAvailable ? update.latest : null}
      downloading={downloading}
      onStart={() => {
        void requestAppUpdate(update, hasActiveWork);
      }}
    />
  );
}

export function AppUpdateButtonView({
  latest,
  downloading,
  onStart,
}: {
  latest: string | null;
  downloading: boolean;
  onStart: () => void;
}) {
  if (!latest) return null;
  const actionLabel = `Review DROIDEX ${latest} update`;
  // The icon slot collapses as the label slot expands, so the resting circle
  // morphs into a pill on hover/focus and into a downloading pill on start;
  // the button width follows the animated max-width of the two slots. The
  // resting state's delay holds the pill open on mouse-leave so it lingers
  // instead of snapping shut; hover/focus overrides it to expand at once.
  const morph =
    'overflow-hidden whitespace-nowrap transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none';
  const iconSlot = downloading
    ? 'max-w-0 opacity-0'
    : 'max-w-4 opacity-100 delay-200 group-hover:max-w-0 group-hover:opacity-0 group-hover:delay-0 group-focus-visible:max-w-0 group-focus-visible:opacity-0 group-focus-visible:delay-0';
  const labelSlot = downloading
    ? 'max-w-28 opacity-100'
    : 'max-w-0 opacity-0 delay-200 group-hover:max-w-28 group-hover:opacity-100 group-hover:delay-0 group-focus-visible:max-w-28 group-focus-visible:opacity-100 group-focus-visible:delay-0';
  return (
    <button
      onClick={onStart}
      disabled={downloading}
      title={actionLabel}
      aria-label={actionLabel}
      className="group flex h-8 shrink-0 items-center justify-center rounded-full bg-blue-600 px-2 text-white transition-all duration-150 ease-out motion-reduce:transition-none enabled:hover:opacity-90 enabled:active:scale-[0.97]"
    >
      <span className={`flex items-center ${morph} ${iconSlot}`}>
        <Download className="h-4 w-4 shrink-0" />
      </span>
      <span className={`flex items-center gap-1.5 text-[12px] font-semibold ${morph} ${labelSlot}`}>
        {downloading && <Spinner className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin-slow" />}
        {downloading ? 'Downloading' : 'Update'}
      </span>
    </button>
  );
}
