import type { OcticonName } from '../../../components/environment/GithubIcons';
import type { PrComment } from '../../../types/vcs';

// A review thread that is settled, and how it got settled.
export interface PrThreadStatus {
  label: string;
  icon: OcticonName;
  title: string;
}

export function threadStatus(comment: PrComment): PrThreadStatus | null {
  if (comment.resolved) {
    return {
      label: 'Resolved',
      icon: 'check',
      title: comment.resolvedBy
        ? `Resolved by ${comment.resolvedBy}`
        : 'This conversation is resolved',
    };
  }
  if (comment.outdated) {
    return {
      label: 'Outdated',
      icon: 'clock',
      title: 'The lines this comment refers to have changed',
    };
  }
  return null;
}

// A comment past either threshold turns into a folded card, so one essay does
// not push the rest of the conversation off screen.
const FOLD_LINES = 10;
const FOLD_CHARACTERS = 700;

export function isLongComment(body: string): boolean {
  return body.split('\n').length > FOLD_LINES || body.length > FOLD_CHARACTERS;
}

// Folded cards need a headline. Markdown syntax is stripped rather than
// rendered so the line stays one plain line at any width.
export function commentPreview(body: string, limit = 120): string {
  const line = body
    .split('\n')
    .filter((raw) => !raw.trimStart().startsWith('```'))
    .map((raw) =>
      raw
        .replace(/^\s*(?:[>#]+|[-*+]|\d+\.)\s*/, '')
        .replace(/[*_`~]/g, '')
        .trim(),
    )
    .find((candidate) => candidate.length > 0);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit).trimEnd()}…` : line;
}

// Resolved threads and long bodies start folded; everything else is short
// enough to read in place.
export function commentStartsFolded(comment: PrComment, body: string): boolean {
  return comment.resolved === true || isLongComment(body);
}
