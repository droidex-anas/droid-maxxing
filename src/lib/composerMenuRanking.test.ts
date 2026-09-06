import assert from 'node:assert/strict';
import test from 'node:test';
import { menuMatchRank, rankMenuCandidates } from './composerMenuRanking';

interface Skill {
  name: string;
  description?: string;
}

const identity = (skill: Skill) => skill;

const names = (items: Skill[]) => items.map((item) => item.name);

test('an exactly named skill leads results that only mention the query', () => {
  const skills: Skill[] = [
    { name: 'autoresearch', description: 'Research a topic and review the sources' },
    { name: 'create-pr', description: 'Open a pull request for review' },
    { name: 'review', description: 'Review code changes' },
    { name: 'security-review', description: 'Audit a repository' },
  ];
  const ranked = rankMenuCandidates('review', skills, identity);
  assert.deepEqual(names(ranked.items), ['review', 'security-review', 'create-pr', 'autoresearch']);
  assert.equal(ranked.bestRank, 0);
});

test('a name prefix outranks a name substring, which outranks a description hit', () => {
  const skills: Skill[] = [
    { name: 'zzz', description: 'talks about commit' },
    { name: 'pre-commit-hooks', description: 'unrelated' },
    { name: 'commit-security-scan', description: 'unrelated' },
  ];
  assert.deepEqual(names(rankMenuCandidates('commit', skills, identity).items), [
    'commit-security-scan',
    'pre-commit-hooks',
    'zzz',
  ]);
});

test('candidates that match nothing are dropped', () => {
  const skills: Skill[] = [{ name: 'review' }, { name: 'deploy', description: 'ship it' }];
  assert.deepEqual(names(rankMenuCandidates('review', skills, identity).items), ['review']);
});

test('an empty query keeps every candidate in catalog order', () => {
  const skills: Skill[] = [{ name: 'visualize' }, { name: 'bug' }, { name: 'model' }];
  const ranked = rankMenuCandidates('', skills, identity);
  assert.deepEqual(names(ranked.items), ['visualize', 'bug', 'model']);
  assert.equal(ranked.bestRank, 3);
});

test('bestRank lets the caller decide which group leads', () => {
  const commands: Skill[] = [{ name: 'settings', description: 'review your preferences' }];
  const skills: Skill[] = [{ name: 'review' }];
  assert.ok(
    rankMenuCandidates('review', skills, identity).bestRank <
      rankMenuCandidates('review', commands, identity).bestRank,
  );
});

test('a word boundary in the middle of a name beats an arbitrary substring', () => {
  assert.ok(
    menuMatchRank('review', { name: 'security-review' }) <
      menuMatchRank('review', { name: 'prereviewer' }),
  );
});

test('a query longer than the name does not match it', () => {
  assert.equal(menuMatchRank('reviewer', { name: 'review' }), Infinity);
});
