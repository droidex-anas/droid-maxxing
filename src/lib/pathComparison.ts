function normalizedSegments(path: string, absolute: boolean): string[] {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

export function normalizePath(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  const drive = /^[a-z]:/i.exec(slashed)?.[0] ?? '';
  const absolute = slashed.startsWith('/') || drive.length > 0;
  const body = drive ? slashed.slice(drive.length).replace(/^\//, '') : slashed.replace(/^\//, '');
  const segments = normalizedSegments(body, absolute);
  let prefix = '';
  if (drive) prefix = `${drive}/`;
  else if (absolute) prefix = '/';
  return `${prefix}${segments.join('/')}` || (absolute ? prefix : '.');
}

export function comparablePath(path: string): string {
  const normalized = normalizePath(path);
  const caseInsensitive =
    /^[a-z]:\//i.test(normalized) ||
    (typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod|windows/i.test(navigator.userAgent));
  return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized;
}
