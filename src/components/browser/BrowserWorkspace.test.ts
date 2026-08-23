import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./BrowserWorkspace.tsx', import.meta.url), 'utf8');

test('reload controls target the restored browser session instead of reopening its saved URL', () => {
  assert.match(
    source,
    /onReload=\{\(\) => \{[\s\S]*?if \(browserKey && browser\) reloadBrowser\(browserKey\);[\s\S]*?else openCurrentUrl\(\);/,
  );
  assert.doesNotMatch(source, /onReload=\{\(\) => \{[\s\S]*?openBrowser\(/);
});
