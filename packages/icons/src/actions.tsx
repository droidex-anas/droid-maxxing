import { createIcon } from './Icon.js';
import { Dot } from './Dot.js';

export const X = createIcon(
  'x',
  <>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </>,
);

export const Check = createIcon('check', <path d="m5 12.5 4.5 4.5L19 7" />);

export const Plus = createIcon(
  'plus',
  <>
    <path d="M12 5.5v13" />
    <path d="M5.5 12h13" />
  </>,
);

export const Ellipsis = createIcon(
  'ellipsis',
  <>
    <Dot cx={5.5} cy={12} />
    <Dot cx={12} cy={12} />
    <Dot cx={18.5} cy={12} />
  </>,
);

export const GripVertical = createIcon(
  'grip-vertical',
  <>
    <Dot cx={9.5} cy={6.5} />
    <Dot cx={14.5} cy={6.5} />
    <Dot cx={9.5} cy={12} />
    <Dot cx={14.5} cy={12} />
    <Dot cx={9.5} cy={17.5} />
    <Dot cx={14.5} cy={17.5} />
  </>,
);

// Two stacked rounded squares; the back one peeks out top-left.
export const Copy = createIcon(
  'copy',
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="3" />
    <path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </>,
);

export const Trash = createIcon(
  'trash',
  <>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1" />
    <path d="m6.5 6.5.7 11.7a2.3 2.3 0 0 0 2.3 2.3h5a2.3 2.3 0 0 0 2.3-2.3l.7-11.7" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </>,
);

export const Download = createIcon(
  'download',
  <>
    <path d="M12 4v10.5" />
    <path d="m7.75 10.25 4.25 4.25 4.25-4.25" />
    <path d="M4.5 16.5v1a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-1" />
  </>,
);

export const Upload = createIcon(
  'upload',
  <>
    <path d="M12 14.5V4" />
    <path d="m7.75 8.25 4.25-4.25 4.25 4.25" />
    <path d="M4.5 16.5v1a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-1" />
  </>,
);

export const Search = createIcon(
  'search',
  <>
    <circle cx="11" cy="11" r="6.3" />
    <path d="m15.6 15.6 4.4 4.4" />
  </>,
);

export const Pencil = createIcon(
  'pencil',
  <>
    <path d="m16.05 4.55-9.1 9.1c-.5.5-.8 1-.95 1.65l-.75 3.2c-.15.6.15.9.75.75l3.2-.75c.65-.15 1.15-.45 1.65-.95l9.1-9.1a2.76 2.76 0 0 0-3.9-3.9Z" />
    <path d="m14.5 6.1 3.9 3.9" />
  </>,
);

export const PenLine = createIcon(
  'pen-line',
  <>
    <path d="M13 20.5h7" />
    <path d="m16.3 4.3-9 9c-.45.45-.75.95-.9 1.55l-.6 2.4c-.15.6.15.9.75.75l2.4-.6c.6-.15 1.1-.45 1.55-.9l9-9a2.26 2.26 0 0 0-3.2-3.2Z" />
  </>,
);

export const SquarePen = createIcon(
  'square-pen',
  <>
    <path d="M9.5 4H8C4.8 4 3.5 5.3 3.5 8.5v7c0 3.6 1.4 5 5 5h7c3.2 0 4.5-1.3 4.5-4.5v-1.5" />
    <path d="m16.5 4.3-6.6 6.6c-.45.45-.75.95-.9 1.55l-.6 2.4c-.15.6.15.9.75.75l2.4-.6c.6-.15 1.1-.45 1.55-.9l6.6-6.6a2.26 2.26 0 0 0-3.2-3.2Z" />
  </>,
);

const PIN_HEAD =
  'M14.2 4.2c.75-.85 1.6-.95 2.4-.15l3.35 3.35c.8.8.7 1.65-.15 2.4l-2.5 2.15c-.65.55-1.05 1.3-1.2 2.15l-.45 2.5c-.25 1.4-1.3 1.75-2.3.75L6.65 10.8c-1-1-.65-2.05.75-2.3l2.5-.45c.85-.15 1.6-.55 2.15-1.2Z';

export const Pin = createIcon(
  'pin',
  <>
    <path d={PIN_HEAD} />
    <path d="m9.5 14-5 5" />
  </>,
);

export const PinOff = createIcon(
  'pin-off',
  <>
    <path d={PIN_HEAD} />
    <path d="m9.5 14-5 5" />
    <path d="m4 4 16 16" />
  </>,
);

