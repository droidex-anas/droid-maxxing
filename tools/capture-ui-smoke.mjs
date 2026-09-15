import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

// A temporary Vite entry isolates the real capture UI from agent startup. The
// desktop boundary is mocked; Canvas rendering and React interactions are not.
const root = process.cwd();
const fixture = await fs.mkdtemp(path.join(root, '.capture-smoke-'));
let server;
let browser;
try {
  await fs.writeFile(path.join(fixture, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
  await fs.writeFile(path.join(fixture, 'fixture.jsx'), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CaptureDialog from '/src/features/capture/CaptureDialog';
import { CaptureSettings } from '/src/features/capture/CaptureSettings';
import { drawCapture, loadCaptureImage, exportCapture } from '/src/features/capture/render';
import '/src/index.css';
const style = { preset: 'ember', padding: 64, radius: 18, shadow: 32, texture: .12 };
let preferences = { version: 1, style, sound: false, smartSelection: true, shortcut: '' };
const entries = new Map();
const captures = [];
let copies = 0;
const source = document.createElement('canvas'); source.width = 400; source.height = 240;
const ctx = source.getContext('2d'); ctx.fillStyle = '#606060'; ctx.fillRect(0, 0, 400, 240); ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, 100, 240); ctx.fillStyle = '#323232'; ctx.fillRect(0, 60, 100, 40);
const sourceUrl = source.toDataURL('image/png');
const newDocument = () => {
  const item = { id: crypto.randomUUID(), title: 'Sidebar capture', createdAt: Date.now(), revision: 0, width: 400, height: 240, hasExport: false, source: sourceUrl, recipe: { version: 1, crop: { x: 0, y: 0, width: 400, height: 240 }, style: structuredClone(preferences.style) } };
  entries.set(item.id, item); return structuredClone(item);
};
window.droidCapture = {
  preferences: async () => ({ preferences: structuredClone(preferences), nativeAvailable: true, shortcutRegistered: true }),
  setPreferences: async value => { preferences = structuredClone(value); return { preferences: structuredClone(preferences), nativeAvailable: true, shortcutRegistered: true }; },
  take: async () => newDocument(), cancel: async () => {},
  import: async () => newDocument(), read: async id => structuredClone(entries.get(id)),
  list: async () => [...entries.values()], thumbnail: async id => entries.get(id)?.output ?? null,
  delete: async id => { entries.delete(id); },
  save: async (id, revision, recipe, output) => {
    const previous = entries.get(id);
    if (previous.revision !== revision) throw new Error('Revision conflict');
    const image = await loadCaptureImage(output);
    const item = { ...previous, recipe: structuredClone(recipe), revision: revision + 1, output, outputWidth: image.naturalWidth, outputHeight: image.naturalHeight, hasExport: true };
    entries.set(id, item); return structuredClone(item);
  },
  copy: async () => { copies += 1; }, export: async () => true,
  attach: async id => { captures.push(id); return {}; }, onShortcut: () => () => {},
};
window.captureSmoke = {
  snapshot: () => ({ entries: [...entries.values()].map(({ source, output, ...item }) => item), captures, copies, preferences }),
  pixels: async () => {
    const image = await loadCaptureImage(sourceUrl);
    const recipe = { version: 1, crop: { x: 0, y: 60, width: 100, height: 40 }, style: { preset: 'transparent', padding: 0, radius: 0, shadow: 0, texture: 0 } };
    const png = await exportCapture(image, recipe);
    const decoded = await loadCaptureImage(png);
    const canvas = document.createElement('canvas'); drawCapture(canvas, decoded, { ...recipe, crop: { x: 0, y: 0, width: 100, height: 40 } });
    const pixel = [...canvas.getContext('2d').getImageData(50, 20, 1, 1).data];
    const empty = document.createElement('canvas'); empty.width = 40; empty.height = 40;
    const transparent = await loadCaptureImage(empty.toDataURL('image/png'));
    drawCapture(canvas, transparent, { version: 1, crop: { x: 0, y: 0, width: 40, height: 40 }, style: { ...recipe.style, padding: 20, shadow: 20, radius: 4 } });
    return { width: decoded.naturalWidth, height: decoded.naturalHeight, pixel, alpha: canvas.getContext('2d').getImageData(40, 40, 1, 1).data[3] };
  },
};
function Fixture() {
  const [mode, setMode] = useState(null);
  const [attached, setAttached] = useState('');
  return <main style={{ padding: 30 }}><button onClick={() => setMode('capture')}>Open capture</button><button onClick={() => setMode('settings')}>Open screenshot settings</button><output data-testid="attached">{attached}</output>{mode === 'capture' && <CaptureDialog onClose={() => setMode(null)} onAttach={async id => { captures.push(id); setAttached(id); }} />}{mode === 'settings' && <CaptureSettings onClose={() => setMode(null)} />}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({ server: { host: '127.0.0.1', port: 4199, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:4199/${path.basename(fixture)}/index.html`);
  await page.getByRole('button', { name: 'Open capture', exact: true }).click();
  await page.getByRole('button', { name: /^Area/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="attached"]')?.textContent.length > 0);
  let snapshot = await page.evaluate(() => window.captureSmoke.snapshot());
  assert.equal(snapshot.captures.length, 1);
  assert.equal(snapshot.entries[0].outputWidth, 528);
  assert.equal(snapshot.entries[0].outputHeight, 368);
  console.log('PASS: capture uses the saved background and attaches without an editor detour');

  await page.getByRole('button', { name: 'Open capture', exact: true }).click();
  await page.getByLabel('Refine before attaching').check();
  await page.getByRole('button', { name: /^Area/ }).click();
  await page.getByRole('button', { name: 'Refine selection', exact: true }).click();
  await page.getByLabel('Crop width', { exact: true }).fill('100');
  await page.getByLabel('Crop height', { exact: true }).fill('40');
  await page.getByLabel('Crop y', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'Use selection' }).click();
  await page.getByRole('button', { name: 'Halftone tide', exact: true }).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForFunction(() => window.captureSmoke.snapshot().copies === 1);
  snapshot = await page.evaluate(() => window.captureSmoke.snapshot());
  assert.equal(snapshot.entries[1].outputWidth, 228);
  assert.equal(snapshot.entries[1].outputHeight, 168);
  assert.equal(snapshot.preferences.style.preset, 'ember');
  await page.getByRole('button', { name: 'Make this my default', exact: true }).click();
  await page.waitForFunction(() => window.captureSmoke.snapshot().preferences.style.preset === 'tide');
  await page.getByRole('button', { name: 'Close capture', exact: true }).click();
  console.log('PASS: crop/export retain source pixel size; per-image changes do not rewrite defaults');

  await page.getByRole('button', { name: 'Open screenshot settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Screenshots', exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Calm capture click', exact: true }).click();
  await page.getByRole('button', { name: 'Save defaults', exact: true }).click();
  await page.waitForFunction(() => window.captureSmoke.snapshot().preferences.sound === true);
  assert.equal(await page.locator('.capture-recent-card').count(), 2);
  console.log('PASS: Settings saves preferences and exposes recent captures');

  const pixels = await page.evaluate(() => window.captureSmoke.pixels());
  assert.deepEqual(pixels, { width: 100, height: 40, pixel: [50, 50, 50, 255], alpha: 0 });
  assert.deepEqual(errors, []);
  console.log('PASS: PNG round-trip preserves content pixels and transparent source alpha');
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(fixture, { recursive: true, force: true });
}
