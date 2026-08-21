import { pluginSlugFromReference } from '../../lib/pluginReferences';
import { pluginBySlug } from './pluginCatalog';

export function appendPluginContext(composedPrompt: string, references: readonly string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const reference of references) {
    const slug = pluginSlugFromReference(reference);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const plugin = pluginBySlug(slug);
    if (!plugin) continue;
    lines.push(`- ${plugin.name}: ${plugin.semanticSummary}`);
  }
  if (lines.length === 0) return composedPrompt;
  return `${composedPrompt}\n\nSelected DROIDEX plugins (discover full tools only when relevant):\n${lines.join('\n')}`;
}
