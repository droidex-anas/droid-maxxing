import assert from 'node:assert/strict';
import test from 'node:test';

import { permissionKindFromAcpToolKind } from './acpPermissionKind.js';

test('ACP tool kinds map to permission kinds through the data table', () => {
  assert.equal(permissionKindFromAcpToolKind('execute'), 'exec');
  assert.equal(permissionKindFromAcpToolKind('edit'), 'edit');
  assert.equal(permissionKindFromAcpToolKind('delete'), 'edit');
  assert.equal(permissionKindFromAcpToolKind('move'), 'edit');
  assert.equal(permissionKindFromAcpToolKind('create'), 'create');
  assert.equal(permissionKindFromAcpToolKind('apply_patch'), 'apply_patch');
  assert.equal(permissionKindFromAcpToolKind('mcp'), 'mcp');
  assert.equal(permissionKindFromAcpToolKind('search'), 'other');
  assert.equal(permissionKindFromAcpToolKind('fetch'), 'other');
  assert.equal(permissionKindFromAcpToolKind(undefined), 'other');
});
