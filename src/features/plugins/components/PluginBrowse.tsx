import { Plus } from 'lucide-react';

import {
  PLUGIN_CATALOG,
  PLUGIN_CATEGORIES,
  type PluginDefinition,
} from '../pluginCatalog';
import type { PluginRegistryState } from '../pluginRegistry';
import { pluginIsAvailable } from '../pluginRegistry';
import { PluginBrandIcon } from './PluginBrandIcon';
import { PluginRow } from './PluginRow';

export type PluginLibraryTab = 'plugins' | 'skills';
export type PluginLibraryScope = 'public' | 'personal';

function matchesQuery(plugin: PluginDefinition, query: string): boolean {
  if (!query) return true;
  return [
    plugin.name,
    plugin.description,
    plugin.longDescription,
    plugin.publisher,
    plugin.category,
    plugin.semanticSummary,
    ...plugin.skills.flatMap((skill) => [skill.name, skill.description]),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 border-b border-droid-border/70 px-2 pb-2 text-[13px] font-semibold text-droid-text">
      {children}
    </div>
  );
}

function PluginGrid({
  plugins,
  registry,
  busyPluginId,
  onOpen,
  onInstall,
}: {
  plugins: PluginDefinition[];
  registry: PluginRegistryState;
  busyPluginId: string | null;
  onOpen: (plugin: PluginDefinition) => void;
  onInstall: (plugin: PluginDefinition) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-7 gap-y-0.5 lg:grid-cols-2">
      {plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          registry={registry}
          busy={busyPluginId === plugin.id}
          onOpen={() => onOpen(plugin)}
          onInstall={() => onInstall(plugin)}
        />
      ))}
    </div>
  );
}

function InstalledRail({
  registry,
  onOpen,
}: {
  registry: PluginRegistryState;
  onOpen: (plugin: PluginDefinition) => void;
}) {
  const installed = PLUGIN_CATALOG.filter((plugin) => pluginIsAvailable(registry, plugin));
  return (
    <section className="mt-8">
      <SectionTitle>Installed</SectionTitle>
      {installed.length === 0 ? (
        <p className="px-2 py-2 text-[11.5px] text-droid-text-muted">
          Installed plugins and connected apps appear here.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1">
          {installed.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              onClick={() => onOpen(plugin)}
              title={plugin.name}
              className="rounded-xl transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/50"
            >
              <PluginBrandIcon plugin={plugin} size={36} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function PersonalMarketplaces({
  registry,
  onAddMarketplace,
}: {
  registry: PluginRegistryState;
  onAddMarketplace: () => void;
}) {
  return (
    <section className="mt-8">
      <SectionTitle>Personal marketplaces</SectionTitle>
      {registry.marketplaces.length === 0 ? (
        <div className="px-2 py-5">
          <p className="max-w-md text-[11.5px] leading-5 text-droid-text-muted">
            Add a marketplace once and Droid can install its plugins globally without copying the
            package into every chat or workspace.
          </p>
          <button
            type="button"
            onClick={onAddMarketplace}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated px-3 py-2 text-[11.5px] font-medium text-droid-text transition-colors hover:bg-droid-active"
          >
            <Plus className="h-3.5 w-3.5" /> Add marketplace
          </button>
        </div>
      ) : (
        <div className="divide-y divide-droid-border/70">
          {registry.marketplaces.map((marketplace) => (
            <div key={marketplace.id} className="flex items-center gap-3 px-2 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-droid-border bg-droid-elevated text-[11px] font-semibold text-droid-text-secondary">
                {marketplace.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-droid-text">
                  {marketplace.name}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">
                  {marketplace.sourceUrl}
                </div>
              </div>
              <span className="text-[10.5px] text-droid-text-muted">Registered</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SkillsList({
  plugins,
  registry,
  onOpen,
}: {
  plugins: PluginDefinition[];
  registry: PluginRegistryState;
  onOpen: (plugin: PluginDefinition) => void;
}) {
  const rows = plugins.flatMap((plugin) =>
    plugin.skills.map((skill) => ({ plugin, skill, available: pluginIsAvailable(registry, plugin) })),
  );
  return (
    <section className="mt-8">
      <SectionTitle>Skills</SectionTitle>
      <div className="divide-y divide-droid-border/60">
        {rows.map(({ plugin, skill, available }) => (
          <button
            key={`${plugin.id}:${skill.name}`}
            type="button"
            onClick={() => onOpen(plugin)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-droid-elevated/55"
          >
            <PluginBrandIcon plugin={plugin} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-droid-text">
                {skill.name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-droid-text-muted">
                {skill.description} · {plugin.name}
              </span>
            </span>
            <span className="text-[10.5px] text-droid-text-muted">
              {available ? 'Available' : 'Install plugin'}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function PluginBrowse({
  tab,
  scope,
  query,
  registry,
  busyPluginId,
  onOpen,
  onInstall,
  onAddMarketplace,
}: {
  tab: PluginLibraryTab;
  scope: PluginLibraryScope;
  query: string;
  registry: PluginRegistryState;
  busyPluginId: string | null;
  onOpen: (plugin: PluginDefinition) => void;
  onInstall: (plugin: PluginDefinition) => void;
  onAddMarketplace: () => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = PLUGIN_CATALOG.filter((plugin) => matchesQuery(plugin, normalizedQuery));

  if (scope === 'personal') {
    return <PersonalMarketplaces registry={registry} onAddMarketplace={onAddMarketplace} />;
  }

  if (tab === 'skills') {
    return <SkillsList plugins={filtered} registry={registry} onOpen={onOpen} />;
  }

  const featured = filtered.filter((plugin) => plugin.featured);
  const remaining = filtered.filter((plugin) => !plugin.featured);

  return (
    <>
      <InstalledRail registry={registry} onOpen={onOpen} />

      {normalizedQuery ? (
        <section className="mt-8">
          <SectionTitle>Results</SectionTitle>
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-[11.5px] text-droid-text-muted">
              No plugins match this search.
            </p>
          ) : (
            <PluginGrid
              plugins={filtered}
              registry={registry}
              busyPluginId={busyPluginId}
              onOpen={onOpen}
              onInstall={onInstall}
            />
          )}
        </section>
      ) : (
        <>
          {featured.length > 0 && (
            <section className="mt-8">
              <SectionTitle>Featured</SectionTitle>
              <PluginGrid
                plugins={featured}
                registry={registry}
                busyPluginId={busyPluginId}
                onOpen={onOpen}
                onInstall={onInstall}
              />
            </section>
          )}
          {PLUGIN_CATEGORIES.map((category) => {
            const plugins = remaining.filter((plugin) => plugin.category === category);
            if (plugins.length === 0) return null;
            return (
              <section key={category} className="mt-8">
                <SectionTitle>{category}</SectionTitle>
                <PluginGrid
                  plugins={plugins}
                  registry={registry}
                  busyPluginId={busyPluginId}
                  onOpen={onOpen}
                  onInstall={onInstall}
                />
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
