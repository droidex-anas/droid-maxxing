export const VISUALIZE_COMMAND = {
  cmd: '/visualize',
  desc: 'Create an interactive App block',
} as const;

export function isVisualizeCommand(text: string): boolean {
  return /^\/visualize(?:\s|$)/i.test(text.trim());
}

function expandVisualizeCommand(text: string): string {
  const match = /^\/visualize(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return text;
  const request = match.at(1)?.trim() ?? '';
  const requestDescription =
    request.length > 0 ? request : 'the most useful view of the current conversation';
  return `Create an interactive visualization for ${requestDescription}.

Return a concise explanation followed by one self-contained fenced \`app\` block. Put inline HTML, CSS, and JavaScript inside that fence. Use SVG or Canvas when useful, make the layout responsive at narrow widths, and add meaningful native interaction where it improves understanding. Use the DROIDEX theme variables --app-background, --app-surface, --app-foreground, --app-muted, --app-border, and --app-accent. Do not use network requests, external libraries, external assets, or nested frames.`;
}

// Builds the prompt text actually sent to a session from the raw user input plus
// the selected skills and @file mentions. Shared so the optimistic echo dedup
// can reconstruct the same composed string that gets persisted to history.
export function composePrompt(text: string, skillNames: string[], files: string[]): string {
  const expandedText = expandVisualizeCommand(text);
  const parts: string[] = [];
  if (skillNames.length === 1)
    parts.push(`/${skillNames[0]}${expandedText ? ` ${expandedText}` : ''}`);
  else if (skillNames.length > 1)
    parts.push(`Use these skills: ${skillNames.map((s) => `"${s}"`).join(', ')}.`);
  if (expandedText && skillNames.length !== 1) parts.push(expandedText);
  let composed = parts.join('\n\n');
  if (files.length) {
    const mentions = files.map((f) => `@${f}`).join(' ');
    composed = composed ? `${composed}\n\n${mentions}` : mentions;
  }
  return composed;
}

export function parseSlashSkillInvocation(
  text: string,
  skills: readonly { name: string }[],
): { skillName: string; prompt: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const skill = skills.find((candidate) => candidate.name.toLowerCase() === match[1].toLowerCase());
  if (!skill) return undefined;
  return { skillName: skill.name, prompt: match.at(2)?.trim() ?? '' };
}
