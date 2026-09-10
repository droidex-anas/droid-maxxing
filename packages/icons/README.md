# DROIDEX icons

Curved 24px icons for compact interfaces. React 19 components, plain SVG files,
outline/filled pairs, and optional colors, badges, chips, and animation.
No Lucide dependency, app runtime, or Tailwind requirement.

## Preview and build

Use Node.js 22. From the repository root:

```sh
npm ci
npm --prefix packages/icons run test
npm --prefix packages/icons run dev
```

Open <http://127.0.0.1:5198>. The gallery supports search, categories, size,
outline/filled, neutral/color, shadows, light/dark canvas, copy, and SVG download.
It also opens directly from `gallery/index.html`, without a server. If clipboard
access is unavailable, the inspector selects the code for manual copying.

```sh
npm --prefix packages/icons run build     # JS, declarations, SVGs, gallery
npm --prefix packages/icons run typecheck
npm --prefix packages/icons run lint
```

The repository's locked toolchain builds this package. Install dependencies at
the repository root, not inside `packages/icons`. TypeScript emits declarations;
Vite emits ESM with tree-shaking annotations so unused glyphs can be omitted.

## Use in another project

This package is **not published to npm**. For your own projects or uses separately
authorized by the copyright holder, build a local tarball:

```sh
cd /path/to/droid-maxxing/packages/icons
npm pack

cd /path/to/your-app
npm install /path/to/droid-maxxing/packages/icons/droidex-icons-0.1.0.tgz
```

The tarball contains compiled ESM, TypeScript declarations, CSS and SVGs.
Installing the repository's Git URL does not install this subdirectory package.
React 19 is a peer dependency. The package is marked private to prevent
accidental registry publication.

```tsx
import { Copy, Rosette, RosetteFilled, CircleCheckFilled } from '@droidex/icons';

<button aria-label="Copy message">
  <Copy size={16} />
</button>;

<Rosette size={20} />;
<RosetteFilled size={20} color="var(--droid-accent)" />;
<CircleCheckFilled size={16} aria-label="Checks passed" />;
```

Icons inherit `currentColor`. Standard SVG props work, including `className`,
`style`, `color`, `strokeWidth`, and `aria-labelledby`. The default size is 24px;
CSS width/height overrides it. Icons are decorative unless labelled. Label the
button rather than its icon when the icon sits inside a control.

Filled variants have their own geometry. Detail cutouts are transparent, not
painted with a background color. Do not use `fill="currentColor"` to turn an
outline icon into a filled one.

## Optional color, badge and chip styles

```tsx
import { GhostFilled, Notebook, RosetteFilled } from '@droidex/icons';
import '@droidex/icons/styles.css';

<span className="droid-icon-badge" data-droid-icon-tone="orange" data-droid-icon-shadow="true">
  <GhostFilled size={22} />
</span>;

<span className="droid-icon-chip">
  <RosetteFilled size={16} data-droid-icon-tone="rose" />
  Design skill
</span>;

<span className="droid-icon-chip">
  <Notebook size={16} />
  Weekly review
</span>;
```

Omit the tone attribute for neutral icons. Available tones: `rose`, `green`,
`orange`, `blue`, `sand`, `violet`, `amber`. Override `--droid-icon-rose`, etc.
with your theme tokens. Set `--droid-icon-badge-size` to change the 36px badge.
These classes only style the elements you opt into; they do not theme the app.
The existing `VisualizeIcon` brand mark is the one fixed-palette exception.

## Status and loading

```tsx
import { CircleDashed, CircleCheckFilled, Spinner } from '@droidex/icons';
import '@droidex/icons/styles.css';

<CircleDashed size={16} aria-label="Pending review" />;
<CircleCheckFilled size={16} aria-label="Complete" />;
<Spinner size={14} className="droid-icon-spin" aria-label="Working" />;
```

The pending ring is static. The spinner keeps a 75% arc, 2px stroke on the 24px
grid, and 1.8 seconds per turn. Animation is opt-in and respects reduced motion.
Sizes and colors remain the caller's choice.

## SVG and catalog

Every component has a corresponding file in [`svg/`](./svg), using kebab-case:
`RosetteFilled` → `svg/rosette-filled.svg`. Copy inline SVG markup to retain
CSS `currentColor` inheritance. An SVG loaded through `<img>` cannot inherit
the surrounding page's color; set a color inside the file in that case.
The raw SVG spinner is static.

Reference-inspired pairs include Rosette, Hierarchy, Ghost, MessageBubble,
ConnectedNodes, Gauge, AlertTriangle, Book, Books, Notebook, FileSearch, Cloud,
CirclePlay, Bell, and CircleCheck. Single-style glyphs such as Spinner,
CircleDashed and arrows retain their original geometry in filled preview mode.

The gallery and SVGs are generated from `src/`. Edit the source, then rebuild.
Gallery layout and controls live in `gallery/gallery.css` and `gallery/gallery.js`;
its HTML renderer and catalog live in `tools/`.

## License

The repository's [DROIDEX Proprietary Source-Available License](./LICENSE)
applies. Source availability does **not** grant third-party reuse, production,
hosting, or redistribution rights. Those uses require the copyright holder's
permission. This branch does not change the license.
