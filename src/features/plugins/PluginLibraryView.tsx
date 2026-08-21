import { Blocks, ChevronDown, Plus, RefreshCw, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useGithubSetup } from '../../hooks/useGithubSetup';
import { toast } from '../../lib/toast';
import { customMarketplaceFromSource } from './customMarketplace';
import {
  FACTORY_MARKETPLACE,
  pluginBySlug,
  type PluginDefinition,
  type PluginMarketplace,
} from './pluginCatalog';
import {
  buildAddMarketplaceCommand,
  buildInstallCommand,
  buildUninstallCommand,
  buildUpdateCommand,
  runPluginCommand,
} from './pluginRuntime';
import {
  PluginBrowse,
  type PluginLibraryScope,
  type PluginLibraryTab,
} from './components/PluginBrowse';
import { PluginDetail } from './components/PluginDetail';
import { PluginMarketplaceDialog } from './components/PluginMarketplaceDialog';
import { usePluginRegistry } from './usePluginRegistry';

interface ActiveOperation {
  pluginId: string;
  kind: 'install' | 'update' | 'uninstall' | 'legacy';
}

function marketplaceFor(plugin: PluginDefinition): PluginMarketplace | undefined {
  if (plugin.marketplaceId === FACTORY_MARKETPLACE.id) return FACTORY_MARKETPLACE;
  return undefined;
}

