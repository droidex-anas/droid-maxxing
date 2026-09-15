import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const directory = resolve('electron/mobile/RemoteArtwork');
const read = (name: string): string => readFileSync(resolve(directory, name), 'utf8');

test('the checked-in standalone HTML and share guide match their editable sources', () => {
  execFileSync(process.execPath, ['tools/build-remote-artwork.mjs', '--check'], { encoding: 'utf8' });
});

test('artwork is vector-only and carries no network address or usable pairing payload', () => {
  for (const name of ['banner.svg', 'guide.svg']) {
    const svg = read(name);
    assert.match(svg, /<svg\b/);
    assert.doesNotMatch(svg, /<(?:image|script|foreignObject)\b/i);
    assert.doesNotMatch(svg.replace('http://www.w3.org/2000/svg', ''), /(?:https?:\/\/|data:image|DX1\.)/);
    const references = [...svg.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(references.every((reference) => reference.startsWith('#')));
    assert.match(svg, /(?:not a pairing QR|No usable pairing code)/);
  }
});

test('the embedded player permits only its exact script hash and no connections', () => {
  const hash = createHash('sha256').update(read('player.js')).digest('base64');
  const html = read('banner.html');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes("default-src 'none'"));
  assert.doesNotMatch(html, /<script\s+src=|<link\b|<iframe\b/i);
});
