import { Globe, FileUp, KeyRound, RotateCcw } from 'lucide-react';
import type {
  BrowserCookieProfileDiscovery,
  BrowserCookieProfileImportPreview,
} from '../../lib/browserSettings';

export function BrowserProfileImportSelection({
  discovery,
  selectedProfileId,
  disabled,
  onSelect,
  onRetry,
  onChromeRecovery,
}: {
  discovery: BrowserCookieProfileDiscovery;
  selectedProfileId: string;
  disabled: boolean;
  onSelect: (profileId: string) => void;
  onRetry: () => void;
  onChromeRecovery: () => void;
}) {
  return (
    <div className="space-y-5">
      <section aria-labelledby="chrome-profile-heading">
        <div className="mb-2.5 flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-droid-text-muted" />
          <h3
            id="chrome-profile-heading"
            className="text-[11px] font-medium uppercase tracking-wider text-droid-text-muted"
          >
            Chrome profiles
          </h3>
        </div>
        {discovery.chrome.status === 'available' ? (
          <fieldset className="max-h-48 space-y-2 overflow-y-auto pr-1">
            <legend className="sr-only">Choose a Chrome profile</legend>
            {discovery.chrome.profiles.map((profile) => (
              <label
                key={profile.id}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-droid-border bg-droid-bg/45 px-3.5 py-3 transition-colors hover:border-droid-border-hover"
              >
                <input
                  type="radio"
                  name="chrome-cookie-profile"
                  value={profile.id}
                  checked={profile.id === selectedProfileId}
                  disabled={disabled}
                  onChange={() => {
                    onSelect(profile.id);
                  }}
                  className="accent-[var(--droid-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-droid-text">
                    {profile.label}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] text-droid-text-muted">
                    {profile.isLastUsed ? 'Last used in Chrome' : 'Chrome profile'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="rounded-xl border border-droid-border bg-droid-bg/45 p-3.5">
            <p className="text-[11.5px] leading-[17px] text-droid-text-secondary">
              {discovery.chrome.message}
            </p>
            <p className="mt-1 text-[10.5px] leading-4 text-droid-text-muted">
              {discovery.chrome.recovery}
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={onRetry}
              className="mt-3 flex items-center gap-2 rounded-lg bg-droid-elevated px-2.5 py-1.5 text-[11px] font-medium text-droid-text transition-colors hover:bg-droid-border-hover disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Retry Chrome detection
            </button>
          </div>
        )}
        {discovery.chrome.status === 'available' && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-droid-bg/35 px-3 py-2.5 text-[10.5px] leading-4 text-droid-text-muted">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Continuing may show macOS Keychain approval. Cookie values stay in Electron main and are
            never sent to this settings page.
          </div>
        )}
      </section>

      <section aria-labelledby="recovery-heading">
        <div className="mb-2.5 flex items-center gap-2">
          <FileUp className="h-3.5 w-3.5 text-droid-text-muted" />
          <h3
            id="recovery-heading"
            className="text-[11px] font-medium uppercase tracking-wider text-droid-text-muted"
          >
            Recovery
          </h3>
        </div>
        <div className="space-y-2">
          <div className="rounded-xl border border-droid-border bg-droid-bg/45 p-3.5">
            <p className="text-[12px] font-medium text-droid-text">Safari</p>
            <p className="mt-0.5 text-[10.5px] leading-4 text-droid-text-muted">
              Safari does not provide a cookie export that can transfer website sign-ins. Sign in to
              the site once inside DROIDEX instead.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-droid-border bg-droid-bg/45 p-3.5">
            <div>
              <p className="text-[12px] font-medium text-droid-text">Chrome file recovery</p>
              <p className="mt-0.5 text-[10.5px] leading-4 text-droid-text-muted">
                Only use a JSON or Netscape cookie file you already created with a trusted Chrome
                export tool.
              </p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={onChromeRecovery}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated disabled:opacity-50"
            >
              Import Chrome cookie file…
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function BrowserProfileImportPreview({
  preview,
}: {
  preview: BrowserCookieProfileImportPreview;
}) {
  const shownDomains = preview.affectedDomains.slice(0, 4);
  const remainingDomains = preview.affectedDomains.length - shownDomains.length;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-droid-border bg-droid-bg/45 p-4">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-droid-accent" />
          <div>
            <p className="text-[12.5px] font-medium text-droid-text">{preview.profileLabel}</p>
            <p className="mt-1 text-[11px] leading-4 text-droid-text-muted">
              {String(preview.importCount)} importable{' '}
              {preview.importCount === 1 ? 'cookie' : 'cookies'} across{' '}
              {String(preview.domainCount)} {preview.domainCount === 1 ? 'domain' : 'domains'}.
            </p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-droid-border/50 pt-3 text-[10.5px]">
          <div>
            <dt className="text-droid-text-muted">Existing cookies replaced</dt>
            <dd className="mt-0.5 font-medium text-droid-text-secondary">
              {preview.replacementCount === null ? 'Unavailable' : String(preview.replacementCount)}
            </dd>
          </div>
          <div>
            <dt className="text-droid-text-muted">Skipped safely</dt>
            <dd className="mt-0.5 font-medium text-droid-text-secondary">
              {String(preview.skippedCount)}
            </dd>
          </div>
        </dl>
      </div>
      {shownDomains.length > 0 && (
        <div className="rounded-xl border border-droid-border/70 bg-droid-bg/25 px-3.5 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
            Sites affected
          </p>
          <p className="mt-1.5 break-words font-mono text-[10.5px] leading-4 text-droid-text-secondary">
            {shownDomains.join(' · ')}
            {remainingDomains > 0 ? ` · +${String(remainingDomains)} more` : ''}
          </p>
        </div>
      )}
      <p className="text-[10.5px] leading-4 text-droid-text-muted">
        Only the counts and domains shown above reached this page. Cookie names and values remain
        private to Electron main. Current open browser pages close before import so sites reload
        against one completed cookie update.
      </p>
    </div>
  );
}
