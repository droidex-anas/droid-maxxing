const PLUGIN_REFERENCE_PREFIX = 'droidex-plugin://';
const PLUGIN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function pluginReference(slug: string): string {
  if (!PLUGIN_SLUG.test(slug)) throw new Error(`Invalid plugin slug: ${slug}`);
  return `${PLUGIN_REFERENCE_PREFIX}${slug}`;
}

export function isPluginReference(value: string): boolean {
  return value.startsWith(PLUGIN_REFERENCE_PREFIX) && pluginSlugFromReference(value) !== null;
}

export function pluginSlugFromReference(value: string): string | null {
  if (!value.startsWith(PLUGIN_REFERENCE_PREFIX)) return null;
  const slug = value.slice(PLUGIN_REFERENCE_PREFIX.length);
  return PLUGIN_SLUG.test(slug) ? slug : null;
}

export function pluginMentionFromReference(value: string): string | null {
  const slug = pluginSlugFromReference(value);
  return slug ? `@${slug}` : null;
}

export function splitPluginReferences(values: readonly string[]): {
  pluginReferences: string[];
  files: string[];
} {
  const pluginReferences: string[] = [];
  const files: string[] = [];
  for (const value of values) {
    if (isPluginReference(value)) pluginReferences.push(value);
    else files.push(value);
  }
  return { pluginReferences, files };
}
