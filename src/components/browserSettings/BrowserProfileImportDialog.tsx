import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  commitBrowserCookieProfileImport,
  discardBrowserCookieProfileImport,
  discoverBrowserCookieProfiles,
  formatCookieImportSummary,
  formatCookieProfileImportSummary,
  getBrowserSettings,
  importBrowserCookies,
  prepareBrowserCookieProfileImport,
  type BrowserCookieProfileDiscovery,
  type BrowserCookieProfileImportFailureReason,
  type BrowserCookieProfileImportPreview,
  type BrowserSettingsSnapshot,
} from '../../lib/browserSettings';
import { BrowserSettingsDialogFrame } from './BrowserSettingsDialogFrame';
import {
  BrowserProfileImportPreview,
  BrowserProfileImportSelection,
} from './BrowserProfileImportContent';

type ImportFlow =
  | { kind: 'loading' }
  | { kind: 'select'; discovery: BrowserCookieProfileDiscovery }
  | {
      kind: 'preview';
      discovery: BrowserCookieProfileDiscovery;
      planId: string;
      preview: BrowserCookieProfileImportPreview;
    }
  | { kind: 'complete'; summary: string; domainCount: number };

const PROFILE_IMPORT_FAILURE_MESSAGES: Record<BrowserCookieProfileImportFailureReason, string> = {
  keychain_denied:
    'Chrome cookie access was not approved in macOS Keychain. Approve access and try again.',
  profile_missing:
    'That Chrome profile is no longer available. Reopen this importer and choose an available profile.',
  schema_unsupported:
    'This Chrome cookie store version is not supported yet. Update DROIDEX and try again.',
  database_unavailable:
    'Chrome’s cookie database could not be read. Quit Chrome completely and try again.',
  no_importable_cookies:
    'This Chrome profile has no valid, unexpired cookies to import. Sign in to the sites in Chrome and try again.',
  cookie_limit_exceeded:
    'This Chrome profile has more than 5,000 cookies. Remove stale site data in Chrome or use a smaller Chrome export.',
};

export function browserProfileImportFailureMessage(
  reason: BrowserCookieProfileImportFailureReason,
): string {
  return PROFILE_IMPORT_FAILURE_MESSAGES[reason];
}

function defaultProfileId(discovery: BrowserCookieProfileDiscovery): string {
  if (discovery.chrome.status !== 'available') return '';
  return (
    discovery.chrome.profiles.find((profile) => profile.isLastUsed)?.id ??
    discovery.chrome.profiles.at(0)?.id ??
    ''
  );
}

