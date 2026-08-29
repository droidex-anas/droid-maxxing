import { CursorProviderAdapter } from './cursor/CursorAdapter.js';
import { GrokProviderAdapter } from './grok/GrokAdapter.js';
import { createDefaultProviderRegistry, type ProviderRegistry } from './ProviderRegistry.js';
import type { ProviderAdapter } from './providerTypes.js';

export function createHostProviderRegistry(adapters: {
  droid: () => ProviderAdapter;
}): ProviderRegistry {
  return createDefaultProviderRegistry({
    droid: adapters.droid,
    cursor: () => new CursorProviderAdapter(),
    grok: () => new GrokProviderAdapter(),
  });
}
