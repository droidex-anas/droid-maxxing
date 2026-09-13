import assert from 'node:assert/strict';
import test from 'node:test';
import { addNativeSurfaceObscurer, areNativeSurfacesObscured } from './useObscuresNativeSurfaces';

test('native surfaces stay hidden until the last stacked overlay closes', () => {
  assert.equal(areNativeSurfacesObscured(), false);

  const releaseViewer = addNativeSurfaceObscurer();
  const releaseFeedback = addNativeSurfaceObscurer();
  assert.equal(areNativeSurfacesObscured(), true);

  releaseViewer();
  assert.equal(areNativeSurfacesObscured(), true);

  releaseFeedback();
  assert.equal(areNativeSurfacesObscured(), false);
});

test('releasing twice cannot uncount an overlay that is still open', () => {
  const release = addNativeSurfaceObscurer();
  const stillOpen = addNativeSurfaceObscurer();

  release();
  release();
  assert.equal(areNativeSurfacesObscured(), true);

  stillOpen();
  assert.equal(areNativeSurfacesObscured(), false);
});
