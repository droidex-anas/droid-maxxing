import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalog, featured } from './catalog.mjs';

const byName = new Map(catalog.map((icon) => [icon.name, icon]));

function glyph(name, size = 24) {
  const icon = byName.get(name);
  if (!icon) throw new Error(`Unknown gallery icon: ${name}`);
  return renderToStaticMarkup(
    createElement(icon.component, {
      size,
      className: name === 'Spinner' ? 'droid-icon-spin' : undefined,
    }),
  );
}

function drawings(name) {
  return [name, `${name}Filled`]
    .filter((key) => byName.has(key))
    .map((key) => {
      const icon = byName.get(key);
      return `<span class="drawing" data-variant="${icon.variant}" data-export="${key}" data-slug="${icon.slug}">${glyph(key)}</span>`;
    })
    .join('');
}

function chip(name, label, tone = '') {
  return `<span class="droid-icon-chip"><span data-droid-icon-tone="${tone}">${drawings(name)}</span>${label}</span>`;
}

export function renderGallery() {
  const families = catalog.filter((icon) => icon.variant === 'outline');
  const cards = families
    .map((icon) => {
      const hasFilled = byName.has(`${icon.name}Filled`);
      const keywords =
        `${icon.name} ${hasFilled ? `${icon.name}Filled` : ''} ${icon.category}`.toLowerCase();
      return `<button type="button" class="icon-card inspectable" data-category="${icon.category}" data-search="${keywords}">
      <span class="card-glyph">${drawings(icon.name)}</span>
      <span class="icon-name">${icon.name}</span>
      <span class="icon-kind">${hasFilled ? 'Outline + filled' : 'Single style'}</span>
    </button>`;
    })
    .join('');
  const categories = [...new Set(catalog.map((icon) => icon.category))];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>DROIDEX icon library</title>
  <link rel="stylesheet" href="./icons.css">
  <link rel="stylesheet" href="./gallery.css">
  <script src="./gallery.js" defer></script>
</head>
<body data-appearance="filled" data-colors="true">
  <main>
    <header>
      <a class="wordmark" href="#top" id="top">DROIDEX <span>/ ICONS</span></a>
      <a href="#library" class="header-link">Browse the library ↓</a>
    </header>
    <section class="intro" aria-labelledby="intro-title">
      <div class="intro-copy">
        <p class="eyebrow">A small collection, considered.</p>
        <h1 id="intro-title">Small, by design.</h1>
        <p class="subtitle">Curved silhouettes for everyday interfaces.<br>24px grid. React components. Plain SVGs.</p>
      </div>
      <div class="reference-tray">
        ${featured
          .map(
            ({
              name,
              label,
              tone,
            }) => `<button type="button" class="featured-icon inspectable" aria-label="Inspect ${name}">
          <span class="droid-icon-badge" data-droid-icon-tone="${tone}">${drawings(name)}</span>
          <span>${label}</span>
        </button>`,
          )
          .join('')}
      </div>
    </section>
    <div class="controls" aria-label="Preview options">
      <fieldset class="segmented"><legend class="sr-only">Icon appearance</legend>
        <label><input type="radio" name="appearance" value="outline">Outline</label>
        <label><input type="radio" name="appearance" value="filled" checked>Filled</label>
      </fieldset>
      <label class="toggle"><input id="colors" type="checkbox" checked>Color</label>
      <label class="toggle"><input id="shadows" type="checkbox">Soft shadows</label>
      <label class="size-label">Size <select id="size"><option>14</option><option>16</option><option>20</option><option selected>24</option><option>32</option></select><span>px</span></label>
      <label class="theme-label">Canvas <select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
    </div>
    <section class="specimens" aria-label="In-context previews">
      <div class="specimen">
        <h2>Made for chips</h2>
        <div class="chip-row">${chip('Rosette', 'Design skill', 'rose')}${chip('Ghost', 'Code agent', 'orange')}${chip('ConnectedNodes', 'Connected', 'sand')}${chip('Notebook', 'Weekly review', 'violet')}${chip('FileSearch', 'Follow-up', 'green')}</div>
      </div>
      <div class="specimen status-specimen">
        <h2>Quiet, useful status</h2>
        <div class="status-row"><span class="pending">${glyph('CircleDashed', 16)}</span>Pending review</div>
        <div class="status-row"><span data-droid-icon-tone="green">${glyph('CircleCheckFilled', 16)}</span>Checks passed</div>
        <div class="status-row">${glyph('Spinner', 16)}<span>Working <small>75% arc · 1.8s / turn</small></span></div>
      </div>
    </section>
    <section id="library" aria-labelledby="library-title">
      <div class="library-heading"><h2 id="library-title">The library <span id="count">${families.length}</span></h2><p>${catalog.length} exports. Click an icon to copy or download.</p></div>
      <div class="filters">
        <label class="search">${glyph('Search', 16)}<input id="search" type="search" placeholder="Find an icon…" aria-label="Search icons"></label>
        <label class="sr-only" for="category">Category</label>
        <select id="category"><option value="">All categories</option>${categories.map((name) => `<option>${name}</option>`).join('')}</select>
      </div>
      <p class="filter-note">Filled applies to paired icons. Single-style icons keep their original geometry.</p>
      <!-- prettier-ignore -->
      <div class="icon-grid">${cards}</div>
      <p id="empty" hidden>No matching icons. Try another name or category.</p>
    </section>
    <footer><span>DROIDEX icon library · 0.1.0</span><span>Source-available under the repository license.</span></footer>
  </main>
  <dialog id="inspector" aria-labelledby="inspector-title">
    <div class="dialog-heading"><h2 id="inspector-title"></h2><button id="close" type="button" aria-label="Close inspector">${glyph('X', 20)}</button></div>
    <div id="inspector-preview"></div>
    <div class="dialog-actions"><button id="copy-react" type="button">Copy React</button><button id="copy-svg" type="button">Copy SVG</button><a id="download">Download SVG</a></div>
    <label for="code" class="code-label">Usage</label><textarea id="code" readonly spellcheck="false"></textarea>
    <p id="copy-status" role="status" aria-live="polite"></p>
  </dialog>
</body>
</html>
`;
}
