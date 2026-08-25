import assert from 'node:assert/strict';
import test from 'node:test';
import { composerTrigger, menuItemsForTrigger } from './menuItems';
import type { SlashCommand } from '../ComposerMenu';
import type { SkillInfo } from '../../types/bridge';

const commands: SlashCommand[] = [
  { cmd: '/compact', desc: 'Compact current session', run: () => undefined },
  { cmd: '/model', desc: 'Open model selector', run: () => undefined },
  { cmd: '/review', desc: 'Review the working tree', replacement: '/review ' },
];

const skill = (name: string, description?: string): SkillInfo => ({
  name,
  description,
  location: 'personal',
  filePath: `/skills/${name}/SKILL.md`,
});

const labels = (items: ReturnType<typeof menuItemsForTrigger>) =>
  items.map((item) => {
    switch (item.type) {
      case 'command':
        return item.command.cmd;
      case 'skill':
        return item.skill.name;
      case 'file':
        return item.path;
    }
  });

const rowsFor = (text: string, skills: SkillInfo[] = [], files: string[] = []) => {
  const trigger = composerTrigger(text, text.length);
  assert.ok(trigger, `expected a trigger in ${JSON.stringify(text)}`);
  return labels(menuItemsForTrigger(trigger, { commands, skills, files }));
};

test('a slash token opens the menu on what follows it', () => {
  assert.deepEqual(composerTrigger('/rev', 4), {
    kind: 'slash',
    query: 'rev',
    start: 0,
    end: 4,
  });
  assert.deepEqual(composerTrigger('fix the bug @src/ma', 19), {
    kind: 'file',
    query: 'src/ma',
    start: 12,
    end: 19,
  });
  // Only the token the caret is inside opens a menu.
  assert.equal(composerTrigger('/review the diff', 16), null);
  assert.equal(composerTrigger('an email@example.com', 20), null);
});

test('the group holding the better match leads, and each group stays ranked', () => {
  const skills = [
    skill('roast', 'Review code and roast it'),
    skill('review', 'Review code changes'),
  ];
  // Named exactly by both kinds, commands keep the lead they have always had,
  // and the skill named for the query leads the ones that only mention it.
  assert.deepEqual(rowsFor('/review', skills), ['/review', 'review', 'roast']);
  // A skill named exactly for the query leads a command the query only prefixes.
  assert.deepEqual(rowsFor('/mod', [skill('mod', 'Modify a file')]), ['mod', '/model']);
  // Commands match on their name alone, so a description mentioning the query
  // does not put a command in the list.
  assert.deepEqual(rowsFor('/compact', skills), ['/compact']);
});

test('a query that matches nothing offers no rows, which closes the menu', () => {
  assert.deepEqual(rowsFor('/zzz', [skill('review')]), []);
});

test('file rows lead with a matching name and stay within the row cap', () => {
  const files = ['src/lib/other/main.ts', 'src/main.ts', 'docs/mainframe.md'];
  assert.deepEqual(rowsFor('@main', [], files), [
    'src/main.ts',
    'docs/mainframe.md',
    'src/lib/other/main.ts',
  ]);
  const many = Array.from({ length: 80 }, (_, i) => `src/file${String(i)}.ts`);
  assert.equal(rowsFor('@file', [], many).length, 50);
});

test('skill rows stay within the row cap', () => {
  const many = Array.from({ length: 60 }, (_, i) => skill(`skill-${String(i)}`));
  const rows = rowsFor('/skill-', many);
  assert.equal(rows.filter((label) => label.startsWith('skill-')).length, 40);
});
