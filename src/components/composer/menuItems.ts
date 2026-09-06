import { rankMenuCandidates } from '../../lib/composerMenuRanking';
import type { SkillInfo } from '../../types/bridge';
import type { MenuItem, SlashCommand } from '../ComposerMenu';

const SKILL_LIMIT = 40;
const FILE_LIMIT = 50;

export interface ComposerTrigger {
  kind: 'slash' | 'file';
  query: string;
  /** Where the token starts in the draft, so running a row can replace it. */
  start: number;
  end: number;
}

// A `/` or `@` token the caret is still inside opens the menu on what follows it.
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
  const upto = text.slice(0, caret);
  const m = /(^|\s)([/@][^\s]*)$/.exec(upto);
  if (!m) return null;
  const token = m[2];
  return {
    kind: token.startsWith('/') ? 'slash' : 'file',
    query: token.slice(1),
    start: caret - token.length,
    end: caret,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// The rows the open menu offers for what has been typed so far. An empty result
// closes the menu, so a query that matches nothing gets out of the way.
export function menuItemsForTrigger(
  trigger: ComposerTrigger,
  { commands, skills, files }: { commands: SlashCommand[]; skills: SkillInfo[]; files: string[] },
): MenuItem[] {
  const q = trigger.query.toLowerCase();
  if (trigger.kind === 'file') {
    return files
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => {
        const aw = basename(a).toLowerCase().startsWith(q) ? 0 : 1;
        const bw = basename(b).toLowerCase().startsWith(q) ? 0 : 1;
        return aw - bw || a.length - b.length;
      })
      .slice(0, FILE_LIMIT)
      .map<MenuItem>((path) => ({ type: 'file', path }));
  }
  // Commands match on their name alone, as they always have; only skills, whose
  // names are terse, are also reachable through their description.
  const rankedCommands = rankMenuCandidates(q, commands, (c) => ({ name: c.cmd.slice(1) }));
  const rankedSkills = rankMenuCandidates(q, skills, (s) => ({
    name: s.name,
    description: s.description,
  }));
  const commandRows = rankedCommands.items.map<MenuItem>((command) => ({
    type: 'command',
    command,
  }));
  const skillRows = rankedSkills.items
    .slice(0, SKILL_LIMIT)
    .map<MenuItem>((skill) => ({ type: 'skill', skill }));
  // The menu labels its Commands and Skills sections, so the kinds stay grouped
  // and whichever group holds the better match leads. Typing a skill's exact name
  // puts it first instead of behind every command.
  return rankedSkills.bestRank < rankedCommands.bestRank
    ? [...skillRows, ...commandRows]
    : [...commandRows, ...skillRows];
}
