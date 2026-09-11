// Which inline code in a model's prose names a file the Review panel can open.
// "See `src/components/ChatView.tsx:42`" should be reachable; `npm ci`,
// `useState`, and `either/or` should stay plain text, so the shape has to be
// unmistakably a path rather than merely plausible.

// A mention may end in the line it is about (and editors often add the column);
// Review opens whole files, so the suffix is trimmed off the path.
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

// Whitespace, shell and code punctuation: a command, a call, or a glob.
const NOT_A_PATH_CHAR = /[\s*?"'`<>|(){}[\],;=$!\\]/;

const FILE_EXTENSION =
  /\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|css|scss|html|md|mdx|txt|ya?ml|toml|ini|cfg|env|sql|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|lock)$/i;

/**
 * The repository path an inline-code mention names, or null when it names
 * something else. A path either ends in a known file extension or nests at
 * least two directories deep, which keeps prose pairs like `client/server` and
 * bare directories (nothing for Review to show) out of the clickable set.
 */
export function repoPathInProse(text: string): string | null {
  const mention = text.trim();
  if (!mention || NOT_A_PATH_CHAR.test(mention)) return null;
  if (mention.includes('://') || mention.startsWith('-')) return null;
  const path = mention.replace(LINE_SUFFIX, '');
  if (!path || path.endsWith('/') || path.includes(':')) return null;
  return FILE_EXTENSION.test(path) || path.split('/').length > 2 ? path : null;
}
