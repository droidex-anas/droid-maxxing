export const VISUALIZE_COMMAND = {
  cmd: '/visualize',
  desc: 'Create an interactive in-chat App',
} as const;

export function isVisualizeCommand(text: string): boolean {
  return /^\/visualize(?:\s|$)/i.test(text.trim());
}

// Re-attach /visualize for the payload sent to the session. The transcript
// peels it back off so the bubble matches the composer chip.
export function promptTextWithVisualize(text: string, visualizeSelected: boolean): string {
  if (!visualizeSelected || isVisualizeCommand(text)) return text;
  return `${VISUALIZE_COMMAND.cmd} ${text}`.trim();
}

/** A draft that runs as an app command instead of reaching the agent. */
export type SubmitCommand = 'mission' | 'compact';

const COMPACT_COMMANDS = new Set(['/compact', '/compaction', '/compression']);

// A command runs only when the draft holds nothing but the command. Staged
// skills, plugins, and files make the same words a prompt, so `/compact` with a
// file attached asks the agent about compaction rather than compacting the
// session and dropping what was staged for it.
export function submitCommandFor(
  text: string,
  staged: { visualizeSelected: boolean; skillCount: number; fileCount: number },
): SubmitCommand | null {
  if (staged.visualizeSelected || staged.skillCount > 0 || staged.fileCount > 0) return null;
  if (text === '/mission') return 'mission';
  return COMPACT_COMMANDS.has(text) ? 'compact' : null;
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

const RESERVED_SLASH = new Set([
  'visualize',
  'bug',
  'feedback',
  'mission',
  'model',
  'spec',
  'settings',
  ...[...COMPACT_COMMANDS].map((cmd) => cmd.slice(1)),
]);

function afterSlash(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^/${escaped}(?:\\s+|$)([\\s\\S]*)`, 'i').exec(text.trim());
  return match ? match[1] : null;
}

// Inverse of promptTextWithVisualize + composePrompt: chips in, slash text out.
export function promptDisplayParts(
  text: string,
  skills?: readonly string[],
): { text: string; skills: string[]; visualize: boolean } {
  let body = text;
  let visualize = false;
  let names = skills?.length ? [...skills] : [];

  const vis = afterSlash(body, 'visualize');
  if (vis !== null) {
    visualize = true;
    body = vis;
  }

  if (names.length > 0) {
    for (const skill of names) {
      const rest = afterSlash(body, skill);
      if (rest !== null) {
        body = rest;
        break;
      }
    }
  } else {
    const multi = /^Use these skills: (.+)\.\n\n([\s\S]*)$/.exec(body);
    if (multi) {
      names = [...multi[1].matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
      body = multi[2];
    } else {
      const slash = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(body.trim());
      if (slash && !RESERVED_SLASH.has(slash[1].toLowerCase())) {
        names = [slash[1]];
        body = slash[2];
      }
    }
  }

  if (!visualize) {
    const rest = afterSlash(body, 'visualize');
    if (rest !== null) {
      visualize = true;
      body = rest;
    }
  }

  return { text: body, skills: names, visualize };
}

export function promptDisplayText(text: string, skills?: readonly string[]): string {
  const display = promptDisplayParts(text, skills);
  return (
    display.text.replace(/\s+/g, ' ').trim() ||
    (display.visualize ? 'Visualize' : display.skills.join(', '))
  );
}
