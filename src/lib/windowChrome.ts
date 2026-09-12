import { isEmbedded } from './embed';

// macOS draws its traffic lights inside the web contents (titleBarStyle
// hiddenInset in electron/main.cjs), so top-row chrome starts past them; every
// other platform keeps a native title bar outside the window.
const macTitleBar =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac OS X') && !isEmbedded();

export const WINDOW_CONTROLS_INSET_PX = macTitleBar ? 92 : 8;

// The floating sidebar toggle (a 16px icon in a 6px-padded button) sits in the
// top row beside the window controls while the sidebar is collapsed.
const SIDEBAR_TOGGLE_PX = 28;
// Gutter the top rows keep between that chrome and their own first element.
const TOP_ROW_GUTTER_PX = 16;

// Where a view's top row may start once the collapsed sidebar puts the window
// controls and the sidebar toggle inside it.
export const WINDOW_CONTROLS_LEAD_PX =
  WINDOW_CONTROLS_INSET_PX + SIDEBAR_TOGGLE_PX + TOP_ROW_GUTTER_PX;
