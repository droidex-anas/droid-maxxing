const BROWSER_AGENT_CURSOR_DEFAULT_STYLE = 'droidex';
const BROWSER_AGENT_CURSOR_STYLES = Object.freeze(['dark', 'light', 'droidex']);
const CURSOR_GLOW_PADDING = 24;
const CURSOR_PRESENTATIONS = Object.freeze({
  dark: Object.freeze({
    fill: '#111111',
    fillOpacity: '1',
    stroke: '#ffffff',
    filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.5))',
  }),
  light: Object.freeze({
    fill: '#ffffff',
    fillOpacity: '1',
    stroke: '#3b3b3b',
    filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.5))',
  }),
  droidex: Object.freeze({
    fill: '#303743',
    fillOpacity: '1',
    stroke: '#dce1eb',
    filter: 'drop-shadow(0 0 5px rgba(80,139,255,.75)) drop-shadow(0 0 12px rgba(80,139,255,.35))',
  }),
});

function validateBrowserAgentCursorStyle(value) {
  if (!BROWSER_AGENT_CURSOR_STYLES.includes(value)) {
    throw new Error('Browser agent cursor style must be dark, light, or droidex.');
  }
  return value;
}

function createBrowserAgentCursorDataUrl(value) {
  const style = validateBrowserAgentCursorStyle(value);
  const presentation = CURSOR_PRESENTATIONS[style];
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
.cursor{position:absolute;inset:${CURSOR_GLOW_PADDING}px;width:calc(100% - ${CURSOR_GLOW_PADDING * 2}px);height:calc(100% - ${CURSOR_GLOW_PADDING * 2}px);filter:${presentation.filter}}
</style>
</head>
<body>
<svg class="cursor" aria-hidden="true" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <path d="M7.01 3.99 Q6.2 3.4 6.2 4.4 L6.2 23.4 Q6.2 26 8 27.8 L8.1 27.9 Q9.8 29.6 11.6 28.01 L15.3 24.73 Q16.8 23.4 18.8 23.3 L22.8 23.11 Q25 23 25.62 20.89 L25.7 20.6 Q26.4 18.2 24.3 16.66 Z" fill="${presentation.fill}" fill-opacity="${presentation.fillOpacity}" stroke="${presentation.stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_STYLES,
  CURSOR_GLOW_PADDING,
  createBrowserAgentCursorDataUrl,
  validateBrowserAgentCursorStyle,
};