const ARCHIVE_BOX = (
  <>
    <rect x="3.5" y="4" width="17" height="4.5" rx="2" />
    <path d="M5 8.5v9A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-9" />
  </>
);

export const Archive = createIcon(
  'archive',
  <>
    {ARCHIVE_BOX}
    <path d="M10 13h4" />
  </>,
);

export const ArchiveRestore = createIcon(
  'archive-restore',
  <>
    {ARCHIVE_BOX}
    <path d="M12 18.5V12" />
    <path d="M9.5 14.5 12 12l2.5 2.5" />
  </>,
);

export const Crop = createIcon(
  'crop',
  <>
    <path d="M6.5 3v11a3 3 0 0 0 3 3H21" />
    <path d="M3 6.5h11a3 3 0 0 1 3 3V21" />
  </>,
);

// A dropper: rounded bulb top-right, slim tube, teardrop tip bottom-left.
export const Pipette = createIcon(
  'pipette',
  <>
    <path d="M16.7 3.6a2.75 2.75 0 0 1 3.9 3.9l-1.4 1.4" />
    <path d="m13.8 6.5 4.5 4.5" />
    <path d="M13.1 8.2 5.8 15.5a2.4 2.4 0 0 0 0 3.4v0a2.4 2.4 0 0 0 3.4 0l7.3-7.3" />
  </>,
);

export const Play = createIcon(
  'play',
  <path d="M7 6.5v11c0 1.65 1.1 2.3 2.5 1.45l8.85-5.5c1.35-.85 1.35-2.05 0-2.9L9.5 5.05C8.1 4.2 7 4.85 7 6.5Z" />,
);

export const Square = createIcon('square', <rect x="6" y="6" width="12" height="12" rx="3.5" />);

export const Link = createIcon(
  'link',
  <>
    <path d="M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1-1" />
  </>,
);

export const ExternalLink = createIcon(
  'external-link',
  <>
    <path d="M14 4h6v6" />
    <path d="m20 4-9 9" />
    <path d="M18 13.5v4a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6h4" />
  </>,
);

export const Eye = createIcon(
  'eye',
  <>
    <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </>,
);

export const ListFilter = createIcon(
  'list-filter',
  <>
    <path d="M4 6h16" />
    <path d="M7 12h10" />
    <path d="M10 18h4" />
  </>,
);

export const ListPlus = createIcon(
  'list-plus',
  <>
    <path d="M4 6h12" />
    <path d="M4 12h12" />
    <path d="M4 18h8" />
    <path d="M18 14v6" />
    <path d="M15 17h6" />
  </>,
);

export const ListTodo = createIcon(
  'list-todo',
  <>
    <rect x="3.5" y="4.5" width="5" height="5" rx="1.8" />
    <path d="m4.5 16.5 1.5 1.5 3-3" />
    <path d="M12.5 7h8" />
    <path d="M12.5 17h8" />
  </>,
);

export const WrapText = createIcon(
  'wrap-text',
  <>
    <path d="M4 6h16" />
    <path d="M4 12h11a3 3 0 0 1 0 6h-4" />
    <path d="M13.5 15.5 11 18l2.5 2.5" />
    <path d="M4 18h4" />
  </>,
);

export const AlignLeft = createIcon(
  'align-left',
  <>
    <path d="M4 6h16" />
    <path d="M4 12h11" />
    <path d="M4 18h13" />
  </>,
);

export const SlidersHorizontal = createIcon(
  'sliders-horizontal',
  <>
    <circle cx="6" cy="7" r="2.75" />
    <path d="M13 7h7" />
    <circle cx="6" cy="17" r="2.75" />
    <path d="M13 17h7" />
  </>,
);

export const Settings = createIcon(
  'settings',
  <>
    <path d="M10.45 5.6c.6-1.15 2.5-1.15 3.1 0L14.1 6.65c.3.55.9.9 1.55.85l1.2-.05c1.3-.05 2.25 1.55 1.55 2.65l-.65 1c-.35.55-.35 1.25 0 1.8l.65 1c.7 1.1-.25 2.7-1.55 2.65l-1.2-.05c-.65-.05-1.25.3-1.55.85l-.55 1.05c-.6 1.15-2.5 1.15-3.1 0l-.55-1.05c-.3-.55-.9-.9-1.55-.85l-1.2.05c-1.3.05-2.25-1.55-1.55-2.65l.65-1c.35-.55.35-1.25 0-1.8l-.65-1c-.7-1.1.25-2.7 1.55-2.65l1.2.05c.65.05 1.25-.3 1.55-.85Z" />
    <circle cx="12" cy="12" r="2.75" />
  </>,
);
