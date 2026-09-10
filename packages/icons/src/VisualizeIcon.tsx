import { createIcon } from './Icon.js';

// The existing brand mark keeps its own palette; the other icons inherit color.
export const VisualizeIcon = createIcon(
  'visualize',
  <g stroke="none">
    <rect width="24" height="24" rx="7" fill="#3E0B4D" />
    <rect x="5.8" y="13" width="3.6" height="5.4" rx="1.8" fill="#D946EF" />
    <rect x="10.2" y="9.4" width="3.6" height="9" rx="1.8" fill="#D946EF" />
    <rect x="14.6" y="5.8" width="3.6" height="12.6" rx="1.8" fill="#D946EF" />
  </g>,
);
