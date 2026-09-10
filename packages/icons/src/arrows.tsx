import { createIcon } from './Icon.js';

export const ArrowRight = createIcon(
  'arrow-right',
  <>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </>,
);

export const ArrowLeft = createIcon(
  'arrow-left',
  <>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </>,
);

export const ArrowUp = createIcon(
  'arrow-up',
  <>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </>,
);

export const ArrowDown = createIcon(
  'arrow-down',
  <>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </>,
);

export const CircleArrowUp = createIcon(
  'circle-arrow-up',
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 16.5v-9" />
    <path d="m8.5 11 3.5-3.5 3.5 3.5" />
  </>,
);

export const ChevronRight = createIcon('chevron-right', <path d="m9.5 6 6 6-6 6" />);
export const ChevronLeft = createIcon('chevron-left', <path d="m14.5 6-6 6 6 6" />);
export const ChevronDown = createIcon('chevron-down', <path d="m6 9.5 6 6 6-6" />);
export const ChevronUp = createIcon('chevron-up', <path d="m6 14.5 6-6 6 6" />);

export const ChevronsUpDown = createIcon(
  'chevrons-up-down',
  <>
    <path d="m8 9 4-4 4 4" />
    <path d="m8 15 4 4 4-4" />
  </>,
);

export const ChevronsDownUp = createIcon(
  'chevrons-down-up',
  <>
    <path d="m8 5 4 4 4-4" />
    <path d="m8 19 4-4 4 4" />
  </>,
);

export const CornerDownLeft = createIcon(
  'corner-down-left',
  <>
    <path d="M19 5v6a3 3 0 0 1-3 3H5" />
    <path d="m9 10-4 4 4 4" />
  </>,
);

export const Undo = createIcon(
  'undo',
  <>
    <path d="M8 5 4 9l4 4" />
    <path d="M4 9h10a5 5 0 0 1 0 10h-3" />
  </>,
);

export const RotateCcw = createIcon(
  'rotate-ccw',
  <>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9" />
    <path d="M4.5 4.5v4.4h4.4" />
  </>,
);

export const RefreshCw = createIcon(
  'refresh-cw',
  <>
    <path d="M4 12a8 8 0 0 1 8-8 8.7 8.7 0 0 1 6 2.4L20 8.5" />
    <path d="M20 4v4.5h-4.5" />
    <path d="M20 12a8 8 0 0 1-8 8 8.7 8.7 0 0 1-6-2.4L4 15.5" />
    <path d="M4 20v-4.5h4.5" />
  </>,
);

export const FoldVertical = createIcon(
  'fold-vertical',
  <>
    <path d="M12 3v5.5" />
    <path d="M12 15.5V21" />
    <path d="m9 6 3 3 3-3" />
    <path d="m9 18 3-3 3 3" />
    <path d="M4 12h2" />
    <path d="M10 12h4" />
    <path d="M18 12h2" />
  </>,
);

export const Send = createIcon(
  'send',
  <>
    <path d="M18.8 3.8 4.9 9.1c-1.6.6-1.6 1.8-.1 2.4l4.4 1.7c.75.3 1.3.85 1.6 1.6l1.7 4.4c.6 1.5 1.8 1.5 2.4-.1l5.3-13.9c.5-1.3-.1-1.9-1.4-1.4Z" />
    <path d="m10.3 13.7 5.95-5.95" />
  </>,
);
