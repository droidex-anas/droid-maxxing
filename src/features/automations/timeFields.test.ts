import assert from 'node:assert/strict';
import test from 'node:test';
import { clampNumber } from './TimeFields';

test('clearing a time field and blurring restores the previous value', () => {
  // Select the hour, delete it, blur: the committed value must stay 14, not 00.
  assert.equal(clampNumber('', 0, 23, 14), 14);
  assert.equal(clampNumber('   ', 0, 59, 37), 37);
  assert.equal(clampNumber('abc', 0, 23, 9), 9);
});

test('time fields clamp and truncate what the user typed', () => {
  assert.equal(clampNumber('7', 0, 23, 9), 7);
  assert.equal(clampNumber('07', 0, 23, 9), 7);
  assert.equal(clampNumber('99', 0, 23, 9), 23);
  assert.equal(clampNumber('61', 0, 59, 0), 59);
  assert.equal(clampNumber(-4, 0, 23, 9), 0);
  assert.equal(clampNumber(12.9, 0, 23, 9), 12);
});
