import { createIcon } from './Icon.js';
import { Dot } from './Dot.js';

const RING = <circle cx="12" cy="12" r="8.5" />;

export const Spinner = createIcon('spinner', <path d="M21 12a9 9 0 1 1-9-9" />, 2);

export const AlertTriangle = createIcon(
  'alert-triangle',
  <>
    <path d="M10.3 4.4 3.2 16.8a2 2 0 0 0 1.7 3h14.2a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <Dot cx={12} cy={16.75} />
  </>,
);

export const CircleAlert = createIcon(
  'circle-alert',
  <>
    {RING}
    <path d="M12 8v4.5" />
    <Dot cx={12} cy={16} />
  </>,
);

export const CircleCheck = createIcon(
  'circle-check',
  <>
    {RING}
    <path d="m8.5 12.2 2.4 2.4L15.5 10" />
  </>,
);

export const MessageCirclePlus = createIcon(
  'message-circle-plus',
  <>
    <path d="M12 3.5c-5 0-8.5 3.45-8.5 8.25 0 1.6.4 3.05 1.15 4.3l-.9 3.1c-.15.5.3.9.8.75l3.1-.85c1.3.65 2.75.95 4.35.95 5 0 8.5-3.45 8.5-8.25S17 3.5 12 3.5Z" />
    <path d="M12 8.25v7" />
    <path d="M8.5 11.75h7" />
  </>,
);

export const CirclePause = createIcon(
  'circle-pause',
  <>
    {RING}
    <path d="M10 9.5v5" />
    <path d="M14 9.5v5" />
  </>,
);

export const CircleUser = createIcon(
  'circle-user',
  <>
    {RING}
    <circle cx="12" cy="10" r="3" />
    <path d="M6.2 18.2a6.5 6.5 0 0 1 11.6 0" />
  </>,
);

export const Bell = createIcon(
  'bell',
  <>
    <path d="M6.75 9.5a5.25 5.25 0 0 1 10.5 0v2.55c0 .9.25 1.6.8 2.4l.6.85c.65.95.2 1.7-.95 1.7H6.3c-1.15 0-1.6-.75-.95-1.7l.6-.85c.55-.8.8-1.5.8-2.4Z" />
    <path d="M9.5 19a2.65 2.65 0 0 0 5 0" />
  </>,
);

export const Clock = createIcon(
  'clock',
  <>
    {RING}
    <path d="M12 7.5V12l3 2.5" />
  </>,
);

export const History = createIcon(
  'history',
  <>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9" />
    <path d="M4.5 4.5v4.4h4.4" />
    <path d="M12 8v4l2.5 1.5" />
  </>,
);

export const Activity = createIcon('activity', <path d="M3 12h3.5L9.5 5.5l5 13 2-6.5H21" />);

// A plump bolt: the same zigzag silhouette, but every tip is a soft arc.
export const Zap = createIcon(
  'zap',
  <path d="M13.3 3.5 5.9 13.4a.55.55 0 0 0 .45.85h4.75l-1.35 5.3a.55.55 0 0 0 .95.45l7.4-9.9a.55.55 0 0 0-.45-.85h-4.75l1.35-5.3a.55.55 0 0 0-.95-.45Z" />,
);

// Capsule body, stubby angled legs, hooked antennae: a friendly beetle.
export const Bug = createIcon(
  'bug',
  <>
    <rect x="8" y="8.5" width="8" height="11" rx="4" />
    <path d="M12 11v8.5" />
    <path d="M8 11.5H5" />
    <path d="M16 11.5h3" />
    <path d="m8.4 15-2.6 1.6" />
    <path d="m15.6 15 2.6 1.6" />
    <path d="m9 18.3-1.7 2.2" />
    <path d="m15 18.3 1.7 2.2" />
    <path d="m9.8 8.3-1.5-2.8" />
    <path d="m14.2 8.3 1.5-2.8" />
  </>,
);

export const ShieldCheck = createIcon(
  'shield-check',
  <>
    <path d="M10.6 4.1 6.4 5.8c-.85.35-1.2.95-1.2 1.9v3.8c0 3.9 2.4 6.9 5.5 8.4.9.45 1.7.45 2.6 0 3.1-1.5 5.5-4.5 5.5-8.4V7.7c0-.95-.35-1.55-1.2-1.9l-4.2-1.7c-.95-.4-1.85-.4-2.8 0Z" />
    <path d="m9 11.8 2.2 2.2 4-4.2" />
  </>,
);

export const ThumbsUp = createIcon(
  'thumbs-up',
  <path d="M7.5 10.5h-2a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h11a2.3 2.3 0 0 0 2.3-1.8l1.3-6.5A2.3 2.3 0 0 0 17.8 9h-4.3l.8-4.1a1.9 1.9 0 0 0-3.5-1.1L7.5 10.5V20" />,
);

export const ThumbsDown = createIcon(
  'thumbs-down',
  <path d="M7.5 13.5h-2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11a2.3 2.3 0 0 1 2.3 1.8l1.3 6.5A2.3 2.3 0 0 1 17.8 15h-4.3l.8 4.1a1.9 1.9 0 0 1-3.5 1.1L7.5 13.5V4" />,
);

export const KeyRound = createIcon(
  'key-round',
  <>
    <circle cx="8.5" cy="15.5" r="4.5" />
    <path d="M11.7 12.3 20.5 3.5" />
    <path d="m16.5 7.5 2.5 2.5" />
  </>,
);

