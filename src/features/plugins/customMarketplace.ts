import type { PluginMarketplace } from './pluginCatalog';

const SAFE_NAME = /[^a-z0-9._-]+/g;

function titleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sourceName(source: string): { name: string; owner: string; normalized: string } {
  const localPath = /^(?:~|\.{1,2})?\//.test(source);
  if (localPath) {
    const trimmed = source.replace(/\/+$/g, '');
    const name = trimmed.split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '') ?? 'marketplace';
    return { name, owner: 'Local', normalized: source };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Use an HTTP, HTTPS, file URL, or a local path.');
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error('Marketplace sources must use HTTP, HTTPS, file, or a local path.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const name = (segments.at(-1) ?? url.hostname ?? 'marketplace').replace(/\.git$/i, '');
  return {
    name,
    owner: url.hostname || 'Local',
    normalized: url.toString(),
  };
}

export function customMarketplaceFromSource(rawSource: string): PluginMarketplace {
  const source = rawSource.trim();
  if (!source) throw new Error('Enter a marketplace repository or local path.');
  const derived = sourceName(source);
  const cliName = derived.name.toLowerCase().replace(SAFE_NAME, '-').replace(/^-+|-+$/g, '');
  if (!cliName) throw new Error('DROIDEX could not derive a marketplace name from that source.');
  return {
    id: `custom/${cliName}`,
    cliName,
    name: titleCase(derived.name),
    sourceUrl: derived.normalized,
    description: `Plugin marketplace from ${derived.owner}.`,
  };
}
