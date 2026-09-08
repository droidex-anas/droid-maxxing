export { resolveSource };

function resolveSource(el) {
  const react = resolveReact(el);
  if (react && react.file) return react;
  const attr = resolveAttributes(el);
  if (attr && attr.file) {
    if (react) {
      attr.component = attr.component || react.component;
      attr.componentChain = attr.componentChain || react.componentChain;
      attr.framework = attr.framework || react.framework;
    }
    return attr;
  }
  const vue = resolveVue(el);
  if (vue && vue.file) return vue;
  const svelte = resolveSvelte(el);
  if (svelte && svelte.file) return svelte;
  return react || vue || svelte || attr || { confidence: 'none' };
}

function resolveReact(el) {
  const key = Object.keys(el).find(
    (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
  );
  if (!key) return undefined;
  let fiber = el[key] || null;
  let file;
  let line;
  let column;
  const chain = [];
  let guard = 0;
  while (fiber && guard < 200) {
    guard += 1;
    if (!file && fiber._debugSource && typeof fiber._debugSource.fileName === 'string') {
      file = normalizeFile(fiber._debugSource.fileName);
      line = numberOr(fiber._debugSource.lineNumber);
      column = numberOr(fiber._debugSource.columnNumber);
    }
    const name = componentName(fiber.type);
    if (name && chain[chain.length - 1] !== name && chain.length < 6) chain.push(name);
    fiber = fiber._debugOwner || fiber.return || null;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'react',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    line,
    column,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveVue(el) {
  let instance = el.__vueParentComponent || (el.__vnode && el.__vnode.component) || el.__vue__;
  if (!instance) return undefined;
  let file;
  const chain = [];
  let guard = 0;
  while (instance && guard < 200) {
    guard += 1;
    const type = instance.type || instance.$options;
    if (!file && type && typeof type.__file === 'string') file = normalizeFile(type.__file);
    const name = type && (type.name || type.__name);
    if (name && chain[chain.length - 1] !== name && chain.length < 6) chain.push(name);
    instance = instance.parent || instance.$parent;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'vue',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveSvelte(el) {
  let node = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const meta = node.__svelte_meta;
    if (meta && meta.loc && typeof meta.loc.file === 'string') {
      return {
        framework: 'svelte',
        file: normalizeFile(meta.loc.file),
        line: numberOr(meta.loc.line),
        column: numberOr(meta.loc.column),
        confidence: 'exact',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function resolveAttributes(el) {
  let node = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const path =
      node.getAttribute('data-inspector-relative-path') ||
      node.getAttribute('data-source-file') ||
      node.getAttribute('data-sourcefile') ||
      node.getAttribute('data-source');
    if (path) {
      return {
        component:
          node.getAttribute('data-component') || node.getAttribute('data-testid') || undefined,
        file: normalizeFile(path),
        line: numberOr(
          node.getAttribute('data-inspector-line') || node.getAttribute('data-source-line'),
        ),
        column: numberOr(
          node.getAttribute('data-inspector-column') || node.getAttribute('data-source-column'),
        ),
        confidence: 'attribute',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function componentName(type) {
  if (typeof type === 'function') {
    const name = type.displayName || type.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  if (type && typeof type === 'object') {
    const name = type.displayName || type.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  return undefined;
}

function normalizeFile(file) {
  if (!file) return undefined;
  let normalized = String(file).replace(/[?#].*$/, '');
  const fsIndex = normalized.indexOf('/@fs/');
  if (fsIndex >= 0) normalized = normalized.slice(fsIndex + 4);
  normalized = normalized.replace(/^https?:\/\/[^/]+/, '');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  return normalized.replace(/^\//, '');
}

function numberOr(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : undefined;
}
