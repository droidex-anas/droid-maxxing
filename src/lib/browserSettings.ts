export type BrowserNavigationApproval =
  | 'follow_autonomy'
  | 'always_ask'
  | 'new_sites'
  | 'never_ask';
export type BrowserLoginFillApproval = 'always_ask' | 'never';
export type BrowserSitePermissionMode = 'block' | 'ask';
export type BrowserAgentCursorStyle = 'dark' | 'light' | 'droidex';
export type BrowserSiteGrantKind = 'agent_navigation' | 'camera' | 'microphone';

export interface BrowserSitePermissionRule {
  origin: string;
  camera: 'allow' | 'ask' | 'deny';
  microphone: 'allow' | 'ask' | 'deny';
}

export interface BrowserCookieProfile {
  id: string;
  label: string;
  isLastUsed: boolean;
}

export interface BrowserCookieProfileDiscovery {
  chrome:
    | {
        status: 'available';
        profiles: BrowserCookieProfile[];
        message: string;
        recovery: null;
      }
    | {
        status: 'unavailable';
        profiles: [];
        message: string;
        recovery: string;
      };
  safari: {
    status: 'unavailable';
    profiles: [];
    message: string;
    recovery: string;
  };
}

export interface BrowserCookieProfileImportPreview {
  source: 'chrome';
  importMethod: 'profile';
  profileId: string;
  profileLabel: string;
  importCount: number;
  skippedCount: number;
  replacementCount: number | null;
  domainCount: number;
  affectedDomains: string[];
  keychainApproved: boolean;
}

export type BrowserCookieProfileImportFailureReason =
  | 'keychain_denied'
  | 'profile_missing'
  | 'schema_unsupported'
  | 'database_unavailable'
  | 'no_importable_cookies'
  | 'cookie_limit_exceeded';

export type BrowserCookieProfileImportPrepareResult =
  | { status: 'canceled' }
  | { status: 'failed'; reason: BrowserCookieProfileImportFailureReason }
  | {
      status: 'ready';
      planId: string;
      preview: BrowserCookieProfileImportPreview;
    };

export interface BrowserCookieProfileImportResult {
  source: 'chrome';
  importMethod: 'profile';
  profileId: string;
  profileLabel: string;
  importedCount: number;
  failedCount: number;
  skippedCount: number;
  replacementCount: number | null;
  domainCount: number;
  affectedDomains: string[];
  snapshot: BrowserSettingsSnapshot;
}

export interface BrowserCookieImportReceipt {
  importedAt: string;
  source: 'chrome';
  importMethod: 'file' | 'profile';
  profileLabel: string;
  importedCount: number;
  replacementCount: number | null;
  skippedCount: number;
  failedCount: number;
  domainCount: number;
}

export interface BrowserSettingsSnapshot {
  agentAccessEnabled: boolean;
  navigationApproval: BrowserNavigationApproval;
  loginFillApproval: BrowserLoginFillApproval;
  diagnosticsEnabled: boolean;
  sitePermissionMode: BrowserSitePermissionMode;
  askDownloadLocation: boolean;
  showAgentCursor: boolean;
  agentCursorStyle: BrowserAgentCursorStyle;
  agentCursorSize: number;
  homePage: string;
  downloadDirectoryLabel: string;
  cookieCount: number;
  credentialOrigins: string[];
  approvedAgentOrigins: string[];
  sitePermissionRules: BrowserSitePermissionRule[];
  keychainAvailable: boolean;
  touchIdAvailable: boolean;
  webAuthn: {
    accountSelectionAvailable: boolean;
    touchIdPasskeysAvailable: boolean;
    touchIdPasskeysReason:
      | 'available'
      | 'signed_release_required'
      | 'runtime_unsupported'
      | 'unsupported_platform';
  };
  platform: 'darwin' | 'win32' | 'linux';
  permissionSummary: {
    camera: 'ask' | 'blocked';
    microphone: 'ask' | 'blocked';
    devices: 'blocked';
  };
  lastCookieImport: BrowserCookieImportReceipt | null;
}

