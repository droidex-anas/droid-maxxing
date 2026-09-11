// macOS draws its traffic lights inside the web contents (titleBarStyle
// hiddenInset in electron/main.cjs), so top-row chrome starts past them; every
// other platform keeps a native title bar outside the window.
const macTitleBar = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac OS X');

export const WINDOW_CONTROLS_INSET_PX = macTitleBar ? 92 : 8;
