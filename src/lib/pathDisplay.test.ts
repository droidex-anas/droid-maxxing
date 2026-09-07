import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPath, displayPath, resolveWorkspaceFilePath } from './pathDisplay';

test('resolveWorkspaceFilePath joins relative review paths to the session folder', () => {
  assert.equal(resolveWorkspaceFilePath('src/app.ts', '/repo'), '/repo/src/app.ts');
  assert.equal(resolveWorkspaceFilePath('./src/app.ts', '/repo'), '/repo/src/app.ts');
  assert.equal(
    resolveWorkspaceFilePath('../shared/foo.ts', '/repo/packages/web'),
    '/repo/packages/shared/foo.ts',
  );
});

test('resolveWorkspaceFilePath keeps absolute transcript paths unchanged', () => {
  assert.equal(resolveWorkspaceFilePath('/abs/src/app.ts', '/repo'), '/abs/src/app.ts');
});

test('resolveWorkspaceFilePath preserves a filesystem-root session folder', () => {
  assert.equal(resolveWorkspaceFilePath('etc/hosts', '/'), '/etc/hosts');
});

test('displayPath relativizes descendants of a filesystem-root session folder', () => {
  assert.equal(displayPath('/etc/hosts', '/'), 'etc/hosts');
  assert.equal(displayPath('/', '/'), '.');
  assert.equal(displayPath('C:/Windows/System32', 'C:/'), 'Windows/System32');
});

test('displayPath treats drive-letter case as the same session folder', () => {
  assert.equal(displayPath('C:/Repo/src/app.ts', 'c:/repo'), 'src/app.ts');
  assert.equal(displayPath('c:/repo', 'C:/Repo'), '.');
});

test('compactPath shortens long relative read paths', () => {
  assert.equal(compactPath('src/a/b/c/d.ts'), '…/b/c/d.ts');
  assert.equal(compactPath('src/app.ts'), 'src/app.ts');
});
