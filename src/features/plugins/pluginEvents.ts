import { pluginReference } from '../../lib/pluginReferences';

export const OPEN_PLUGIN_LIBRARY_EVENT = 'droidex:open-plugin-library';
export const ADD_PLUGIN_TO_COMPOSER_EVENT = 'droidex:add-plugin-to-composer';

export interface OpenPluginLibraryDetail {
  slug?: string;
}

export interface AddPluginToComposerDetail {
  slug: string;
  reference: string;
}

export function openPluginLibrary(slug?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenPluginLibraryDetail>(OPEN_PLUGIN_LIBRARY_EVENT, {
      detail: slug ? { slug } : {},
    }),
  );
}

export function addPluginToComposer(slug: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<AddPluginToComposerDetail>(ADD_PLUGIN_TO_COMPOSER_EVENT, {
      detail: { slug, reference: pluginReference(slug) },
    }),
  );
}
