import { AlertTriangle, KeyRound, PanelTop } from 'lucide-react';
import type {
  BrowserAgentCursorStyle,
  BrowserLoginFillApproval,
  BrowserNavigationApproval,
  BrowserSettingsPatch,
  BrowserSettingsSnapshot,
  BrowserSiteGrantKind,
  BrowserSitePermissionMode,
} from '../../lib/browserSettings';
import { Dropdown } from '../settingsKit';
import { Switch } from '../Switch';
import { BrowserSiteGrants } from './BrowserSiteGrants';
import {
  BrowserActionButton,
  BrowserSettingRow,
  BrowserSettingsCard,
  BrowserSettingsGroup,
} from './BrowserSettingsPrimitives';

const NAVIGATION_OPTIONS = [
  { value: 'follow_autonomy', label: 'Follow autonomy' },
  { value: 'always_ask', label: 'Always ask' },
  { value: 'new_sites', label: 'Ask for new sites' },
  { value: 'never_ask', label: 'Full site access' },
];
const LOGIN_OPTIONS = [
  { value: 'always_ask', label: 'Always ask' },
  { value: 'never', label: 'Never use' },
];
const PERMISSION_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'ask', label: 'Ask me' },
];
const CURSOR_STYLE_OPTIONS = [
  { value: 'droidex', label: 'DROIDEX', icon: <AgentCursorStyleIcon style="droidex" /> },
  { value: 'dark', label: 'Dark', icon: <AgentCursorStyleIcon style="dark" /> },
  { value: 'light', label: 'Light', icon: <AgentCursorStyleIcon style="light" /> },
];

function AgentCursorStyleIcon({ style }: { style: BrowserAgentCursorStyle }) {
  const fill = style === 'dark' ? '#111111' : style === 'light' ? '#ffffff' : '#303743';
  const stroke = style === 'dark' ? '#ffffff' : style === 'light' ? '#3b3b3b' : '#dce1eb';
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      className="h-5 w-5 shrink-0"
      style={
        style === 'droidex'
          ? { filter: 'drop-shadow(0 0 3px rgba(80, 139, 255, 0.75))' }
          : undefined
      }
    >
      <path
        d="M7.01 3.99 Q6.2 3.4 6.2 4.4 L6.2 23.4 Q6.2 26 8 27.8 L8.1 27.9 Q9.8 29.6 11.6 28.01 L15.3 24.73 Q16.8 23.4 18.8 23.3 L22.8 23.11 Q25 23 25.62 20.89 L25.7 20.6 Q26.4 18.2 24.3 16.66 Z"
        fill={fill}
        fillOpacity={1}
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function parseNavigationApproval(value: string): BrowserNavigationApproval {
  if (
    value === 'follow_autonomy' ||
    value === 'always_ask' ||
    value === 'new_sites' ||
    value === 'never_ask'
  )
    return value;
  throw new Error(`Unsupported browser navigation approval: ${value}`);
}

function parseLoginFillApproval(value: string): BrowserLoginFillApproval {
  if (value === 'always_ask' || value === 'never') return value;
  throw new Error(`Unsupported browser login approval: ${value}`);
}

function parseSitePermissionMode(value: string): BrowserSitePermissionMode {
  if (value === 'block' || value === 'ask') return value;
  throw new Error(`Unsupported browser site permission mode: ${value}`);
}

function parseAgentCursorStyle(value: string): BrowserAgentCursorStyle {
  if (value === 'dark' || value === 'light' || value === 'droidex') return value;
  throw new Error(`Unsupported browser agent cursor style: ${value}`);
}

function protectedStorageLabel(snapshot: BrowserSettingsSnapshot): string {
  if (snapshot.platform === 'darwin' && snapshot.keychainAvailable) {
    return 'Encrypted with macOS Keychain';
  }
  if (snapshot.keychainAvailable) return 'Encrypted with operating-system storage';
  return 'Saved login storage unavailable';
}

function passkeyCapabilityDescription(snapshot: BrowserSettingsSnapshot): string {
  if (snapshot.webAuthn.touchIdPasskeysAvailable) {
    return 'Touch ID passkeys are available in this signed DROIDEX build. Account choice and the macOS confirmation stay under your control; credentials remain device-bound.';
  }
  if (snapshot.webAuthn.touchIdPasskeysReason === 'signed_release_required') {
    return 'Touch ID passkeys require a signed DROIDEX release with its Team-scoped Keychain entitlement. Development and ad-hoc builds do not claim passkey support.';
  }
  if (snapshot.webAuthn.touchIdPasskeysReason === 'runtime_unsupported') {
    return 'This DROIDEX runtime cannot configure the Touch ID platform authenticator.';
  }
  return 'Touch ID platform passkeys are unavailable on this operating system.';
}

function cookieImportDescription(snapshot: BrowserSettingsSnapshot): string {
  const receipt = snapshot.lastCookieImport;
  if (!receipt) return 'No Chrome cookie import has completed yet.';
  const method =
    receipt.importMethod === 'profile' ? `${receipt.profileLabel} profile` : 'File recovery';
  const importedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(receipt.importedAt));
  return `${method} · ${importedAt} · ${String(receipt.domainCount)} ${receipt.domainCount === 1 ? 'site' : 'sites'}`;
}