export type BrowserSettingsPatch = Partial<
  Pick<
    BrowserSettingsSnapshot,
    | 'agentAccessEnabled'
    | 'navigationApproval'
    | 'loginFillApproval'
    | 'diagnosticsEnabled'
    | 'sitePermissionMode'
    | 'askDownloadLocation'
    | 'showAgentCursor'
    | 'agentCursorStyle'
    | 'agentCursorSize'
    | 'homePage'
  >
>;

export type BrowserCookieImportResult =
  | { canceled: true }
  | {
      canceled: false;
      source: 'chrome';
      importedCount: number;
      replacementCount: number | null;
      skippedCount: number;
      failedCount: number;
      domainCount: number;
      affectedDomains: string[];
      snapshot: BrowserSettingsSnapshot;
    };

function requireBrowserApi() {
  const api = typeof window !== 'undefined' ? window.droidControl : undefined;
  if (!api) throw new Error('Browser settings are only available in the desktop app.');
  return api;
}

export async function getBrowserSettings(): Promise<BrowserSettingsSnapshot> {
  return requireBrowserApi().browserSettingsGet();
}

export function updateBrowserSettings(
  patch: BrowserSettingsPatch,
): Promise<BrowserSettingsSnapshot> {
  return requireBrowserApi().browserSettingsUpdate(patch);
}

export function importBrowserCookies(): Promise<BrowserCookieImportResult> {
  return requireBrowserApi().browserCookiesImport();
}

export function discoverBrowserCookieProfiles(): Promise<BrowserCookieProfileDiscovery> {
  return requireBrowserApi().browserCookieProfilesDiscover();
}

export function prepareBrowserCookieProfileImport(
  profileId: string,
): Promise<BrowserCookieProfileImportPrepareResult> {
  return requireBrowserApi().browserCookieProfileImportPrepare(profileId);
}

export function commitBrowserCookieProfileImport(
  planId: string,
): Promise<BrowserCookieProfileImportResult> {
  return requireBrowserApi().browserCookieProfileImportCommit(planId);
}

export function discardBrowserCookieProfileImport(planId: string): Promise<boolean> {
  return requireBrowserApi().browserCookieProfileImportDiscard(planId);
}

export function clearBrowserData(): Promise<BrowserSettingsSnapshot> {
  return requireBrowserApi().browserDataClear();
}

export function deleteBrowserCredential(origin: string): Promise<BrowserSettingsSnapshot> {
  return requireBrowserApi().browserCredentialDelete(origin);
}

export function revokeBrowserSiteGrant(
  kind: BrowserSiteGrantKind,
  origin: string,
): Promise<BrowserSettingsSnapshot> {
  return requireBrowserApi().browserSiteGrantRevoke(kind, origin);
}

export function chooseBrowserDownloadDirectory(): Promise<BrowserSettingsSnapshot | null> {
  return requireBrowserApi().browserDownloadDirectoryChoose();
}

export async function commitBrowserSettingsPatch(
  current: BrowserSettingsSnapshot,
  patch: BrowserSettingsPatch,
  publish: (snapshot: BrowserSettingsSnapshot | null) => void,
  save = updateBrowserSettings,
  reload = getBrowserSettings,
): Promise<void> {
  publish({ ...current, ...patch });
  try {
    publish(await save(patch));
  } catch (error) {
    try {
      publish(await reload());
    } catch {
      publish(null);
    }
    throw error;
  }
}

export function formatCookieImportSummary(result: BrowserCookieImportResult): string {
  if (result.canceled) return '';
  const imported = `${String(result.importedCount)} ${result.importedCount === 1 ? 'cookie' : 'cookies'}`;
  const skipped = result.skippedCount > 0 ? `; ${String(result.skippedCount)} skipped` : '';
  const failed = result.failedCount > 0 ? `; ${String(result.failedCount)} failed` : '';
  return `Imported ${imported} from Chrome${failed}${skipped}.`;
}

export function formatCookieProfileImportSummary(result: BrowserCookieProfileImportResult): string {
  const imported = `${String(result.importedCount)} ${result.importedCount === 1 ? 'cookie' : 'cookies'}`;
  const skipped = result.skippedCount > 0 ? `; ${String(result.skippedCount)} skipped` : '';
  const failed = result.failedCount > 0 ? `; ${String(result.failedCount)} failed` : '';
  return `Imported ${imported} from ${result.profileLabel}${failed}${skipped}.`;
}
