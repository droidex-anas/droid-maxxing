import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { format, resolveConfig } from 'prettier';
import { fileURLToPath } from 'node:url';
import { catalog } from './catalog.mjs';
import { renderGallery } from './render-gallery.mjs';

const root = new URL('../', import.meta.url);
await rm(new URL('svg/', root), { recursive: true, force: true });
await mkdir(new URL('svg/', root), { recursive: true });
await mkdir(new URL('gallery/', root), { recursive: true });

for (const { component, slug } of catalog) {
  const svg = renderToStaticMarkup(
    createElement(component, { xmlns: 'http://www.w3.org/2000/svg' }),
  );
  await writeFile(new URL(`svg/${slug}.svg`, root), `${svg}\n`);
}

await copyFile(new URL('src/styles.css', root), new URL('dist/styles.css', root));
await copyFile(new URL('src/styles.css', root), new URL('gallery/icons.css', root));
await copyFile(new URL('../../LICENSE', root), new URL('LICENSE', root));
const galleryPath = new URL('gallery/index.html', root);
const formatting = await resolveConfig(fileURLToPath(galleryPath));
await writeFile(galleryPath, await format(renderGallery(), { ...formatting, parser: 'html' }));
console.log(`Built ${catalog.length} SVGs and the standalone gallery.`);
