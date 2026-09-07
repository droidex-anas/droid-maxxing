import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOpenReviewAt,
  clearReviewFocus,
  exhaustedReviewFocus,
  openReviewAt,
  planReviewFocus,
} from './reviewFocus';

const change = {
  path: 'src/app.ts',
  verb: 'edit' as const,
  ops: [{ type: 'add' as const, text: 'hello' }],
  added: 1,
  removed: 0,
};

test('openReviewAt includes the captured transcript change on OPEN_REVIEW_AT', () => {
  assert.deepEqual(openReviewAt('src/app.ts', change), {
    type: 'OPEN_REVIEW_AT',
    scope: 'last_turn',
    path: 'src/app.ts',
    change,
  });
  assert.equal(openReviewAt('src/app.ts', change, 'uncommitted').scope, 'uncommitted');
});

test('applyOpenReviewAt stores the captured change instead of dropping it', () => {
  const next = applyOpenReviewAt(
    { reviewFocusPath: null, reviewFocusChange: null, reviewFocusRequestId: 0 },
    openReviewAt('src/app.ts', change),
  );
  assert.equal(next.reviewFocusPath, 'src/app.ts');
  assert.equal(next.reviewFocusChange, change);
  assert.equal(next.reviewFocusRequestId, 1);
});

test('clearReviewFocus drops both the path and the captured change', () => {
  const next = clearReviewFocus({
    reviewFocusPath: 'src/app.ts',
    reviewFocusChange: change,
    reviewFocusRequestId: 1,
  });
  assert.equal(next.reviewFocusPath, null);
  assert.equal(next.reviewFocusChange, null);
});

test('exhaustedReviewFocus prefers the captured transcript change over a disk preview', () => {
  assert.deepEqual(exhaustedReviewFocus(change, 'src/app.ts'), { kind: 'change', change });
  assert.deepEqual(exhaustedReviewFocus(null, 'src/app.ts'), {
    kind: 'preview',
    path: 'src/app.ts',
    content: null,
  });
});

test('planReviewFocus shows the captured change while git lists are loading', () => {
  const plan = planReviewFocus({
    focusPath: 'src/app.ts',
    focusChange: change,
    files: [],
    loadingList: true,
    currentScope: 'last_turn',
    requestId: 1,
    alreadyTriedKey: null,
  });
  assert.deepEqual(plan, { kind: 'wait', detached: { kind: 'change', change } });
});

test('planReviewFocus jumps when git lists the focused file', () => {
  const plan = planReviewFocus({
    focusPath: 'src/app.ts',
    focusChange: change,
    files: [{ path: 'src/app.ts' }],
    loadingList: false,
    currentScope: 'last_turn',
    requestId: 1,
    alreadyTriedKey: null,
  });
  assert.deepEqual(plan, { kind: 'jump', path: 'src/app.ts' });
});

test('planReviewFocus keeps the captured change while advancing git scopes', () => {
  const plan = planReviewFocus({
    focusPath: 'src/app.ts',
    focusChange: change,
    files: [],
    loadingList: false,
    currentScope: 'last_turn',
    requestId: 4,
    alreadyTriedKey: null,
  });
  assert.equal(plan.kind, 'advance');
  if (plan.kind !== 'advance') return;
  assert.equal(plan.change, change);
  assert.equal(plan.scope, 'uncommitted');
  assert.deepEqual(plan.detached, { kind: 'change', change });
});

test('planReviewFocus uses the captured change when no git scope lists the file', () => {
  const plan = planReviewFocus({
    focusPath: 'src/app.ts',
    focusChange: change,
    files: [],
    loadingList: false,
    currentScope: 'commit',
    requestId: 4,
    alreadyTriedKey: '4:commit→src/app.ts',
  });
  assert.deepEqual(plan, { kind: 'detached', focus: { kind: 'change', change } });
});
