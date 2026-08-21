import { useCallback, useEffect, useMemo, useState } from 'react';

import { pluginReference } from '../../lib/pluginReferences';
import { PLUGIN_CATALOG, type PluginDefinition, type PluginMarketplace } from './pluginCatalog';
import {
  clearLegacyGithubPluginFlag,
  loadPluginRegistry,
  markConnectorReady,
  markPluginInstalled,
  PLUGIN_REGISTRY_EVENT,
  pluginIsAvailable,
  registerMarketplace,
  removePluginRecord,
  savePluginRegistry,
  type PluginRegistryState,
} from './pluginRegistry';

export interface PluginRegistryController {
  state: PluginRegistryState;
  markInstalled: (plugin: PluginDefinition) => void;
  removeInstalled: (pluginId: string) => void;
  setConnectorReady: (slug: string, ready: boolean) => void;
  addMarketplace: (marketplace: PluginMarketplace) => void;
  clearLegacyGithub: () => void;
}

export function usePluginRegistrySnapshot(): PluginRegistryState {
  const [state, setState] = useState(loadPluginRegistry);

  useEffect(() => {
    const refresh = () => setState(loadPluginRegistry());
    window.addEventListener(PLUGIN_REGISTRY_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PLUGIN_REGISTRY_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return state;
}

export function usePluginRegistry(): PluginRegistryController {
  const [state, setState] = useState(loadPluginRegistry);

  useEffect(() => {
    const refresh = () => setState(loadPluginRegistry());
    window.addEventListener(PLUGIN_REGISTRY_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PLUGIN_REGISTRY_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const commit = useCallback((next: PluginRegistryState) => {
    setState(next);
    savePluginRegistry(next);
  }, []);

  const markInstalled = useCallback(
    (plugin: PluginDefinition) => commit(markPluginInstalled(state, plugin)),
    [commit, state],
  );
  const removeInstalled = useCallback(
    (pluginId: string) => commit(removePluginRecord(state, pluginId)),
    [commit, state],
  );
  const setConnectorReady = useCallback(
    (slug: string, ready: boolean) => {
      const next = markConnectorReady(state, slug, ready);
      if (next !== state) commit(next);
    },
    [commit, state],
  );
  const addMarketplace = useCallback(
    (marketplace: PluginMarketplace) => commit(registerMarketplace(state, marketplace)),
    [commit, state],
  );
  const clearLegacyGithub = useCallback(
    () => commit(clearLegacyGithubPluginFlag(state)),
    [commit, state],
  );

  return useMemo(
    () => ({
      state,
      markInstalled,
      removeInstalled,
      setConnectorReady,
      addMarketplace,
      clearLegacyGithub,
    }),
    [addMarketplace, clearLegacyGithub, markInstalled, removeInstalled, setConnectorReady, state],
  );
}

export function useComposerPluginReferences(): string[] {
  const registry = usePluginRegistrySnapshot();
  return useMemo(
    () =>
      PLUGIN_CATALOG.filter((plugin) => pluginIsAvailable(registry, plugin)).map((plugin) =>
        pluginReference(plugin.slug),
      ),
    [registry],
  );
}
