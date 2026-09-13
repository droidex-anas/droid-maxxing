import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Post-split measurements from perf phase 7 (#123) with modest headroom.
// Raised from 1_280_000 for the context-panel redesign (#216): the shared
// popover system and section rework added ~2.3KB to the entry chunk, which
// had only ~300B of headroom left on main.
// Raised from 1_285_000 for the activity inbox (#217): status derivation,
// the transcript digest, and the flyout view menu added ~6KB to the entry.
// Raised from 680_000 for Mermaid 11.16.1's security fixes: its new optional
// Cynefin diagram chunk is ~691KB; the initial renderer remains unchanged.
// Raised from 1_295_000 for the markdown initiative: the shared renderer's GFM
// tables and code cards, the live composer editor's wiring, and the sidebar
// title presentation added ~14KB to the entry. The editor engine itself stays
// lazy (ComposerEditor chunk, ~487KB).
//
// Raised again to 1_325_000 for link presentation (site marks, GitHub labels)
// and the composer's right-click menu, ~7KB together. The headroom above the
// current ~1_312_000 is deliberate: enough for ordinary work, small enough that
// a genuinely large addition still has to be argued for here.
//
// Raised from 1_325_000 to 1_340_000 for the UI polish pass (#222): app key
// bindings (~2KB), tool-call naming and MCP source marks (~2KB), file mentions
// in prose and chips that open Review (~1.7KB), native-surface obscuring and
// the measured banner stack (~0.6KB), plus small growth across the transcript
// rows and primitives. Main was already within a few hundred bytes of the old
// line; the new headroom is again ~10KB.
//
// initialCssBytes raised from 95_000 to 97_000 for the transcript polish: the
// scroll-position edge fade on wide tables and code, hover-only scrollbars, and
// the tightened typography and inline-code pill added ~0.9KB of CSS.
const BUDGETS = {
  initialRendererJsBytes: 1_340_000,
  initialCssBytes: 97_000,
  largestLazyChunkBytes: 700_000,
  duplicatePackageMaxBytes: 120_000,
};

const WORKER_SUFFIX = '.worker.';
const PACKAGE_MARKERS = [
  ['framer-motion', 'framer-motion'],
  ['react-markdown', 'react-markdown'],
  ['@sentry/electron', '@sentry/electron'],
  ['prism-react-renderer', 'prism-react-renderer'],
  ['prismjs', 'prismjs/prism'],
];

const root = process.cwd();
const distDir = join(root, 'dist');
const assetsDir = join(distDir, 'assets');

function readEntryAssets() {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const scriptMatch = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/);
  const cssMatch = html.match(/<link[^>]+href="\.\/assets\/([^"]+\.css)"/);
  if (!scriptMatch || !cssMatch) {
    throw new Error('Could not resolve renderer entry assets from dist/index.html.');
  }
  return {
    entryJs: join(assetsDir, scriptMatch[1]),
    entryCss: join(assetsDir, cssMatch[1]),
  };
}

function listJsChunks() {
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(assetsDir, name));
}

function bytes(path) {
  return statSync(path).size;
}

function findDuplicatePackages(chunks) {
  const violations = [];
  for (const [label, marker] of PACKAGE_MARKERS) {
    const hits = chunks.filter((chunk) => readFileSync(chunk, 'utf8').includes(marker));
    if (hits.length <= 1) continue;
    const totalBytes = hits.reduce((sum, chunk) => sum + bytes(chunk), 0);
    if (totalBytes > BUDGETS.duplicatePackageMaxBytes) {
      violations.push(
        `${label} appears in ${String(hits.length)} chunks (${String(totalBytes)} bytes total, budget ${String(BUDGETS.duplicatePackageMaxBytes)})`,
      );
    }
  }
  return violations;
}

function main() {
  const { entryJs, entryCss } = readEntryAssets();
  const entryJsBytes = bytes(entryJs);
  const entryCssBytes = bytes(entryCss);

  const lazyChunks = listJsChunks().filter(
    (chunk) => chunk !== entryJs && !chunk.includes(WORKER_SUFFIX),
  );
  const largestLazy = lazyChunks.reduce(
    (max, chunk) => Math.max(max, bytes(chunk)),
    0,
  );

  const violations = [];
  if (entryJsBytes > BUDGETS.initialRendererJsBytes) {
    violations.push(
      `initial renderer JS ${String(entryJsBytes)} bytes exceeds ${String(BUDGETS.initialRendererJsBytes)} (${entryJs})`,
    );
  }
  if (entryCssBytes > BUDGETS.initialCssBytes) {
    violations.push(
      `initial CSS ${String(entryCssBytes)} bytes exceeds ${String(BUDGETS.initialCssBytes)} (${entryCss})`,
    );
  }
  if (largestLazy > BUDGETS.largestLazyChunkBytes) {
    violations.push(
      `largest lazy chunk ${String(largestLazy)} bytes exceeds ${String(BUDGETS.largestLazyChunkBytes)}`,
    );
  }
  violations.push(...findDuplicatePackages(listJsChunks()));

  if (violations.length > 0) {
    console.error('Bundle budget check failed:\n' + violations.join('\n'));
    process.exit(1);
  }

  console.log(
    [
      `Initial renderer JS: ${String(entryJsBytes)} bytes (budget ${String(BUDGETS.initialRendererJsBytes)})`,
      `Initial CSS: ${String(entryCssBytes)} bytes (budget ${String(BUDGETS.initialCssBytes)})`,
      `Largest lazy chunk: ${String(largestLazy)} bytes (budget ${String(BUDGETS.largestLazyChunkBytes)})`,
      'Duplicate dependency scan: ok',
    ].join('\n'),
  );
}

main();
