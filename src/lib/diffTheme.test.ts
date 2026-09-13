import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_THEMES, contrastRatio } from './theme';
import { diffPaletteForTheme } from './diffTheme';

test('diff palettes use distinct readable semantic colors in light and dark themes', () => {
  const light = diffPaletteForTheme(false, 'soft');
  const dark = diffPaletteForTheme(true, 'soft');

  // Diff counts sit on the tinted light canvas as well as on cards, so both
  // semantic colors must clear WCAG AA there, not just on white.
  for (const preset of BUILT_IN_THEMES) {
    for (const base of [preset.light.bg, preset.light.surface]) {
      assert.ok(contrastRatio(light.addFg, base) >= 4.5, `addFg on ${base}`);
      assert.ok(contrastRatio(light.delFg, base) >= 4.5, `delFg on ${base}`);
    }
  }
  assert.notEqual(light.addBg, light.delBg);
  assert.notEqual(dark.addFg, light.addFg);
  assert.notEqual(dark.delFg, light.delFg);
});

test('focused diff palettes strengthen changed rows and gutters', () => {
  const soft = diffPaletteForTheme(false, 'soft');
  const focused = diffPaletteForTheme(false, 'focused');

  assert.notEqual(focused.addBg, soft.addBg);
  assert.notEqual(focused.delBg, soft.delBg);
  assert.notEqual(focused.addGutter, focused.addBg);
  assert.notEqual(focused.delGutter, focused.delBg);
});
