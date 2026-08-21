import { useEffect, useMemo, useState } from 'react';
import { pluginReference } from '../../lib/pluginReferences';
import { PLUGIN_CATALOG } from './pluginCatalog';
import {
  loadPluginRegistry,
  PLUGIN_REGISTRY_EVENT,
  pluginIsAvailable,
  type PluginRegistryState,
} from './pluginRegistry';

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
