import {
  ArrowRight,
  Check,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import { GithubAuthPromptContent } from '../../../components/environment/GithubSetupCard';
import { useGithubAuthCodeCopy } from '../../../hooks/useGithubAuthCodeCopy';
import type { GithubSetupController } from '../../../hooks/useGithubSetup';
import { pluginReference } from '../../../lib/pluginReferences';
import type { PluginDefinition } from '../pluginCatalog';
import { PLUGIN_BRAND_GRADIENT } from '../pluginBrandGradient';
import type { PluginRegistryState } from '../pluginRegistry';
import { pluginIsAvailable } from '../pluginRegistry';
import { PluginBrandIcon } from './PluginBrandIcon';

function primaryActionLabel(
  plugin: PluginDefinition,
  available: boolean,
  githubSetup: GithubSetupController,
  busy: boolean,
): string {
  if (busy) return 'Working…';
  if (available) return 'Try now';
  if (plugin.adapter !== 'github-cli') return 'Install';
  if (githubSetup.action === 'installing') return 'Installing…';
  if (githubSetup.action === 'authenticating') return 'Waiting for GitHub…';
  if (githubSetup.availability?.installed) return 'Connect';
  if (githubSetup.availability?.installMethod === 'manual' && githubSetup.manualGuideOpened) {
    return 'Check installation';
  }
  return 'Install GitHub CLI';
}

function InformationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 py-2 text-[11.5px]">
      <span className="text-droid-text-muted">{label}</span>
      <span className="text-droid-text-secondary">{value}</span>
    </div>
  );
}

