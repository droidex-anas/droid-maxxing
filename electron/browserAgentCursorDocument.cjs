const design = require('../shared/browserAgentCursorDesign.json');

const BROWSER_AGENT_CURSOR_DEFAULT_STYLE = 'droidex';
const BROWSER_AGENT_CURSOR_STYLES = Object.freeze(Object.keys(design.styles));
const CURSOR_GLOW_PADDING = 24;

function validateBrowserAgentCursorStyle(value) {
  if (!BROWSER_AGENT_CURSOR_STYLES.includes(value)) {
    throw new Error('Browser agent cursor style must be dark, light, or droidex.');
  }
  return value;
}

function createBrowserAgentCursorDataUrl(value) {
  const presentation = design.styles[validateBrowserAgentCursorStyle(value)];
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
.cursor{position:absolute;inset:${CURSOR_GLOW_PADDING}px;width:calc(100% - ${CURSOR_GLOW_PADDING * 2}px);height:calc(100% - ${CURSOR_GLOW_PADDING * 2}px);filter:${presentation.overlayFilter}}
</style>
</head>
<body>
<svg class="cursor" aria-hidden="true" viewBox="0 0 ${design.viewBoxSize} ${design.viewBoxSize}" xmlns="http://www.w3.org/2000/svg">
  <path d="${design.path}" fill="${presentation.fill}" fill-opacity="${presentation.fillOpacity}" stroke="${presentation.stroke}" stroke-width="${design.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
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
