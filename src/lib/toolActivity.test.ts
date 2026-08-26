import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocalStorageMap } from '../test/localStorage';
import {
  DEFAULT_TOOL_ACTIVITY_DENSITY,
  loadToolActivityDensity,
  saveToolActivityDensity,
} from './toolActivity';

test('tool activity defaults to compact', () => {
  withLocalStorageMap({}, () => {
    assert.equal(loadToolActivityDensity(), 'compact');
    assert.equal(DEFAULT_TOOL_ACTIVITY_DENSITY, 'compact');
  });
});

test('tool activity round-trips compact and verbose', () => {
  withLocalStorageMap({}, () => {
    assert.equal(saveToolActivityDensity('verbose'), 'verbose');
    assert.equal(loadToolActivityDensity(), 'verbose');
    assert.equal(saveToolActivityDensity('compact'), 'compact');
    assert.equal(loadToolActivityDensity(), 'compact');
  });
});

test('unknown stored values fall back to compact', () => {
  withLocalStorageMap({ 'droid-tool-activity': 'nope' }, () => {
    assert.equal(loadToolActivityDensity(), 'compact');
  });
});
