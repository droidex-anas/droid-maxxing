export const APP_PROMPT_HEADER = 'DROIDEX App request:';
const APP_GUIDANCE_HEADER = 'Private generation guidance:';

const APP_CREATION_GUIDANCE = [
  'Build the most useful interactive in-chat App for this request. Choose the interface that best explains or operates on the subject; it may be a chart, diagram, timeline, calculator, simulator, comparison, explorable explanation, dashboard, or another focused interactive tool.',
  '',
  'Return a concise explanation followed by one self-contained fenced `app` block. Put inline HTML, CSS, and JavaScript inside that fence. Use SVG or Canvas when useful and add meaningful native interaction where it improves understanding.',
].join('\n');

const APP_FOLLOWUP_GUIDANCE = [
  'This chat already contains an interactive App. Treat this request as a conversational follow-up with access to the existing App source in the conversation.',
  '',
  'If the user is asking to fix, revise, extend, or restyle that App, return a complete revised fenced `app` block that replaces it, preceded by a concise explanation. Include all inline HTML, CSS, and JavaScript needed to run the revision. Otherwise respond normally and do not force or emit an App block.',
].join('\n');

const APP_GUIDANCE = [
  '',
  'The DROIDEX host owns the transparent chat canvas. Begin with one `<main data-droidex-app-root>` at full width with no outer max-width, page padding, border, radius, or shadow. Mark the primary chart or content region with `data-droidex-app-canvas`; keep that region transparent and unframed. Use surfaces only for compact controls, grouped data, or individual stat tiles. Let content height grow naturally without nested scrolling, and adapt fluidly at narrow widths.',
  '',
  'Choose freely among bar, line, area, scatter, bubble, histogram, box, heatmap, network, timeline, and other suitable views. Combine coordinated mixed views when they reveal more than one chart alone, while keeping the result focused. Support illustrations, annotated processes, infographics, diagrams, and responsive wireframes when those communicate the idea better than data marks.',
  '',
  'For educational or analytical Apps, coordinate the visual, inspector, controls, and explanation so one selection updates every relevant part. Make important data marks inspectable by hover, click, touch, and keyboard where practical. Reserve enough responsive space for clear axes and legends. Never clip axis titles, tick labels, legends, or annotations. On narrow widths, stack supporting panels below the primary visual and preserve readable targets and labels.',
  '',
  "Use responsive SVG for charts, diagrams, and illustrations; Canvas for dense or animated plots; and semantic HTML/CSS for controls, calculators, and wireframes. Build standard charts directly with SVG or Canvas. Give charts useful scales, labels, legends, hover or focus details, and data-driven controls such as filters, toggles, sliders, or selection only when they improve understanding. Use a coherent, high-contrast, color-blind-safe palette and never rely on color alone; the App may define its own local series colors and offer palette or series-color controls when color choice is genuinely useful. For real local LaTeX, put TeX in an element's `data-latex` attribute (add `data-display` for display math), or call `window.droidex.renderMath(elementOrSelector, latex, { displayMode: true })` when values change. Do not hand-build math notation with CSS.",
  '',
  'Use the DROIDEX theme variables --app-background, --app-surface, --app-foreground, --app-muted, --app-border, and --app-accent. Do not use network requests, external libraries, external assets, or nested frames.',
].join('\n');

export function formatAppPrompt(request: string): string {
  const guidance = /^\/visualize(?:\s|$)/i.test(request.trim())
    ? APP_CREATION_GUIDANCE
    : APP_FOLLOWUP_GUIDANCE;
  return [APP_PROMPT_HEADER, request.trim(), '', APP_GUIDANCE_HEADER, guidance, APP_GUIDANCE].join(
    '\n',
  );
}

export function appPromptDisplayFromText(text: string): string | null {
  if (!text.startsWith(APP_PROMPT_HEADER)) return null;
  const guidanceIndex = text.lastIndexOf(`\n\n${APP_GUIDANCE_HEADER}`);
  const requestEnd = guidanceIndex >= 0 ? guidanceIndex : text.length;
  return text.slice(APP_PROMPT_HEADER.length, requestEnd).trim();
}
