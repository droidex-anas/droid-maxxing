import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineCardMotion } from './inlineCardMotion';

test('the standard card slides and scales in over a visible duration', () => {
  const motion = inlineCardMotion(false);

  assert.deepEqual(motion.initial, { opacity: 0, y: 8, scale: 0.985 });
  assert.deepEqual(motion.animate, { opacity: 1, y: 0, scale: 1 });
  assert.deepEqual(motion.exit, { opacity: 0, y: 8, scale: 0.985 });
  assert.ok(motion.transition.duration > 0);
});

test('reduced motion removes every transform and animates instantly', () => {
  const motion = inlineCardMotion(true);

  for (const phase of [motion.initial, motion.animate, motion.exit]) {
    assert.equal(phase.y, undefined);
    assert.equal(phase.scale, undefined);
  }
  assert.equal(motion.transition.duration, 0);
  assert.equal(motion.transition.ease, undefined);
});

test('an unknown reduced-motion preference is treated as no preference', () => {
  // useReducedMotion() reports null until it has read the media query.
  assert.deepEqual(inlineCardMotion(null), inlineCardMotion(false));
});
