import {
  Beaker,
  Braces,
  Bug,
  GitPullRequest,
  PanelsTopLeft,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';

import type { PluginDefinition, PluginIconKey } from '../pluginCatalog';

const SKILL_ICONS: Partial<Record<PluginIconKey, LucideIcon>> = {
  'droid-control': PanelsTopLeft,
  'droid-evolved': Sparkles,
  security: ShieldCheck,
  typescript: Braces,
  debugging: Bug,
  'code-review': GitPullRequest,
  autoresearch: Beaker,
};

export function PluginBrandIcon({
  plugin,
  size = 28,
  framed = true,
  className = '',
}: {
  plugin: PluginDefinition;
  size?: number;
  framed?: boolean;
  className?: string;
}) {
  const glyphSize = Math.max(14, Math.round(size * 0.58));
  const style = plugin.icon === 'github' ? { color: 'var(--droid-text)' } : { color: plugin.brandColor };
  const icon =
    plugin.icon === 'github' ? (
      <FaGithub aria-hidden size={glyphSize} />
    ) : (
      (() => {
        const Icon = SKILL_ICONS[plugin.icon] ?? Sparkles;
        return <Icon aria-hidden size={glyphSize} strokeWidth={1.8} />;
      })()
    );

  if (!framed) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center ${className}`} style={style}>
        {icon}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-[10px] border border-droid-border bg-droid-elevated ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      {icon}
    </span>
  );
}
