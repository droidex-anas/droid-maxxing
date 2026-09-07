import { Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  chooseBrowserDownloadDirectory,
  clearBrowserData,
  commitBrowserSettingsPatch,
  deleteBrowserCredential,
  getBrowserSettings,
  revokeBrowserSiteGrant,
  type BrowserSettingsPatch,
  type BrowserSettingsSnapshot,
  type BrowserSiteGrantKind,
} from '../lib/browserSettings';
import { BrowserConfirmDialog } from './browserSettings/BrowserConfirmDialog';
import { BrowserProfileImportDialog } from './browserSettings/BrowserProfileImportDialog';
import { BrowserSettingsView } from './browserSettings/BrowserSettingsView';

type ConfirmTarget =
  | { kind: 'clear_data' }
  | { kind: 'credential'; origin: string }
  | { kind: 'grant'; grantKind: BrowserSiteGrantKind; origin: string };

function confirmCopy(target: ConfirmTarget): {
  title: string;
  description: string;
  actionLabel: string;
} {
  if (target.kind === 'clear_data') {
    return {
      title: 'Clear browser data?',
      description:
        'Open browser tabs will close. Cookies, cache, and site storage will be removed, so you may be signed out.',
      actionLabel: 'Clear data',
    };
  }
  if (target.kind === 'credential') {
    return {
      title: 'Delete saved login?',
      description: `DROIDEX will remove the encrypted login saved for ${target.origin}.`,
      actionLabel: 'Delete login',
    };
  }
  return {
    title: 'Remove exact-site grant?',
    description: `DROIDEX will ask again when ${target.origin} next needs this access.`,
    actionLabel: 'Remove grant',
  };
}

export function BrowserSettings() {
  const [snapshot, setSnapshot] = useState<BrowserSettingsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [confirmError, setConfirmError] = useState('');

  const load = async () => {
    setIsLoading(true);
    setError('');
    try {
      setSnapshot(await getBrowserSettings());
    } catch {
      setError('Could not load browser settings. Check that the desktop host is running.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void getBrowserSettings()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => {
        if (active)
          setError('Could not load browser settings. Check that the desktop host is running.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const patchSettings = async (patch: BrowserSettingsPatch) => {
    if (!snapshot || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      await commitBrowserSettingsPatch(snapshot, patch, setSnapshot);
    } catch {
      setError(
        'Could not confirm that browser setting. It may have been saved. Review the current settings or retry loading them.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const chooseDownloadDirectory = async () => {
    setIsSaving(true);
    setError('');
    try {
      const next = await chooseBrowserDownloadDirectory();
      if (next) setSnapshot(next);
    } catch {
      setError('Could not change the browser download location.');
    } finally {
      setIsSaving(false);
    }
  };

  const performConfirmedAction = async () => {
    if (!confirmTarget) return;
    setIsSaving(true);
    setConfirmError('');
    try {
      if (confirmTarget.kind === 'clear_data') {
        setSnapshot(await clearBrowserData());
      } else if (confirmTarget.kind === 'credential') {
        setSnapshot(await deleteBrowserCredential(confirmTarget.origin));
      } else {
        setSnapshot(await revokeBrowserSiteGrant(confirmTarget.grantKind, confirmTarget.origin));
      }
      setConfirmTarget(null);
    } catch {
      const message =
        'DROIDEX could not complete this action. Some data may have changed and browser pages may have closed. Review the current settings before retrying.';
      setConfirmError(message);
      try {
        setSnapshot(await getBrowserSettings());
      } catch {
        setSnapshot(null);
        setError(`${message} Settings could not be refreshed; retry loading them.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div
        role="status"
        className="mx-auto flex max-w-2xl items-center gap-2 py-12 text-[12px] text-droid-text-muted"
      >
        <Loader2 className="h-4 w-4 animate-spin" /> Loading browser settings…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <h1 className="text-[22px] font-semibold text-droid-text">Browser</h1>
        <p role="alert" className="mt-4 text-[12px] text-red-400">
          {error}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 flex items-center gap-2 rounded-xl bg-droid-elevated px-3 py-2 text-[12px] font-medium text-droid-text"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  const copy = confirmTarget ? confirmCopy(confirmTarget) : null;
  return (
    <>
      <BrowserSettingsView
        snapshot={snapshot}
        disabled={isSaving}
        onPatch={(patch) => void patchSettings(patch)}
        onImport={() => {
          setImportOpen(true);
        }}
        onClearData={() => {
          setConfirmError('');
          setConfirmTarget({ kind: 'clear_data' });
        }}
        onDeleteCredential={(origin) => {
          setConfirmError('');
          setConfirmTarget({ kind: 'credential', origin });
        }}
        onRevoke={(grantKind, origin) => {
          setConfirmError('');
          setConfirmTarget({ kind: 'grant', grantKind, origin });
        }}
        onChooseDownloadDirectory={() => void chooseDownloadDirectory()}
      />
      {error && (
        <p
          role="alert"
          className="fixed bottom-5 right-5 z-40 max-w-sm rounded-xl border border-red-500/20 bg-droid-surface px-4 py-3 text-[11.5px] text-red-400 shadow-xl"
        >
          {error}
        </p>
      )}
      {importOpen && (
        <BrowserProfileImportDialog
          onClose={() => {
            setImportOpen(false);
          }}
          onSnapshot={setSnapshot}
        />
      )}
      {confirmTarget && copy && (
        <BrowserConfirmDialog
          {...copy}
          busy={isSaving}
          error={confirmError}
          onCancel={() => {
            if (!isSaving) setConfirmTarget(null);
          }}
          onConfirm={() => void performConfirmedAction()}
        />
      )}
    </>
  );
}
