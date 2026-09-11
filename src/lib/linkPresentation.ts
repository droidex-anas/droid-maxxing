// How a link in a message is presented: the site it points at, and a compact
// label for the links whose URL says more than it shows.

export interface LinkPresentation {
  // Set only when the link text is the bare URL and the URL has a better name
  // for itself. A link the author titled keeps that title.
  label: string | null;
  host: string;
  // GitHub carries a bundled mark: its own favicon is a black octocat that
  // disappears against a dark transcript. Every other site shows its favicon.
  isGitHub: boolean;
}

// Mirrors FAVICON_SCHEME in electron/favicons.cjs, which fetches, validates and
// caches the icon in the main process.
const FAVICON_SCHEME = 'droidex-favicon';

export function faviconUrl(host: string): string {
  return `${FAVICON_SCHEME}://${host}/`;
}

function gitHubLabel(path: string): string | null {
  const [owner, repo, kind, rest] = path.replace(/^\//, '').split('/');
  if (!owner || !repo) return null;
  // Only real identifiers get a name; `/pull/new` keeps its address.
  if (kind === 'pull' && /^\d+$/.test(rest)) return `PR #${rest}`;
  if (kind === 'issues' && /^\d+$/.test(rest)) return `Issue #${rest}`;
  if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(rest)) return rest.slice(0, 7);
  if (!kind) return `${owner}/${repo}`;
  return null;
}

export function describeLink(href: string): LinkPresentation | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  if (url.hostname.replace(/^www\./, '') === 'github.com') {
    return { label: gitHubLabel(url.pathname), host: url.hostname, isGitHub: true };
  }
  // A shortened URL would hide where a link actually goes, so only a site that
  // names its own pages — GitHub, above — gets its text replaced.
  return { label: null, host: url.hostname, isGitHub: false };
}

// Whether the link's visible text is just its URL, in which case a better label
// is an improvement rather than a substitution for what the author wrote.
export function linkTextIsUrl(text: string, href: string): boolean {
  const shown = text.trim().replace(/\/$/, '');
  const target = href.trim().replace(/\/$/, '');
  return shown === target || `https://${shown}` === target || `http://${shown}` === target;
}