export const Hash = createIcon(
  'hash',
  <>
    <path d="M9.5 4 8 20" />
    <path d="M16 4l-1.5 16" />
    <path d="M4.5 9h16" />
    <path d="M3.5 15h16" />
  </>,
);

export const Sun = createIcon(
  'sun',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2" />
    <path d="M12 19v2" />
    <path d="M3 12h2" />
    <path d="M19 12h2" />
    <path d="m5.6 5.6 1.4 1.4" />
    <path d="m17 17 1.4 1.4" />
    <path d="m5.6 18.4 1.4-1.4" />
    <path d="m17 7 1.4-1.4" />
  </>,
);

export const Moon = createIcon(
  'moon',
  <path d="M12 3.5a6.5 6.5 0 0 0 8.5 8.5A8.5 8.5 0 1 1 12 3.5Z" />,
);

export const Globe = createIcon(
  'globe',
  <>
    {RING}
    <ellipse cx="12" cy="12" rx="4.2" ry="8.5" />
    <path d="M3.5 12h17" />
  </>,
);

export const MessageSquareText = createIcon(
  'message-square-text',
  <>
    <path d="M8.5 4h7c3.5 0 5 1.5 5 5v4c0 3.5-1.5 5-5 5H10l-4.2 2.1c-.65.3-1.05.05-.95-.65l.3-3.25C4 15.35 3.5 14.15 3.5 12V9c0-3.5 1.5-5 5-5Z" />
    <path d="M8 9h8" />
    <path d="M8 13h5" />
  </>,
);

export const ImageOff = createIcon(
  'image-off',
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="9.5" r="1.5" />
    <path d="m3.5 17 4.5-4.5a1 1 0 0 1 1.4 0l2.1 2.1" />
    <path d="m4 4 16 16" />
  </>,
);

export const MousePointer = createIcon(
  'mouse-pointer',
  <path d="M5.2 4.6a.5.5 0 0 1 .6-.6L19 10.2a.5.5 0 0 1-.1.9l-5.5 1.5a1 1 0 0 0-.7.7L11.1 18.9a.5.5 0 0 1-.9.1Z" />,
);

export const MousePointerSquareDashed = createIcon(
  'mouse-pointer-square-dashed',
  <>
    <path d="M8.5 4h-2A2.5 2.5 0 0 0 4 6.5v2" />
    <path d="M4 12.5v2A2.5 2.5 0 0 0 6.5 17h2" />
    <path d="M12.5 4h2A2.5 2.5 0 0 1 17 6.5v2" />
    <path d="M11.8 11.8a.4.4 0 0 1 .5-.5l8 3.2a.4.4 0 0 1 0 .8l-3.3 1.1-1.1 3.3a.4.4 0 0 1-.8 0Z" />
  </>,
);

export const CircleDashed = createIcon(
  'circle-dashed',
  <circle cx="12" cy="12" r="8.5" pathLength="60" strokeDasharray="6 4" />,
);

export const CircleCheckFilled = createIcon(
  'circle-check-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d="M12 2.75a9.25 9.25 0 1 1 0 18.5 9.25 9.25 0 0 1 0-18.5Zm4.04 6.71a.75.75 0 0 0-1.08 0l-4.06 4.06-1.87-1.85a.75.75 0 0 0-1.06 1.06l2.4 2.37a.75.75 0 0 0 1.06 0l4.6-4.58a.75.75 0 0 0 .01-1.06Z"
  />,
);

export const CirclePlay = createIcon(
  'circle-play',
  <>
    {RING}
    <path d="m10.25 8.5 5 3.05c.35.2.35.7 0 .9l-5 3.05c-.35.2-.75-.05-.75-.45v-6.1c0-.4.4-.65.75-.45Z" />
  </>,
);

export const CirclePlayFilled = createIcon(
  'circle-play-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d="M12 2.75a9.25 9.25 0 1 1 0 18.5 9.25 9.25 0 0 1 0-18.5Zm-1.4 5.4c-.7-.45-1.6.05-1.6.9v5.9c0 .85.9 1.35 1.6.9l4.9-2.95a1.05 1.05 0 0 0 0-1.8Z"
  />,
);

const CLOUD =
  'M7.25 18.5a4.25 4.25 0 0 1-.55-8.46 5.65 5.65 0 0 1 11.1-.75 4.65 4.65 0 0 1-.05 9.21Z';

export const Cloud = createIcon('cloud', <path d={CLOUD} />);

export const CloudFilled = createIcon('cloud-filled', <path d={CLOUD} fill="currentColor" />);

export const BellFilled = createIcon(
  'bell-filled',
  <>
    <path
      fill="currentColor"
      d="M6.75 9.5a5.25 5.25 0 0 1 10.5 0v2.55c0 .9.25 1.6.8 2.4l.6.85c.65.95.2 1.7-.95 1.7H6.3c-1.15 0-1.6-.75-.95-1.7l.6-.85c.55-.8.8-1.5.8-2.4Z"
    />
    <path d="M9.5 19a2.65 2.65 0 0 0 5 0" />
  </>,
);

export const AlertTriangleFilled = createIcon(
  'alert-triangle-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d="M9.65 4.03 2.55 16.43a2.75 2.75 0 0 0 2.35 4.12h14.2a2.75 2.75 0 0 0 2.35-4.12l-7.1-12.4a2.75 2.75 0 0 0-4.7 0ZM12 8.75a.75.75 0 0 0-.75.75v4a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75Zm0 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
  />,
);
