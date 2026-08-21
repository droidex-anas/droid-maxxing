import { formatRelativeTime } from '../../../lib/time';

// GitHub timestamps arrive as ISO strings; every PR surface wants the same
// compact "3d" form plus a full date on hover.
export function prRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? formatRelativeTime(ts) : '';
}

export function prAbsoluteTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toLocaleString();
}
