// Relevance ranking for the composer's slash menu.
//
// Commands and skills are matched on their name and their description, so
// without ranking a skill named exactly like the query sits wherever the
// catalog happened to put it, below every entry that merely mentions the query
// in its description.

export interface MenuCandidate {
  name: string;
  description?: string;
}

export interface RankedCandidates<T> {
  items: T[];
  /** Rank of the best match, or Infinity when nothing matched. */
  bestRank: number;
}

// Lower is a better match.
const EXACT_NAME = 0;
const NAME_PREFIX = 1;
const NAME_WORD = 2;
const NAME_SUBSTRING = 3;
const DESCRIPTION = 4;
const NO_MATCH = Infinity;

const WORD_BREAK = /[\s\-_./:]/;

/** Rank of one candidate against the query; NO_MATCH when it does not match. */
export function menuMatchRank(query: string, candidate: MenuCandidate): number {
  const q = query.trim().toLowerCase();
  if (q === '') return NAME_SUBSTRING;
  const name = candidate.name.toLowerCase();
  if (name === q) return EXACT_NAME;
  if (name.startsWith(q)) return NAME_PREFIX;
  const at = name.indexOf(q);
  if (at > 0 && WORD_BREAK.test(name.charAt(at - 1))) return NAME_WORD;
  if (at > 0) return NAME_SUBSTRING;
  if ((candidate.description ?? '').toLowerCase().includes(q)) return DESCRIPTION;
  return NO_MATCH;
}

/**
 * Keeps the candidates that match the query, best match first. Ties break on
 * the shorter name, then alphabetically, so the order is stable for a given
 * query. An empty query matches everything and preserves the catalog order.
 */
export function rankMenuCandidates<T>(
  query: string,
  items: readonly T[],
  describe: (item: T) => MenuCandidate,
): RankedCandidates<T> {
  if (query.trim() === '') return { items: [...items], bestRank: NAME_SUBSTRING };
  const matches = items
    .map((item) => {
      const candidate = describe(item);
      return { item, name: candidate.name, rank: menuMatchRank(query, candidate) };
    })
    .filter((match) => match.rank !== NO_MATCH);
  matches.sort(
    (a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return {
    items: matches.map((match) => match.item),
    bestRank: matches.at(0)?.rank ?? NO_MATCH,
  };
}
