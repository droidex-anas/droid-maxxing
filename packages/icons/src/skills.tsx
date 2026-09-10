import { createIcon } from './Icon.js';

const ROSETTE =
  'M9.2 5.1c.35-3 5.25-3 5.6 0 2.4-1.8 5.85 1.65 4.05 4.05 3 .35 3 5.25 0 5.6 1.8 2.4-1.65 5.85-4.05 4.05-.35 3-5.25 3-5.6 0-2.4 1.8-5.85-1.65-4.05-4.05-3-.35-3-5.25 0-5.6-1.8-2.4 1.65-5.85 4.05-4.05Z';

export const Rosette = createIcon('rosette', <path d={ROSETTE} />);
export const RosetteFilled = createIcon('rosette-filled', <path d={ROSETTE} fill="currentColor" />);

const HIERARCHY_RAILS = <path d="M12 9v3.5m-6 3v-1a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />;

export const Hierarchy = createIcon(
  'hierarchy',
  <>
    {HIERARCHY_RAILS}
    <rect x="8.5" y="3.5" width="7" height="5.5" rx="2" />
    <rect x="3" y="15.5" width="6" height="5" rx="1.75" />
    <rect x="15" y="15.5" width="6" height="5" rx="1.75" />
  </>,
);

export const HierarchyFilled = createIcon(
  'hierarchy-filled',
  <>
    {HIERARCHY_RAILS}
    <g fill="currentColor">
      <rect x="8.5" y="3.5" width="7" height="5.5" rx="2" />
      <rect x="3" y="15.5" width="6" height="5" rx="1.75" />
      <rect x="15" y="15.5" width="6" height="5" rx="1.75" />
    </g>
  </>,
);

const GHOST =
  'M5 10a7 7 0 0 1 14 0v8.6c0 1.25-1.2 1.9-2.2 1.15l-1.3-1-2 1.2a2.9 2.9 0 0 1-3 0l-2-1-1.3.8c-1 .75-2.2.1-2.2-1.15Z';
const GHOST_EYES = 'M9.5 8.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';

export const Ghost = createIcon(
  'ghost',
  <>
    <path d={GHOST} />
    <path d={GHOST_EYES} fill="currentColor" stroke="none" />
    <path d="M9.75 13.25a2.8 2.8 0 0 0 4.5 0" />
  </>,
);

export const GhostFilled = createIcon(
  'ghost-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d={`${GHOST}${GHOST_EYES}M9.3 12.65a.75.75 0 0 0-.15 1.05 3.55 3.55 0 0 0 5.7 0 .75.75 0 1 0-1.2-.9 2.05 2.05 0 0 1-3.3 0 .75.75 0 0 0-1.05-.15Z`}
  />,
);

const MESSAGE_BUBBLE =
  'M8 4h8c3.25 0 4.5 1.25 4.5 4.5v5c0 3.25-1.25 4.5-4.5 4.5h-.7L13 20.1c-.7.65-1.3.65-2 0L8.7 18H8c-3.25 0-4.5-1.25-4.5-4.5v-5C3.5 5.25 4.75 4 8 4Z';

export const MessageBubble = createIcon(
  'message-bubble',
  <>
    <path d={MESSAGE_BUBBLE} />
    <path d="M8 9h8m-8 4h5" />
  </>,
);

export const MessageBubbleFilled = createIcon(
  'message-bubble-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d={`${MESSAGE_BUBBLE}M8 8.25a.75.75 0 0 0 0 1.5h8a.75.75 0 0 0 0-1.5Zm0 4a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5Z`}
  />,
);

const NODE_RAILS = <path d="m8 12-1.25-4m4.8 4.25 4.2-5m-3.7 8.25 4.2 1" />;
const NODES = (
  <>
    <circle cx="8.5" cy="16" r="4" />
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="18" cy="5.5" r="2" />
    <circle cx="18.5" cy="17" r="2" />
  </>
);

export const ConnectedNodes = createIcon(
  'connected-nodes',
  <>
    {NODE_RAILS}
    {NODES}
  </>,
);

export const ConnectedNodesFilled = createIcon(
  'connected-nodes-filled',
  <>
    {NODE_RAILS}
    <g fill="currentColor">{NODES}</g>
  </>,
);

export const Gauge = createIcon(
  'gauge',
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M7.25 12a4.75 4.75 0 0 1 4.75-4.75m.9 3.85 3.1-3.1" />
    <circle cx="12" cy="12" r="1.25" />
  </>,
);

export const GaugeFilled = createIcon(
  'gauge-filled',
  <path
    fill="currentColor"
    stroke="none"
    fillRule="evenodd"
    d="M12 2.75a9.25 9.25 0 1 1 0 18.5 9.25 9.25 0 0 1 0-18.5Zm0 3.75A5.5 5.5 0 0 0 6.5 12a.75.75 0 0 0 1.5 0 4 4 0 0 1 4-4 .75.75 0 0 0 0-1.5Zm4.53.97a.75.75 0 0 0-1.06 0l-3.04 3.04a2 2 0 1 0 1.06 1.06l3.04-3.04a.75.75 0 0 0 0-1.06Z"
  />,
);
