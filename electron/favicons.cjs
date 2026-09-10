/**
 * Site icons for links in the transcript.
 *
 * A link's mark is the linked site's own favicon, fetched once per host by the
 * main process and served to the renderer through `droidex-favicon://<host>/`.
 * The renderer never contacts arbitrary origins itself, and Node's fetch keeps
 * these requests out of every browsing session, so no cookies are sent.
 *
 * Rendering a message must not become a way to make the app probe the user's
 * network, so only public HTTPS hosts on the default port are contacted: IP
 * literals, local and reserved names, and names that resolve to private
 * addresses are refused, and every redirect is checked the same way. Bodies are
 * size-capped and must sniff as an image. A site's answer — including "no
 * usable icon" — is cached on disk; a network failure is not, so being offline
 * once does not blank every icon for a day.
 *
 * Kept free of `require('electron')` so it runs under plain Node.
 */

const dns = require('node:dns/promises');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const FAVICON_SCHEME = 'droidex-favicon';
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const RESERVED_TLDS = new Set([
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
  'test',
  'example',
  'invalid',
  'onion',
  'arpa',
]);

// A definitive answer — no icon, not an image, refused by policy — as opposed
// to a network failure that is worth asking about again later.
class IconUnavailable extends Error {}

function isPublicHostname(host) {
  if (host.length > 253 || net.isIP(host) !== 0) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  return !RESERVED_TLDS.has(host.slice(host.lastIndexOf('.') + 1));
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/** The host a `droidex-favicon://` URL asks about, or throws if it is not one we serve. */
function faviconRequestHost(requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== `${FAVICON_SCHEME}:`) throw new Error(`Unsupported scheme: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) throw new Error(`Not a public host: ${host}`);
  return host;
}

async function assertPublicTarget(url, lookup) {
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw new IconUnavailable(`Refusing ${url.href}: HTTPS on the default port only`);
  }
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) throw new IconUnavailable(`Refusing non-public host ${host}`);
  const addresses = await lookup(host, { all: true });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new IconUnavailable(`Refusing ${host}: it resolves to a private address`);
  }
}

// A page is only needed as far as its <head>, so it is cut off at the cap; an
// icon over the cap is not an icon worth showing.
async function readBody(response, maxBytes, truncate) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      if (!truncate) throw new IconUnavailable('Body exceeds the size cap');
      chunks.push(Buffer.from(chunk).subarray(0, chunk.byteLength - (total - maxBytes)));
      break;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchFollowing(start, options) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicTarget(url, options.lookup);
    const response = await options.fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: options.accept, 'user-agent': options.userAgent },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new IconUnavailable(`${url.href} answered ${String(response.status)}`);
    }
    const body = await readBody(response, options.maxBytes, options.truncate);
    return { url, body, contentType: response.headers.get('content-type') ?? '' };
  }
  throw new IconUnavailable(`Too many redirects from ${start.href}`);
}

const LINK_TAG = /<link\b[^>]*>/gi;

function attributeOf(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    tag,
  );
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : '';
}

// Ranks the icons a page declares for a 14px mark on a dark transcript. A
// raster icon drawn at 32px or more comes first: SVG favicons are usually drawn
// for light browser tabs — MDN's is a black glyph on transparent — and vanish
// against a dark background, while sized raster icons tend to carry their own
// backdrop. Then SVG, then any icon, then the touch icon as a last resort.
function iconRank(tag, href) {
  const rel = attributeOf(tag, 'rel').toLowerCase().split(/\s+/);
  const isIcon = rel.includes('icon');
  if (!isIcon && !rel.includes('apple-touch-icon')) return 0;
  const isSvg = attributeOf(tag, 'type').includes('svg') || /\.svg(?:[?#]|$)/i.test(href);
  const sizes = (attributeOf(tag, 'sizes').match(/\d+/g) ?? []).map(Number);
  if (isIcon && !isSvg && sizes.some((size) => size >= 32)) return 4;
  if (isSvg) return 3;
  return isIcon ? 2 : 1;
}

function declaredIcons(html, pageUrl) {
  const found = [];
  for (const tag of html.match(LINK_TAG) ?? []) {
    const href = attributeOf(tag, 'href').replace(/&amp;/g, '&');
    const rank = href ? iconRank(tag, href) : 0;
    if (rank > 0 && URL.canParse(href, pageUrl)) found.push({ rank, url: new URL(href, pageUrl) });
  }
  // Stable sort: among equal ranks the page's own order wins.
  return found.sort((a, b) => b.rank - a.rank).map((entry) => entry.url);
}

function sniffImage(body, contentType) {
  const ascii = (start, end) => body.subarray(start, end).toString('latin1');
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (body[0] === 0 && body[1] === 0 && (body[2] === 1 || body[2] === 2) && body[3] === 0) {
    return 'image/x-icon';
  }
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  const text = body.subarray(0, 2048).toString('utf8').trimStart().toLowerCase();
  const looksSvg =
    contentType.includes('svg') || text.startsWith('<svg') || text.startsWith('<?xml');
  return looksSvg && text.includes('<svg') ? 'image/svg+xml' : null;
}

function createFaviconStore({
  cacheDir,
  userAgent,
  logError,
  fetchImpl = fetch,
  lookup = dns.lookup,
  fs = fsp,
  now = Date.now,
}) {
  const settled = new Map();
  const inFlight = new Map();
  const retryAfter = new Map();
  const request = { fetchImpl, lookup, userAgent };

  async function fetchIcon(host) {
    const origin = new URL(`https://${host}/`);
    const candidates = [];
    try {
      const page = await fetchFollowing(origin, {
        ...request,
        accept: 'text/html',
        maxBytes: MAX_PAGE_BYTES,
        truncate: true,
      });
      candidates.push(...declaredIcons(page.body.toString('utf8'), page.url));
    } catch (error) {
      if (!(error instanceof IconUnavailable)) throw error;
    }
    candidates.push(new URL('/favicon.ico', origin));
    const tried = new Set();
    for (const url of candidates) {
      if (tried.has(url.href)) continue;
      tried.add(url.href);
      try {
        const icon = await fetchFollowing(url, {
          ...request,
          accept: 'image/*',
          maxBytes: MAX_ICON_BYTES,
          truncate: false,
        });
        const mime = sniffImage(icon.body, icon.contentType);
        if (mime) return { mime, data: icon.body };
      } catch (error) {
        if (!(error instanceof IconUnavailable)) throw error;
      }
    }
    return null;
  }

  const cacheFiles = (host) => ({
    meta: path.join(cacheDir, `${host}.json`),
    icon: path.join(cacheDir, `${host}.icon`),
  });

  // undefined: nothing usable on disk. null: the site was asked and has no icon.
  async function readCached(host) {
    const files = cacheFiles(host);
    let record;
    try {
      record = JSON.parse(await fs.readFile(files.meta, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        logError(`Discarding the unreadable cache for ${host}: ${error.message}`);
      return undefined;
    }
    const ttl = record.mime ? FOUND_TTL_MS : MISSING_TTL_MS;
    if (typeof record.fetchedAt !== 'number' || now() - record.fetchedAt > ttl) return undefined;
    if (!record.mime) return null;
    try {
      return { mime: record.mime, data: await fs.readFile(files.icon) };
    } catch (error) {
      logError(`The cached icon for ${host} is gone: ${error.message}`);
      return undefined;
    }
  }

  async function writeCached(host, found) {
    const files = cacheFiles(host);
    await fs.mkdir(cacheDir, { recursive: true });
    if (found) await fs.writeFile(files.icon, found.data);
    await fs.writeFile(files.meta, JSON.stringify({ mime: found?.mime ?? null, fetchedAt: now() }));
  }

  async function resolveIcon(host) {
    const cached = await readCached(host);
    if (cached !== undefined) return cached;
    const found = await fetchIcon(host);
    await writeCached(host, found).catch((error) => {
      logError(`Could not cache the icon for ${host}: ${error.message}`);
    });
    return found;
  }

  /** The icon for a public host, or null when it has none or cannot be reached right now. */
  function load(host) {
    if (settled.has(host)) return Promise.resolve(settled.get(host));
    if ((retryAfter.get(host) ?? 0) > now()) return Promise.resolve(null);
    let pending = inFlight.get(host);
    if (!pending) {
      pending = resolveIcon(host)
        .then((found) => {
          settled.set(host, found);
          return found;
        })
        .catch((error) => {
          retryAfter.set(host, now() + RETRY_AFTER_MS);
          logError(`Could not fetch the icon for ${host}: ${error.message}`);
          return null;
        })
        .finally(() => inFlight.delete(host));
      inFlight.set(host, pending);
    }
    return pending;
  }

  return { load };
}

module.exports = { FAVICON_SCHEME, createFaviconStore, faviconRequestHost };
