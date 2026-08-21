import { Check, LoaderCircle } from 'lucide-react';

import type { PluginDefinition } from '../pluginCatalog';
import type { PluginRegistryState } from '../pluginRegistry';
import { pluginIsAvailable } from '../pluginRegistry';
import { PluginBrandIcon } from './PluginBrandIcon';

export function PluginRow({
  plugin,
  registry,
  busy,
  onOpen,
  onInstall,
}: {
  plugin: PluginDefinition;
  registry: PluginRegistryState;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const available = pluginIsAvailable(registry, plugin);
  const connector = plugin.adapter === 'github-cli';

  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-droid-elevated/55">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
      >
        <PluginBrandIcon plugin={plugin} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-droid-text">
            {plugin.name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-droid-text-muted">
            {plugin.description}
          </span>
        </span>
      </button>

      {available ? (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[10.5px] font-medium text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text"
        >
          <Check className="h-3 w-3" /> {connector ? 'Connected' : 'Installed'}
        </button>
      ) : (
        <button
          type="button"
          onClick={connector ? onOpen : onInstall}
          disabled={busy}
          className="inline-flex min-w-[68px] shrink-0 items-center justify-center gap-1 rounded-lg border border-droid-border bg-droid-surface px-2.5 py-1.5 text-[10.5px] font-medium text-droid-text transition-colors hover:border-droid-border-hover hover:bg-droid-active disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}
          {busy ? 'Working…' : connector ? 'Connect' : 'Install'}
        </button>
      )}
    </div>
  );
}
