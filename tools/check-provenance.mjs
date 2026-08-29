import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const PINNED_SHA = '4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d';
const NOTICES_PATH = join(root, 'THIRD_PARTY_NOTICES.md');
const LICENSE_PATH = join(root, 'third_party/t3-code/LICENSE');
const LICENSE_COPYRIGHT = 'Copyright (c) 2026 T3 Tools Inc.';
const SOURCE_DIRS = ['src', join('sidecar', 'src')];
const DERIVED_FROM_PATTERN = /@derived-from\s+t3code@[a-f0-9]+\s+(\S+)/g;
const SOURCE_MAP_ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|/;

const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(path, label) {
  if (!existsSync(path)) {
    fail(`${label} is missing: ${relative(root, path)}`);
    return null;
  }

  return readFileSync(path, 'utf8');
}

function parseSourceMap(notices) {
  const upstreamPaths = new Set();
  const droidexPaths = [];

  let inSourceMap = false;
  for (const line of notices.split('\n')) {
    if (line.startsWith('### Source map')) {
      inSourceMap = true;
      continue;
    }

    if (!inSourceMap) continue;
    if (line.startsWith('### ')) break;

    const match = line.match(SOURCE_MAP_ROW_PATTERN);
    if (!match) continue;

    const upstreamPath = match[1].trim();
    const droidexPath = match[2].trim().replace(/^`|`$/g, '');

    upstreamPaths.add(upstreamPath);
    droidexPaths.push({ upstreamPath, droidexPath });
  }

  if (upstreamPaths.size === 0) {
    fail('THIRD_PARTY_NOTICES.md does not contain a parseable source map table.');
  }

  return { upstreamPaths, droidexPaths };
}

function walkFiles(dir, files = []) {
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      walkFiles(absolutePath, files);
      continue;
    }

    if (stats.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function collectDerivedFromReferences() {
  const references = [];

  for (const sourceDir of SOURCE_DIRS) {
    const absoluteDir = join(root, sourceDir);
    for (const filePath of walkFiles(absoluteDir)) {
      const contents = readFileSync(filePath, 'utf8');
      for (const match of contents.matchAll(DERIVED_FROM_PATTERN)) {
        references.push({
          file: relative(root, filePath),
          upstreamPath: match[1],
        });
      }
    }
  }

  return references;
}

const notices = readText(NOTICES_PATH, 'THIRD_PARTY_NOTICES.md');
const license = readText(LICENSE_PATH, 'third_party/t3-code/LICENSE');

if (notices && !notices.includes(PINNED_SHA)) {
  fail(`THIRD_PARTY_NOTICES.md does not contain the pinned upstream SHA: ${PINNED_SHA}`);
}

if (license && !license.includes(LICENSE_COPYRIGHT)) {
  fail(`third_party/t3-code/LICENSE is missing the required copyright line: ${LICENSE_COPYRIGHT}`);
}

const sourceMap = notices ? parseSourceMap(notices) : { upstreamPaths: new Set(), droidexPaths: [] };

if (sourceMap) {
  for (const { upstreamPath, droidexPath } of sourceMap.droidexPaths) {
    if (droidexPath === 'not yet ported') continue;

    const normalizedPath = droidexPath.replace(/^`|`$/g, '');
    if (!existsSync(join(root, normalizedPath))) {
      fail(`Source map lists missing DROIDEX path: ${normalizedPath} (from upstream ${upstreamPath})`);
    }
  }

  for (const { file, upstreamPath } of collectDerivedFromReferences()) {
    if (!sourceMap.upstreamPaths.has(upstreamPath)) {
      fail(
        `${file} references unlisted upstream path in @derived-from: ${upstreamPath}. Add it to THIRD_PARTY_NOTICES.md or fix the header.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Provenance check failed:\n' + failures.map((message) => `- ${message}`).join('\n'));
  process.exit(1);
}

console.log(
  `Provenance check passed for T3 Code pin ${PINNED_SHA} (${sourceMap.upstreamPaths.size} mapped upstream paths).`,
);
