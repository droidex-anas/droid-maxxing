export const VISUALIZE_COMMAND = {
  cmd: '/visualize',
  desc: 'Create an interactive in-chat App',
} as const;

export function isVisualizeCommand(text: string): boolean {
  return /^\/visualize(?:\s|$)/i.test(text.trim());
}

export function responseFormatForPrompt(
  text: string,
  hasAppContext: boolean,
): 'app-create' | 'app-followup' | undefined {
  if (isVisualizeCommand(text)) return 'app-create';
  return hasAppContext ? 'app-followup' : undefined;
}

// Builds the prompt text actually sent to a session from the raw user input plus
// the selected skills and @file mentions. Shared so the optimistic echo dedup
// can reconstruct the same composed string that gets persisted to history.
export function composePrompt(text: string, skillNames: string[], files: string[]): string {
  const parts: string[] = [];
  if (skillNames.length === 1) parts.push(`/${skillNames[0]}${text ? ` ${text}` : ''}`);
  else if (skillNames.length > 1)
    parts.push(`Use these skills: ${skillNames.map((s) => `"${s}"`).join(', ')}.`);
  if (text && skillNames.length !== 1) parts.push(text);
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