export function PluginDetail({
  plugin,
  registry,
  githubSetup,
  busy,
  error,
  onBack,
  onUse,
  onInstall,
  onUpdate,
  onUninstall,
  onRemoveLegacyGithub,
}: {
  plugin: PluginDefinition;
  registry: PluginRegistryState;
  githubSetup: GithubSetupController;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onUse: (reference: string) => void;
  onInstall: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
  onRemoveLegacyGithub: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const available = pluginIsAvailable(registry, plugin);
  const installed = Boolean(registry.installed[plugin.id]);
  const authCodeCopy = useGithubAuthCodeCopy(githubSetup.authCode);
  const showLegacyGithub = plugin.slug === 'github' && registry.legacy.githubPatPluginDetected;

  const runPrimaryAction = () => {
    if (available) {
      onUse(pluginReference(plugin.slug));
      return;
    }
    if (plugin.adapter === 'github-cli') githubSetup.runPrimaryAction();
    else onInstall();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-[11.5px] text-droid-text-muted transition-colors hover:text-droid-text"
        >
          Plugins <ChevronRight className="h-3 w-3" />
          <span className="text-droid-text-secondary">{plugin.name}</span>
        </button>

        <div className="mt-9 flex items-end gap-5">
          <div className="min-w-0 flex-1">
            <PluginBrandIcon plugin={plugin} size={52} />
            <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.02em] text-droid-text">
              {plugin.name}
            </h1>
            <p className="mt-1 text-[12.5px] text-droid-text-muted">{plugin.description}</p>
          </div>
          <div className="relative flex shrink-0 items-center gap-2">
            {installed && (
              <button
                type="button"
                onClick={() => setMenuOpen((value) => !value)}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
                aria-label="Plugin actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              disabled={busy || (plugin.adapter === 'github-cli' && !githubSetup.availability)}
              onClick={runPrimaryAction}
              className="inline-flex min-w-[104px] items-center justify-center gap-1.5 rounded-xl bg-droid-text px-3.5 py-2 text-[12px] font-semibold text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              {available && <MessageCircle className="h-3.5 w-3.5" />}
              {primaryActionLabel(plugin, available, githubSetup, busy)}
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-11 z-20 w-40 rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-[0_14px_44px_rgba(0,0,0,0.28)]">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onUpdate();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] text-droid-text-secondary transition-colors hover:bg-droid-active hover:text-droid-text disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Update
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onUninstall();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] text-droid-red transition-colors hover:bg-droid-red/10 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Uninstall
                </button>
              </div>
            )}
          </div>
        </div>

        <div
          className="relative mt-8 overflow-hidden rounded-2xl border border-droid-border px-6 py-9"
          style={{
            backgroundImage: `linear-gradient(90deg, color-mix(in srgb, var(--droid-bg) 28%, transparent), color-mix(in srgb, var(--droid-bg) 8%, transparent)), ${PLUGIN_BRAND_GRADIENT}`,
            backgroundPosition: 'center',
            backgroundSize: 'cover',
          }}
        >
          <button
            type="button"
            disabled={!available}
            onClick={() => onUse(pluginReference(plugin.slug))}
            className="relative mx-auto flex max-w-[650px] items-center gap-2.5 rounded-2xl border border-white/10 bg-[#101014]/92 px-4 py-3 text-left text-white shadow-[0_12px_36px_rgba(0,0,0,0.25)] backdrop-blur-md transition-transform enabled:hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <PluginBrandIcon plugin={plugin} size={22} framed={false} />
            <span className="shrink-0 text-[12px] font-semibold">{plugin.name}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-white/85">
              {plugin.promptExample}
            </span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-white">
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </button>
        </div>

        <p className="mt-7 text-[12px] leading-6 text-droid-text-secondary">
          {plugin.longDescription}
        </p>

        {error && (
          <div className="mt-5 rounded-xl border border-droid-red/25 bg-droid-red/8 px-3 py-2.5 text-[11.5px] leading-5 text-droid-red">
            {error}
          </div>
        )}

        {plugin.adapter === 'github-cli' && githubSetup.authCode && (
          <div className="mt-5 max-w-md">
            <GithubAuthPromptContent
              code={githubSetup.authCode}
              copied={authCodeCopy.copied}
              copyFailed={authCodeCopy.copyFailed}
              onCopy={() => void authCodeCopy.copyCode()}
              onCancel={() => {
                githubSetup.closeAuthPrompt();
                githubSetup.cancelAuthentication();
              }}
            />
          </div>
        )}

        {showLegacyGithub && (
          <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-droid-border bg-droid-elevated/60 px-4 py-3">
            <div>
              <div className="text-[12px] font-medium text-droid-text">
                Replace the old GitHub MCP setup
              </div>
              <p className="mt-1 text-[11px] leading-5 text-droid-text-muted">
                The previous package expected GITHUB_PERSONAL_ACCESS_TOKEN. DROIDEX now uses your
                existing GitHub CLI sign-in instead.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onRemoveLegacyGithub}
              className="shrink-0 rounded-lg border border-droid-border px-2.5 py-1.5 text-[11px] font-medium text-droid-text transition-colors hover:bg-droid-active disabled:opacity-40"
            >
              Remove legacy setup
            </button>
          </div>
        )}

        {plugin.app && (
          <section className="mt-9">
            <h2 className="border-b border-droid-border pb-3 text-[13px] font-semibold text-droid-text">
              Apps <span className="ml-1 font-normal text-droid-text-muted">1</span>
            </h2>
            <div className="flex items-center gap-3 px-1 py-4">
              <PluginBrandIcon plugin={plugin} size={34} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-droid-text">{plugin.app.name}</div>
                <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">
                  {plugin.app.description}
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-droid-border px-2.5 py-1.5 text-[10.5px] text-droid-text-secondary">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${available ? 'bg-emerald-500' : 'bg-droid-text-muted/45'}`}
                />
                {available ? 'Connected' : 'Not connected'}
              </span>
            </div>
          </section>
        )}

        <section className="mt-7">
          <h2 className="border-b border-droid-border pb-3 text-[13px] font-semibold text-droid-text">
            Skills <span className="ml-1 font-normal text-droid-text-muted">{plugin.skills.length}</span>
          </h2>
          <div className="divide-y divide-droid-border/70">
            {plugin.skills.map((skill) => (
              <div key={skill.name} className="flex items-center gap-3 px-1 py-4">
                <PluginBrandIcon plugin={plugin} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-droid-text">{skill.name}</div>
                  <div className="mt-0.5 text-[11px] text-droid-text-muted">
                    {skill.description}
                  </div>
                </div>
                {available && <Check className="h-4 w-4 text-emerald-500" />}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-7">
          <h2 className="border-b border-droid-border pb-3 text-[13px] font-semibold text-droid-text">
            Information
          </h2>
          <div className="px-1 py-2">
            <InformationRow label="Capabilities" value={plugin.capabilities.join(', ')} />
            <InformationRow label="Developer" value={plugin.publisher} />
            <InformationRow label="Category" value={plugin.category} />
            <InformationRow
              label="Runtime"
              value={plugin.adapter === 'github-cli' ? 'DROIDEX GitHub CLI connection' : 'Droid plugin'}
            />
            <InformationRow
              label="Context"
              value="Compact metadata first; full skills and tools load only when relevant."
            />
          </div>
        </section>
      </div>
    </div>
  );
}
