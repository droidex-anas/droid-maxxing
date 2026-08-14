import { useEffect, useState } from 'react';
import {
  checkAppUpdate as ipcCheck,
  downloadAppUpdate as ipcDownload,
  type AppUpdateCheckOptions,
  type AppUpdateInfo,
} from './onboarding';
import { toast } from './toast';

const APP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const DEFERRED_APP_UPDATE_KEY = 'droidex.app-update.deferred';
type UpdateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Shared, subscribable app-update state so the sidebar footer button, the
// settings panel, and the launch check all read the same source of truth.
let info: AppUpdateInfo | null = null;
let checking = false;
let downloading = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getAppUpdate(): AppUpdateInfo | null {
  return info;
}

export function isAppUpdateInstalling(): boolean {
  return downloading;
}

export async function refreshAppUpdate(
  options: AppUpdateCheckOptions,
): Promise<AppUpdateInfo | null> {
  const next = await ipcCheck(options);
  if (next) {
    info = next;
    emit();
  }
  return next;
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  if (checking || downloading) return info;
  checking = true;
  emit();
  try {
    return await refreshAppUpdate({
      interactive: true,
      automaticChecks: true,
      configureAutomaticChecks: false,
    });
  } finally {
    checking = false;
    emit();
  }
}

export async function startAppUpdate(target: AppUpdateInfo | null = info): Promise<void> {
  if (downloading || !target?.updateAvailable) return;
  downloading = true;
  emit();
  try {
    const result = await ipcDownload();
    if (result?.status === 'downloaded') {
      toast.info('Update downloaded. Restarting DROIDEX…');
    } else if (result?.status === 'presented') {
      toast.info('Update window opened. You choose when to install.');
    }
  } catch {
    toast.error('Update download failed. Please try again.');
  } finally {
    downloading = false;
    emit();
  }
}

export function prepareAppUpdateRequest(
  hasActiveWork: boolean,
  confirmRestart: () => boolean = () =>
    window.confirm(
      'A DROIDEX session is still running. Restart now to install the update?\n\nChoose Cancel to wait. DROIDEX will continue the update the next time you launch the app.',
    ),
  storage: UpdateStorage = window.localStorage,
): boolean {
  if (!hasActiveWork) {
    try {
      storage.removeItem(DEFERRED_APP_UPDATE_KEY);
    } catch {
      // Installation can still proceed when renderer storage is unavailable.
    }
    return true;
  }
  if (confirmRestart()) {
    try {
      storage.removeItem(DEFERRED_APP_UPDATE_KEY);
    } catch {
      // Installation can still proceed when renderer storage is unavailable.
    }
    return true;
  }
  try {
    storage.setItem(DEFERRED_APP_UPDATE_KEY, '1');
  } catch {
    // The visible update button remains available even without persistence.
  }
  return false;
}

export function consumeDeferredAppUpdate(
  updateAvailable: boolean,
  storage: UpdateStorage = window.localStorage,
): boolean {
  if (!updateAvailable) return false;
  try {
    if (storage.getItem(DEFERRED_APP_UPDATE_KEY) !== '1') return false;
    storage.removeItem(DEFERRED_APP_UPDATE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function requestAppUpdate(
  target: AppUpdateInfo | null,
  hasActiveWork: boolean,
): Promise<void> {
  if (!prepareAppUpdateRequest(hasActiveWork)) {
    toast.info('Update deferred. DROIDEX will continue it after your next launch.');
    return;
  }
  await startAppUpdate(target);
}

export async function checkForAppUpdateAutomatically(
  resumeDeferred = false,
  check: () => Promise<AppUpdateInfo | null> = () =>
    refreshAppUpdate({ interactive: false, automaticChecks: true }),
  install: (target: AppUpdateInfo) => Promise<void> = startAppUpdate,
  storage: UpdateStorage = window.localStorage,
): Promise<void> {
  const update = await check();
  if (resumeDeferred && update?.updateAvailable && consumeDeferredAppUpdate(true, storage)) {
    await install(update);
  }
}

export function startAutomaticAppUpdateChecks(
  check: () => void,
  schedule: (callback: () => void, intervalMs: number) => number = (callback, intervalMs) =>
    window.setInterval(callback, intervalMs),
  cancel: (handle: number) => void = (handle) => {
    window.clearInterval(handle);
  },
): () => void {
  check();
  const handle = schedule(check, APP_UPDATE_CHECK_INTERVAL_MS);
  return () => {
    cancel(handle);
  };
}

export function useAppUpdate(): {
  update: AppUpdateInfo | null;
  checking: boolean;
  downloading: boolean;
  check: () => Promise<void>;
  start: () => Promise<void>;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => {
      force((n) => n + 1);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    update: info,
    checking,
    downloading,
    check: async () => {
      await checkForAppUpdate();
    },
    start: async () => {
      await startAppUpdate();
    },
  };
}
