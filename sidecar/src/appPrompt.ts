export const APP_PROMPT_HEADER = 'DROIDEX App request:';
const APP_GUIDANCE_HEADER = 'Private generation guidance:';

const APP_GUIDANCE = [
  'Build the most useful interactive in-chat App for this request. Choose the interface that best explains or operates on the subject; it may be a chart, diagram, timeline, calculator, simulator, comparison, explorable explanation, dashboard, or another focused interactive tool.',
  '',
  'Return a concise explanation followed by one self-contained fenced `app` block. Put inline HTML, CSS, and JavaScript inside that fence. Use SVG or Canvas when useful and add meaningful native interaction where it improves understanding.',
  '',
  'The App renders directly on a transparent chat canvas. Do not draw a full-page background, browser frame, or card around the entire App. Use surfaces only to group controls or data, let content height grow naturally without nested scrolling, and adapt fluidly at narrow widths.',
  '',
  'Use the DROIDEX theme variables --app-background, --app-surface, --app-foreground, --app-muted, --app-border, and --app-accent. Do not use network requests, external libraries, external assets, or nested frames.',
].join('\n');

export function formatAppPrompt(request: string): string {
  return [APP_PROMPT_HEADER, request.trim(), '', APP_GUIDANCE_HEADER, APP_GUIDANCE].join('\n');
}

export function appPromptDisplayFromText(text: string): string | null {
  if (!text.startsWith(APP_PROMPT_HEADER)) return null;
  const guidanceIndex = text.lastIndexOf(`\n\n${APP_GUIDANCE_HEADER}`);
  const requestEnd = guidanceIndex >= 0 ? guidanceIndex : text.length;
  return text.slice(APP_PROMPT_HEADER.length, requestEnd).trim();
}
