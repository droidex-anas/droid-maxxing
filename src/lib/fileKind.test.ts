import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentDisplayName, fileKindInfo } from './fileKind';

test('fileKindInfo classifies by extension before MIME', () => {
  assert.equal(fileKindInfo('notes.pdf').kind, 'pdf');
  assert.equal(fileKindInfo('notes.pdf').label, 'PDF');
  assert.equal(fileKindInfo('blob', 'application/pdf').kind, 'pdf');
});

test('attachmentDisplayName uses the basename for Windows and POSIX paths', () => {
  assert.equal(attachmentDisplayName('C:\\Users\\anas\\Q4 plan.pdf'), 'Q4 plan.pdf');
  assert.equal(attachmentDisplayName('/tmp/attachments/Q4 plan.pdf'), 'Q4 plan.pdf');
});

test('attachmentDisplayName peels the temp-store prefix and keeps coincidental names intact when empty', () => {
  assert.equal(
    attachmentDisplayName('/tmp/attachments/file-1756800000000-deadbeef-report.pdf'),
    'report.pdf',
  );
  assert.equal(
    attachmentDisplayName('file-1756800000000-deadbeef-'),
    'file-1756800000000-deadbeef-',
  );
});