function cookieImportCounts(snapshot: BrowserSettingsSnapshot): string {
  const receipt = snapshot.lastCookieImport;
  if (!receipt) return 'Not imported';
  const cookieLabel = receipt.importedCount === 1 ? 'cookie' : 'cookies';
  const counts = [`${String(receipt.importedCount)} ${cookieLabel} imported`];
  if (receipt.skippedCount > 0) counts.push(`${String(receipt.skippedCount)} skipped`);
  if (receipt.failedCount > 0) counts.push(`${String(receipt.failedCount)} failed`);
  return counts.join(' · ');
}

export interface BrowserSettingsViewProps {
  snapshot: BrowserSettingsSnapshot;
  disabled: boolean;
  onPatch: (patch: BrowserSettingsPatch) => void;
  onImport: () => void;
  onClearData: () => void;
  onDeleteCredential: (origin: string) => void;
  onRevoke: (kind: BrowserSiteGrantKind, origin: string) => void;
  onChooseDownloadDirectory: () => void;
}

function SavedLoginOrigins({
  origins,
  disabled,
  onDelete,
}: {
  origins: string[];
  disabled: boolean;
  onDelete: (origin: string) => void;
}) {
  if (origins.length === 0) {
    return (
      <div className="border-t border-droid-border/50 px-4 py-3.5 text-[11.5px] text-droid-text-muted">
        No saved logins yet.
      </div>
    );
  }
  return (
    <ul aria-label="Saved login sites" className="border-t border-droid-border/50">
      {origins.map((origin, index) => (
        <li
          key={origin}
          className={`flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? 'border-t border-droid-border/50' : ''}`}
        >
          <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-secondary">
            {origin}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onDelete(origin);
            }}
            aria-label={`Delete saved login for ${origin}`}
            className="rounded-lg px-2.5 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}

export function BrowserSettingsView({
  snapshot,
  disabled,
  onPatch,
  onImport,
  onClearData,
  onDeleteCredential,
  onRevoke,
  onChooseDownloadDirectory,
}: BrowserSettingsViewProps) {
  const keychainLabel = protectedStorageLabel(snapshot);

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-droid-text">Browser</h1>
        <p className="mt-1.5 max-w-xl text-[12px] leading-5 text-droid-text-muted">
          Control the built-in browser profile, sign-ins, downloads, and what agents may do.
        </p>
      </header>

      <BrowserSettingsCard>
        <div className="flex items-center justify-between gap-5 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-droid-border bg-droid-bg/60">
              <PanelTop className="h-5 w-5 text-droid-text-secondary" />
            </div>
            <div>
              <div className="text-[13px] font-medium text-droid-text">Agent browser access</div>
              <p className="mt-0.5 text-[11.5px] leading-4 text-droid-text-muted">
                Let agents control the shared built-in browser under the rules below.
              </p>
            </div>
          </div>
          <Switch
            label="Agent browser access"
            checked={snapshot.agentAccessEnabled}
            disabled={disabled}
            onChange={(agentAccessEnabled) => {
              onPatch({ agentAccessEnabled });
            }}
          />
        </div>
      </BrowserSettingsCard>

      <div className="mt-7">
        <BrowserSettingsGroup
          title="General and data"
          action={
            <BrowserActionButton onClick={onImport} disabled={disabled}>
              Import from Chrome…
            </BrowserActionButton>
          }
        >
          <BrowserSettingsCard>
            <BrowserSettingRow
              label="Browser cookies"
              description={`${String(snapshot.cookieCount)} ${snapshot.cookieCount === 1 ? 'cookie' : 'cookies'} in the shared DROIDEX browser profile`}
            >
              <span className="text-[11px] text-droid-text-muted">
                {snapshot.platform === 'darwin' ? 'Chrome profile import' : 'File import recovery'}
              </span>
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Last Chrome import"
              description={cookieImportDescription(snapshot)}
            >
              <span
                role="status"
                className="block max-w-48 text-right text-[12px] font-medium text-droid-text"
              >
                {cookieImportCounts(snapshot)}
              </span>
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Browsing data"
              description="Clear cookies, cache, and site storage from the built-in browser."
            >
              <BrowserActionButton onClick={onClearData} disabled={disabled} danger>
                Clear data
              </BrowserActionButton>
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Home and search page"
              description="Used when DROIDEX starts a fresh browser session."
            >
              <input
                key={snapshot.homePage}
                type="url"
                aria-label="DROIDEX Browser home page"
                defaultValue={snapshot.homePage}
                disabled={disabled}
                onBlur={(event) => {
                  if (event.currentTarget.value !== snapshot.homePage)
                    onPatch({ homePage: event.currentTarget.value });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="w-56 rounded-lg border border-droid-border bg-droid-field px-2.5 py-1.5 text-[11px] text-droid-text outline-none transition focus:border-droid-accent disabled:opacity-50"
              />
            </BrowserSettingRow>
          </BrowserSettingsCard>
          <p className="mt-2.5 px-1 text-[10.5px] leading-4 text-droid-text-muted">
            {snapshot.platform === 'darwin'
              ? 'Chrome profile import uses macOS Keychain approval.'
              : 'Direct Chrome profile import is currently available on macOS.'}{' '}
            Safari sign-ins must be completed once inside DROIDEX. Passwords are never imported.
          </p>
        </BrowserSettingsGroup>

        <BrowserSettingsGroup title="Saved logins">
          <BrowserSettingsCard>
            <BrowserSettingRow
              label="Protected storage"
              description={
                <>
                  {keychainLabel}
                  {snapshot.touchIdAvailable && (
                    <>
                      {' '}
                      · Touch ID confirmation is available when DROIDEX asks to use a saved login
                    </>
                  )}
                </>
              }
            >
              <KeyRound className="h-4 w-4 text-droid-text-muted" />
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Agent login fill"
              description="Saved passwords require native approval and Touch ID when available."
            >
              <Dropdown
                value={snapshot.loginFillApproval}
                options={LOGIN_OPTIONS}
                ariaLabel="Agent login fill approval"
                width="w-40"
                disabled={disabled}
                onChange={(value) => {
                  onPatch({ loginFillApproval: parseLoginFillApproval(value) });
                }}
              />
            </BrowserSettingRow>
            <SavedLoginOrigins
              origins={snapshot.credentialOrigins}
              disabled={disabled}
              onDelete={onDeleteCredential}
            />
          </BrowserSettingsCard>
        </BrowserSettingsGroup>

        <BrowserSettingsGroup title="Agent safety">
          <BrowserSettingsCard>
            <BrowserSettingRow
              label="Website opening approval"
              description="Follow task autonomy, ask by exact origin, or allow any safe HTTP(S) site."
            >
              <Dropdown
                value={snapshot.navigationApproval}
                options={NAVIGATION_OPTIONS}
                ariaLabel="Website opening approval"
                width="w-40"
                disabled={disabled}
                onChange={(value) => {
                  onPatch({ navigationApproval: parseNavigationApproval(value) });
                }}
              />
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Show DROIDEX agent cursor"
              description="Keep a separate pointer parked on the agent’s last action and glide it to each live click, hover, and scroll position."
            >
              <div className="flex flex-col items-end gap-2.5">
                <div className="flex items-center gap-2.5">
                  <Dropdown
                    value={snapshot.agentCursorStyle}
                    options={CURSOR_STYLE_OPTIONS}
                    ariaLabel="Agent cursor style"
                    width="w-28"
                    disabled={disabled}
                    onChange={(value) => {
                      onPatch({ agentCursorStyle: parseAgentCursorStyle(value) });
                    }}
                  />
                  <Switch
                    label="Show DROIDEX agent cursor"
                    checked={snapshot.showAgentCursor}
                    disabled={disabled}
                    onChange={(showAgentCursor) => {
                      onPatch({ showAgentCursor });
                    }}
                  />
                </div>
                <label className="flex items-center gap-2.5 text-xs text-droid-muted">
                  <span className="w-10 text-right tabular-nums">
                    {String(snapshot.agentCursorSize)} px
                  </span>
                  <input
                    type="range"
                    min="24"
                    max="64"
                    step="2"
                    value={snapshot.agentCursorSize}
                    aria-label="Agent cursor size"
                    disabled={disabled || !snapshot.showAgentCursor}
                    className="h-1.5 w-28 cursor-pointer accent-droid-accent disabled:cursor-not-allowed disabled:opacity-40"
                    onChange={(event) => {
                      onPatch({ agentCursorSize: Number(event.currentTarget.value) });
                    }}
                  />
                </label>
              </div>
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Camera and microphone"
              description="Allow each site here and approve macOS access separately. If macOS blocks access, enable DROIDEX in System Settings > Privacy & Security > Camera or Microphone, then restart. HID and USB remain blocked."
            >
              <Dropdown
                value={snapshot.sitePermissionMode}
                options={PERMISSION_OPTIONS}
                ariaLabel="Camera and microphone permissions"
                width="w-40"
                disabled={disabled}
                onChange={(value) => {
                  onPatch({ sitePermissionMode: parseSitePermissionMode(value) });
                }}
              />
            </BrowserSettingRow>
          </BrowserSettingsCard>
        </BrowserSettingsGroup>

        <BrowserSettingsGroup title="Downloads">
          <BrowserSettingsCard>
            <BrowserSettingRow label="Location" description={snapshot.downloadDirectoryLabel}>
              <BrowserActionButton onClick={onChooseDownloadDirectory} disabled={disabled}>
                Change
              </BrowserActionButton>
            </BrowserSettingRow>
            <BrowserSettingRow
              border
              label="Ask where to save downloads"
              description="Show a save dialog before a file leaves the built-in browser."
            >
              <Switch
                label="Ask where to save browser downloads"
                checked={snapshot.askDownloadLocation}
                disabled={disabled}
                onChange={(askDownloadLocation) => {
                  onPatch({ askDownloadLocation });
                }}
              />
            </BrowserSettingRow>
          </BrowserSettingsCard>
        </BrowserSettingsGroup>

        <BrowserSiteGrants snapshot={snapshot} disabled={disabled} onRevoke={onRevoke} />

        <BrowserSettingsGroup title="Authentication">
          <BrowserSettingsCard>
            <BrowserSettingRow
              label="Signups, OAuth, and passkeys"
              description={`${passkeyCapabilityDescription(snapshot)} OAuth support depends on the provider; Google does not allow embedded sign-in. Use a supported website login or import a Chrome session.`}
            >
              <span className="text-[11px] text-droid-green">User approval required</span>
            </BrowserSettingRow>
          </BrowserSettingsCard>
        </BrowserSettingsGroup>

        <BrowserSettingsGroup title="Developer controls">
          <BrowserSettingsCard>
            <div className="flex items-start justify-between gap-5 px-4 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11.5px] font-medium text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" /> Elevated access
                </div>
                <div className="mt-2 text-[13px] text-droid-text">Agent diagnostics</div>
                <p className="mt-0.5 max-w-xl text-[11.5px] leading-[17px] text-droid-text-muted">
                  Allow existing inspect, network, and console tools. This does not enable raw CDP
                  access.
                </p>
              </div>
              <Switch
                label="Agent browser diagnostics"
                checked={snapshot.diagnosticsEnabled}
                disabled={disabled || !snapshot.agentAccessEnabled}
                onChange={(diagnosticsEnabled) => {
                  onPatch({ diagnosticsEnabled });
                }}
              />
            </div>
          </BrowserSettingsCard>
        </BrowserSettingsGroup>
      </div>
    </div>
  );
}
