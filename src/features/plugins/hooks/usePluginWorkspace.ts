import { useCallback, useEffect, useState } from 'react';

import { pluginSlugFromReference } from '../../../lib/pluginReferences';
import {
  ADD_PLUGIN_TO_COMPOSER_EVENT,
  OPEN_PLUGIN_LIBRARY_EVENT,
  type AddPluginToComposerDetail,
  type OpenPluginLibraryDetail,
} from '../pluginEvents';

export interface PluginWorkspaceController {
  isOpen: boolean;
  selectedSlug: string | null;
  open: (slug?: string) => void;
  close: () => void;
  select: (slug: string | null) => void;
  useInComposer: (reference: string) => void;
}

export function usePluginWorkspace(): PluginWorkspaceController {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const open = useCallback((slug?: string) => {
    setSelectedSlug(slug ?? null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setSelectedSlug(null);
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenPluginLibraryDetail>).detail;
      open(detail?.slug);
    };
    window.addEventListener(OPEN_PLUGIN_LIBRARY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PLUGIN_LIBRARY_EVENT, onOpen);
  }, [open]);

  const useInComposer = useCallback(
    (reference: string) => {
      const slug = pluginSlugFromReference(reference);
      if (!slug) return;
      window.dispatchEvent(
        new CustomEvent<AddPluginToComposerDetail>(ADD_PLUGIN_TO_COMPOSER_EVENT, {
          detail: { slug, reference },
        }),
      );
      close();
    },
    [close],
  );

  return { isOpen, selectedSlug, open, close, select: setSelectedSlug, useInComposer };
}
