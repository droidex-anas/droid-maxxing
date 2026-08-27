import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Post-split measurements from perf phase 7 (#123) with modest headroom.
const BUDGETS = {
  initialRendererJsBytes: 1_280_000,
  initialCssBytes: 95_000,
  largestLazyChunkBytes: 680_000,
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
