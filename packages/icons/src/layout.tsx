import { createIcon } from './Icon.js';
import { Dot } from './Dot.js';

const FRAME = (
  <path d="M8 4h8c3.6 0 5 1.4 5 5v6c0 3.6-1.4 5-5 5H8c-3.6 0-5-1.4-5-5V9c0-3.6 1.4-5 5-5Z" />
);

export const PanelLeft = createIcon(
  'panel-left',
  <>
    {FRAME}
    <path d="M8.5 4v16" />
  </>,
);

export const PanelRight = createIcon(
  'panel-right',
  <>
    {FRAME}
    <path d="M15.5 4v16" />
  </>,
);

export const PanelBottom = createIcon(
  'panel-bottom',
  <>
    {FRAME}
    <path d="M8.5 15.5h7" />
  </>,
);

export const Columns = createIcon(
  'columns',
  <>
    {FRAME}
    <path d="M12 4v16" />
  </>,
);

export const Maximize = createIcon(
  'maximize',
  <>
    <path d="M14 4h6v6" />
    <path d="m20 4-6 6" />
    <path d="M10 20H4v-6" />
    <path d="m4 20 6-6" />
  </>,
);

export const Minimize = createIcon(
  'minimize',
  <>
    <path d="m20 4-6 6" />
    <path d="M14 4.5V10h5.5" />
    <path d="m4 20 6-6" />
    <path d="M10 19.5V14H4.5" />
  </>,
);

export const LayoutTemplate = createIcon(
  'layout-template',
  <>
    <rect x="3" y="4" width="18" height="6" rx="2.5" />
    <rect x="3" y="14" width="8" height="6" rx="2.5" />
    <rect x="15" y="14" width="6" height="6" rx="2.5" />
  </>,
);

export const Monitor = createIcon(
  'monitor',
  <>
    <rect x="3" y="4" width="18" height="12.5" rx="3" />
    <path d="M12 16.5V20" />
    <path d="M8 20h8" />
  </>,
);

export const Terminal = createIcon(
  'terminal',
  <>
    <path d="m5 7 5 5-5 5" />
    <path d="M12.5 17H19" />
  </>,
);

export const SquareTerminal = createIcon(
  'square-terminal',
  <>
    {FRAME}
    <path d="m8 9.5 3 3-3 3" />
    <path d="M12.5 15.5h3.5" />
  </>,
);

export const Server = createIcon(
  'server',
  <>
    <rect x="3" y="4" width="18" height="6.5" rx="2.5" />
    <rect x="3" y="13.5" width="18" height="6.5" rx="2.5" />
    <Dot cx={7} cy={7.25} />
    <Dot cx={7} cy={16.75} />
  </>,
);

export const Blocks = createIcon(
  'blocks',
  <>
    <rect x="14" y="3" width="7" height="7" rx="2.5" />
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H10v4.5h4.5v8a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 18.5Z" />
  </>,
);

export const Boxes = createIcon(
  'boxes',
  <>
    <path d="m8 5.5 4-2 4 2v4l-4 2-4-2Z" />
    <path d="m8 5.5 4 2 4-2" />
    <path d="M12 7.5v4" />
    <path d="m3.5 14.5 4-2 4 2v4l-4 2-4-2Z" />
    <path d="m3.5 14.5 4 2 4-2" />
    <path d="M7.5 16.5v4" />
    <path d="m12.5 14.5 4-2 4 2v4l-4 2-4-2Z" />
    <path d="m12.5 14.5 4 2 4-2" />
    <path d="M16.5 16.5v4" />
  </>,
);
