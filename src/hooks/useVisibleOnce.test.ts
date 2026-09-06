import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, createRef, useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useVisibleOnce } from './useVisibleOnce';

test('SSR markup does not claim visibility before the client observer runs', () => {
  function Probe() {
    const ref = createRef<HTMLDivElement>();
    const visible = useVisibleOnce(ref);
    return createElement('div', { ref, 'data-visible': String(visible) });
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.match(html, /data-visible="false"/);
  assert.equal(typeof useEffect, 'function');
});
