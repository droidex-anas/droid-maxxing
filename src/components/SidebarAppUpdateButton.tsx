import { Download, Loader2 } from 'lucide-react';
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
  return (
    <button
      onClick={onStart}
      disabled={downloading}
      title={actionLabel}
      aria-label={actionLabel}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-500 transition-colors hover:bg-droid-elevated disabled:opacity-60"
    >
      {downloading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  );
}