export function BrowserProfileImportDialog({
  onClose,
  onSnapshot,
}: {
  onClose: () => void;
  onSnapshot: (snapshot: BrowserSettingsSnapshot) => void;
}) {
  const [flow, setFlow] = useState<ImportFlow>({ kind: 'loading' });
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pendingPlanId = useRef<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    void discoverBrowserCookieProfiles()
      .then((discovery) => {
        if (!isMounted.current) return;
        setSelectedProfileId(defaultProfileId(discovery));
        setFlow({ kind: 'select', discovery });
      })
      .catch(() => {
        if (isMounted.current) {
          setError(
            'DROIDEX could not discover browser profiles. Retry or use file recovery below.',
          );
          setFlow({ kind: 'loading' });
        }
      });
    return () => {
      isMounted.current = false;
      const planId = pendingPlanId.current;
      pendingPlanId.current = null;
      if (planId) void discardBrowserCookieProfileImport(planId);
    };
  }, []);

  const reloadDiscovery = async () => {
    setBusy(true);
    setError('');
    try {
      const discovery = await discoverBrowserCookieProfiles();
      if (!isMounted.current) return;
      setSelectedProfileId(defaultProfileId(discovery));
      setFlow({ kind: 'select', discovery });
    } catch {
      setError('DROIDEX could not discover browser profiles. Retry or use file recovery below.');
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const closeDialog = async () => {
    const planId = pendingPlanId.current;
    pendingPlanId.current = null;
    if (planId) {
      setBusy(true);
      try {
        await discardBrowserCookieProfileImport(planId);
      } catch {
        // Main owns plan expiry as a final backstop; closing must remain available.
      }
    }
    onClose();
  };

  const prepareProfile = async () => {
    if (flow.kind !== 'select' || !selectedProfileId) return;
    setBusy(true);
    setError('');
    try {
      const prepared = await prepareBrowserCookieProfileImport(selectedProfileId);
      if (prepared.status === 'canceled') return;
      if (prepared.status === 'failed') {
        if (isMounted.current) setError(browserProfileImportFailureMessage(prepared.reason));
        return;
      }
      if (!isMounted.current) {
        void discardBrowserCookieProfileImport(prepared.planId);
        return;
      }
      pendingPlanId.current = prepared.planId;
      setFlow({
        kind: 'preview',
        discovery: flow.discovery,
        planId: prepared.planId,
        preview: prepared.preview,
      });
    } catch {
      if (isMounted.current) {
        setError('DROIDEX lost contact with browser controls. Check the app and try again.');
      }
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const cancelPreview = async () => {
    if (flow.kind !== 'preview') return;
    setBusy(true);
    setError('');
    const planId = flow.planId;
    pendingPlanId.current = null;
    try {
      await discardBrowserCookieProfileImport(planId);
    } finally {
      if (isMounted.current) {
        setBusy(false);
        setFlow({ kind: 'select', discovery: flow.discovery });
      }
    }
  };

  const commitProfile = async () => {
    if (flow.kind !== 'preview') return;
    setBusy(true);
    setError('');
    try {
      const result = await commitBrowserCookieProfileImport(flow.planId);
      pendingPlanId.current = null;
      onSnapshot(result.snapshot);
      setFlow({
        kind: 'complete',
        summary: formatCookieProfileImportSummary(result),
        domainCount: result.domainCount,
      });
    } catch {
      const planId = pendingPlanId.current;
      pendingPlanId.current = null;
      if (planId) void discardBrowserCookieProfileImport(planId);
      try {
        onSnapshot(await getBrowserSettings());
      } catch {
        // The surrounding Browser page keeps its last authoritative snapshot.
      }
      setFlow({ kind: 'select', discovery: flow.discovery });
      setError(
        'DROIDEX could not finish every cookie. Some cookies may already be imported; the pending import was discarded.',
      );
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const importChromeRecoveryFile = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await importBrowserCookies();
      if (result.canceled) return;
      onSnapshot(result.snapshot);
      setFlow({
        kind: 'complete',
        summary: formatCookieImportSummary(result),
        domainCount: result.affectedDomains.length,
      });
    } catch {
      try {
        onSnapshot(await getBrowserSettings());
      } catch {
        // The surrounding Browser page keeps its last authoritative snapshot.
      }
      setError(
        'DROIDEX could not finish that recovery import. Some cookies may already be imported; check the file and retry.',
      );
    } finally {
      if (isMounted.current) setBusy(false);
    }
  };

  const title =
    flow.kind === 'preview'
      ? 'Confirm Chrome import'
      : flow.kind === 'complete'
        ? 'Import complete'
        : 'Import browser sign-ins';
  const description =
    flow.kind === 'preview'
      ? 'Review exactly which sites will change before cookies enter the shared DROIDEX browser.'
      : 'Chrome profiles are detected automatically. File import is only for an existing JSON or Netscape cookie export.';

  return (
    <BrowserSettingsDialogFrame
      title={title}
      description={description}
      busy={busy}
      onClose={() => void closeDialog()}
      footer={
        <>
          {flow.kind === 'preview' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancelPreview()}
              className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-droid-text-secondary hover:bg-droid-elevated/70 disabled:opacity-50"
            >
              Back
            </button>
          )}
          {flow.kind !== 'complete' && flow.kind !== 'preview' && (
            <button
              data-autofocus
              type="button"
              disabled={busy}
              onClick={() => void closeDialog()}
              className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-droid-text-secondary hover:bg-droid-elevated/70 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {flow.kind === 'loading' && error && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void reloadDiscovery()}
              className="flex items-center gap-2 rounded-lg bg-droid-elevated px-3.5 py-2 text-[12px] font-medium text-droid-text disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </button>
          )}
          {flow.kind === 'select' && flow.discovery.chrome.status === 'available' && (
            <button
              type="button"
              disabled={busy || !selectedProfileId}
              onClick={() => void prepareProfile()}
              className="flex min-w-[142px] items-center justify-center gap-2 rounded-lg bg-droid-accent px-3.5 py-2 text-[12px] font-semibold text-droid-bg disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Continue with Chrome
            </button>
          )}
          {flow.kind === 'preview' && (
            <button
              data-autofocus
              type="button"
              disabled={busy}
              onClick={() => void commitProfile()}
              className="flex min-w-[128px] items-center justify-center gap-2 rounded-lg bg-droid-accent px-3.5 py-2 text-[12px] font-semibold text-droid-bg disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Import {String(flow.preview.importCount)}
            </button>
          )}
          {flow.kind === 'complete' && (
            <button
              data-autofocus
              type="button"
              onClick={() => void closeDialog()}
              className="rounded-lg bg-droid-accent px-3.5 py-2 text-[12px] font-semibold text-droid-bg"
            >
              Done
            </button>
          )}
        </>
      }
    >
      {flow.kind === 'loading' && !error && (
        <div
          role="status"
          className="flex items-center gap-2 py-8 text-[11.5px] text-droid-text-muted"
        >
          <Loader2 className="h-4 w-4 animate-spin" /> Discovering Chrome profiles…
        </div>
      )}
      {flow.kind === 'loading' && error && (
        <div className="rounded-xl border border-droid-border bg-droid-bg/45 p-3.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
            File recovery
          </p>
          <p className="mt-2 text-[10.5px] leading-4 text-droid-text-muted">
            Retry automatic Chrome detection first. Only use file recovery if you already have a
            JSON or Netscape cookie export created by a trusted tool; DROIDEX cannot create one from
            Finder. Safari does not provide a transferable sign-in cookie export.
          </p>
          <div className="mt-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void importChromeRecoveryFile()}
              className="rounded-lg bg-droid-elevated px-2.5 py-1.5 text-[11px] font-medium text-droid-text transition-colors hover:bg-droid-border-hover disabled:opacity-50"
            >
              Import Chrome cookie file…
            </button>
          </div>
        </div>
      )}
      {flow.kind === 'select' && (
        <BrowserProfileImportSelection
          discovery={flow.discovery}
          selectedProfileId={selectedProfileId}
          disabled={busy}
          onSelect={setSelectedProfileId}
          onRetry={() => void reloadDiscovery()}
          onChromeRecovery={() => void importChromeRecoveryFile()}
        />
      )}
      {flow.kind === 'preview' && <BrowserProfileImportPreview preview={flow.preview} />}
      {flow.kind === 'complete' && (
        <div role="status" className="rounded-xl border border-droid-border bg-droid-bg/45 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <div>
              <p className="text-[12.5px] font-medium text-droid-text">{flow.summary}</p>
              <p className="mt-1 text-[11px] leading-5 text-droid-text-muted">
                {String(flow.domainCount)} {flow.domainCount === 1 ? 'site domain' : 'site domains'}{' '}
                updated in the shared DROIDEX browser. Reopen the site so it can rebuild its session
                from the completed import.
              </p>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 text-[11.5px] leading-4 text-red-400"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}
    </BrowserSettingsDialogFrame>
  );
}
