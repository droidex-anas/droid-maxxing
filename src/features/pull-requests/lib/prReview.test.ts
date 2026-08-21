import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrComment, PullRequest } from '../../../types/vcs';
import {
  CUBIC_REVIEW_MENTION,
  droidReviewSeed,
  hasCubicActivity,
  isCubicAuthor,
  prReviewOptions,
  repoKeyFromPrUrl,
} from './prReview';

const comment = (author: string): PrComment => ({
  id: author,
  kind: 'comment',
  author,
  body: 'x',
  createdAt: null,
  url: null,
  state: null,
  reactions: [],
});

test('cubic is recognised as both a user and a bot account', () => {
  assert.equal(isCubicAuthor('cubic-dev-ai'), true);
  assert.equal(isCubicAuthor('cubic-dev-ai[bot]'), true);
  assert.equal(isCubicAuthor('Cubic-Dev-AI[bot]'), true);
  assert.equal(isCubicAuthor('cubicle'), false);
  assert.equal(isCubicAuthor('ana'), false);
  // Only the documented account counts: a lookalike login is not Cubic.
  assert.equal(isCubicAuthor('cubic-dev-ai-impostor'), false);
  assert.equal(isCubicAuthor('cubic-developer'), false);
});

test('cubic activity is detected from any comment on the pull request', () => {
  assert.equal(hasCubicActivity([comment('ana'), comment('cubic-dev-ai[bot]')]), true);
  assert.equal(hasCubicActivity([comment('ana')]), false);
  assert.equal(hasCubicActivity([]), false);
});

test('the cubic memory is keyed by repository, not by checkout', () => {
  assert.equal(
    repoKeyFromPrUrl('https://github.com/droidex-anas/droid-maxxing/pull/113'),
    'droidex-anas/droid-maxxing',
  );
  assert.equal(
    repoKeyFromPrUrl('https://github.com/Droidex-Anas/Droid-Maxxing/pull/113#issuecomment-1'),
    'droidex-anas/droid-maxxing',
  );
  assert.equal(repoKeyFromPrUrl('https://github.com/droidex-anas/droid-maxxing'), null);
  assert.equal(repoKeyFromPrUrl(null), null);
  assert.equal(repoKeyFromPrUrl(undefined), null);
});

test('the cubic trigger is the mention GitHub understands', () => {
  assert.equal(CUBIC_REVIEW_MENTION, '@cubic-dev-ai review this PR');
});

test('an unknown repository is invited to Cubic and can still review locally', () => {
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: false, kind: 'open' }).map((option) => option.action),
    ['enable-cubic', 'droid'],
  );
});

test('a settled pull request never invites Cubic, installed or not', () => {
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: false, kind: 'merged' }).map((option) => option.action),
    ['droid'],
  );
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: false, kind: 'closed' }).map((option) => option.action),
    ['droid'],
  );
});

test('a connected repository can trigger Cubic while the pull request is open', () => {
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: true, kind: 'draft' }).map((option) => option.action),
    ['run-cubic', 'droid'],
  );
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: true, kind: 'merged' }).map((option) => option.action),
    ['droid'],
  );
  assert.deepEqual(
    prReviewOptions({ cubicInstalled: true, kind: 'closed' }).map((option) => option.action),
    ['droid'],
  );
});

test('a local review opens with the review skill and the pull request', () => {
  const pr = {
    number: 128,
    title: 'Ship the review menu',
    url: 'https://github.com/o/r/pull/128',
  } as PullRequest;
  assert.equal(
    droidReviewSeed(pr),
    '/review Pull request #128: Ship the review menu\nhttps://github.com/o/r/pull/128',
  );
  assert.equal(
    droidReviewSeed({ ...pr, url: '' } as PullRequest),
    '/review Pull request #128: Ship the review menu',
  );
});

test('the review seed trims the title and url and omits empty values', () => {
  const pr = {
    number: 9,
    title: '  Polish the seed  ',
    url: '  https://github.com/o/r/pull/9  ',
  } as PullRequest;
  assert.equal(
    droidReviewSeed(pr),
    '/review Pull request #9: Polish the seed\nhttps://github.com/o/r/pull/9',
  );
  assert.equal(
    droidReviewSeed({ ...pr, title: '', url: '   ' } as PullRequest),
    '/review Pull request #9',
  );
});
