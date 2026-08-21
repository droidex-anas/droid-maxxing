import { X } from 'lucide-react';

import { pluginSlugFromReference } from '../../../lib/pluginReferences';
import { pluginBySlug } from '../pluginCatalog';
import { PluginBrandIcon } from './PluginBrandIcon';

export function PluginComposerChip({
  reference,
  onRemove,
}: {
  reference: string;
  onRemove: () => void;
}) {
  const slug = pluginSlugFromReference(reference);
  const plugin = slug ? pluginBySlug(slug) : undefined;
  if (!plugin) return null;

  return (
    <span
      className="group inline-flex items-center gap-1.5 rounded-lg py-1 pl-1.5 pr-1 text-[11px] font-medium text-droid-text"
      style={{
        background: `color-mix(in srgb, ${plugin.brandColor} 12%, var(--droid-bg))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${plugin.brandColor} 28%, var(--droid-border))`,
      }}
      title={plugin.semanticSummary}
    >
      <PluginBrandIcon plugin={plugin} size={18} framed={false} />
      <span>{plugin.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-droid-text-muted transition-colors hover:bg-black/20 hover:text-droid-text"
        title={`Remove ${plugin.name}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
