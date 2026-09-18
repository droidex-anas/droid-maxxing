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
// rows and primitives. Those are the notable additions rather than the whole
// accounting: main had also drifted up over the days between the two raises,
// and this one covers both. The new headroom is again ~10KB.
//
// Raised from 1_340_000 to 1_350_000 for the inbox follow-ups on the same
// pass: status marks that settle on click (~2KB), hover intent for the view
// menu's cascade (~1KB), and check-rollup dots on PR icons (~1.5KB). The
// sidebar paints all three at first frame, so none can move off the entry.
//
// initialCssBytes raised from 95_000 to 97_000 for the transcript polish: the
// scroll-position edge fade on wide tables and code, hover-only scrollbars, and
// the tightened typography and inline-code pill added ~0.9KB of CSS.
//
// Raised from 1_350_000 to 1_365_000 for landing the provider-neutral UI stack
// (#258-#265, #274) beside the providers work: the files pane with its tree and
// preview, the running-processes menu, the update pill, and the utility pane
// rework measure ~2.6KB on top of main's entry. Main itself stood ~3.5KB over
// the old line after the ultra-effort level and the generated-image card landed
// without a bump, so most of the raise is catching up to what already shipped.
// Headroom above the merged ~1_356_100 is ~9KB.
//
// initialCssBytes raised from 97_000 to 100_000 on the same landing: main's
// generated-image grid and ultra-effort dots already measured ~1.2KB over the
// old line, and the stack adds ~0.8KB for the files pane chrome. The merged
// ~98_980 leaves ~1KB of headroom, in line with past CSS raises.
//
// Raised from 1_365_000 to 1_375_000 and initialCssBytes from 100_000 to
// 104_000 because both lines had run out, not because one change needed room.
// Measured on providers/integration before the agent-presence work: entry JS
// 1_363_597 and CSS 99_908, leaving 1_403 and 92 bytes. At 92 bytes a branch
// fails this gate for emitting a single Tailwind utility — the agent-presence
// work tripped it on one 41-byte `border-color: currentColor` rule — which is a
// tripwire rather than a signal, and it lands on whoever merges next rather
// than on whoever spent the bytes. That work itself adds 427 bytes of JS and 42
// of CSS. The new headroom is ~11KB and ~4KB, which restores the margin the
// earlier raises aimed for and is still small enough that a genuinely large
// addition has to be argued for here.
const BUDGETS = {
  initialRendererJsBytes: 1_375_000,
  initialCssBytes: 104_000,
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