export function PluginLibraryView({
  selectedSlug,
  onSelectPlugin,
  onUsePlugin,
  onOpenSettings,
}: {
  selectedSlug: string | null;
  onSelectPlugin: (slug: string | null) => void;
  onUsePlugin: (reference: string) => void;
  onOpenSettings: () => void;
}) {
  const registry = usePluginRegistry();
  const githubSetup = useGithubSetup(true, 'plugin-library');
  const [tab, setTab] = useState<PluginLibraryTab>('plugins');
  const [scope, setScope] = useState<PluginLibraryScope>('public');
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const selectedPlugin = useMemo(
    () => (selectedSlug ? pluginBySlug(selectedSlug) : undefined),
    [selectedSlug],
  );

  useEffect(() => {
    if (!githubSetup.availability) return;
    registry.setConnectorReady('github', githubSetup.isReady);
  }, [githubSetup.availability, githubSetup.isReady, registry]);

  const runPluginOperation = async (
    plugin: PluginDefinition,
    kind: ActiveOperation['kind'],
    command: string,
    onSuccess: () => void,
  ) => {
    setOperation({ pluginId: plugin.id, kind });
    setOperationError(null);
    try {
      const result = await runPluginCommand(command);
      if (!result.ok) throw new Error(result.message);
      onSuccess();
      toast.success(
        kind === 'install'
          ? `${plugin.name} installed.`
          : kind === 'update'
            ? `${plugin.name} updated.`
            : kind === 'legacy'
              ? 'Legacy GitHub plugin removed.'
              : `${plugin.name} uninstalled.`,
      );
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  };

  const install = (plugin: PluginDefinition) => {
    void runPluginOperation(
      plugin,
      'install',
      buildInstallCommand(plugin, marketplaceFor(plugin)),
      () => registry.markInstalled(plugin),
    );
  };

  const update = (plugin: PluginDefinition) => {
    void runPluginOperation(
      plugin,
      'update',
      buildUpdateCommand(plugin, marketplaceFor(plugin)),
      () => registry.markInstalled(plugin),
    );
  };

  const uninstall = (plugin: PluginDefinition) => {
    if (!plugin.installId) return;
    if (!window.confirm(`Uninstall ${plugin.name} for this DROIDEX profile?`)) return;
    void runPluginOperation(plugin, 'uninstall', buildUninstallCommand(plugin.installId), () =>
      registry.removeInstalled(plugin.id),
    );
  };

  const removeLegacyGithub = (plugin: PluginDefinition) => {
    if (!plugin.legacyInstallId) return;
    void runPluginOperation(
      plugin,
      'legacy',
      buildUninstallCommand(plugin.legacyInstallId),
      registry.clearLegacyGithub,
    );
  };

  const addMarketplace = async (source: string) => {
    setMarketplaceBusy(true);
    setMarketplaceError(null);
    try {
      const marketplace = customMarketplaceFromSource(source);
      const result = await runPluginCommand(buildAddMarketplaceCommand(marketplace));
      if (!result.ok) throw new Error(result.message);
      registry.addMarketplace(marketplace);
      setMarketplaceOpen(false);
      toast.success(`${marketplace.name} added.`);
    } catch (error) {
      setMarketplaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketplaceBusy(false);
    }
  };

  return (
    <div data-testid="plugin-library-workspace" className="flex h-full min-h-0 flex-col bg-droid-bg">
      <div data-electron-drag-region className="flex h-10 shrink-0 items-center justify-between px-4">
        {!selectedPlugin ? (
          <div className="flex items-center gap-1" data-electron-no-drag>
            {(['plugins', 'skills'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium capitalize transition-colors ${
                  tab === value
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:text-droid-text'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-droid-text-muted">Plugins</span>
        )}

        <div className="flex items-center gap-1" data-electron-no-drag>
          <button
            type="button"
            onClick={githubSetup.refresh}
            className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
            title="Refresh plugin connections"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-lg p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
            title="Plugin and connector settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setMarketplaceError(null);
              setMarketplaceOpen(true);
            }}
            className="ml-1 inline-flex items-center gap-1 rounded-lg bg-droid-text px-2.5 py-1.5 text-[11.5px] font-semibold text-droid-bg transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> Add <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      {selectedPlugin ? (
        <PluginDetail
          plugin={selectedPlugin}
          registry={registry.state}
          githubSetup={githubSetup}
          busy={operation?.pluginId === selectedPlugin.id}
          error={operation?.pluginId === selectedPlugin.id ? operationError : null}
          onBack={() => onSelectPlugin(null)}
          onUse={onUsePlugin}
          onInstall={() => install(selectedPlugin)}
          onUpdate={() => update(selectedPlugin)}
          onUninstall={() => uninstall(selectedPlugin)}
          onRemoveLegacyGithub={() => removeLegacyGithub(selectedPlugin)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-8">
            <div className="flex items-start gap-3">
              <span className="mt-1 flex h-8 w-8 items-center justify-center rounded-xl border border-droid-border bg-droid-elevated text-droid-text-secondary">
                <Blocks className="h-4 w-4" />
              </span>
              <div>
                <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-droid-text">
                  {tab === 'plugins' ? 'Plugins' : 'Skills'}
                </h1>
                <p className="mt-1 text-[12px] text-droid-text-muted">
                  {tab === 'plugins'
                    ? 'Work with DROIDEX across your tools without duplicating packages per chat.'
                    : 'Browse the focused skills exposed by installed plugins.'}
                </p>
              </div>
            </div>

            <label className="relative mt-6 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-droid-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tab === 'plugins' ? 'Search plugins' : 'Search skills'}
                className="w-full rounded-xl border border-droid-border bg-droid-elevated py-2.5 pl-9 pr-3 text-[12px] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/45 focus:border-droid-border-hover"
              />
            </label>

            <div className="mt-5 inline-flex items-center rounded-xl bg-droid-elevated p-1">
              {(['public', 'personal'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-medium capitalize transition-colors ${
                    scope === value
                      ? 'bg-droid-surface text-droid-text'
                      : 'text-droid-text-muted hover:text-droid-text'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>

            <PluginBrowse
              tab={tab}
              scope={scope}
              query={query}
              registry={registry.state}
              busyPluginId={operation?.pluginId ?? null}
              onOpen={(plugin) => {
                setOperationError(null);
                onSelectPlugin(plugin.slug);
              }}
              onInstall={install}
              onAddMarketplace={() => {
                setMarketplaceError(null);
                setMarketplaceOpen(true);
              }}
            />
          </div>
        </div>
      )}

      <PluginMarketplaceDialog
        open={marketplaceOpen}
        busy={marketplaceBusy}
        error={marketplaceError}
        onClose={() => {
          if (!marketplaceBusy) setMarketplaceOpen(false);
        }}
        onAdd={(source) => void addMarketplace(source)}
      />
    </div>
  );
}
