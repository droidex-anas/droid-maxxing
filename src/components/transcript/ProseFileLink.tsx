import { createContext, useContext, type ReactNode } from 'react';

import { repoPathInProse } from '../../lib/prosePaths';
import type { OpenReviewFileHandler } from '../../lib/reviewFocus';

// Inline code sits in the line as a quiet pill: sized from the text around it,
// tinted from the text colour so it still reads on a message bubble, and cloned
// across a line break so a wrapped pill keeps both ends.
const PILL =
  'rounded-[5px] bg-droid-text/[0.08] px-[5px] py-px font-mono text-[0.86em] text-droid-text [box-decoration-break:clone] break-words';

// A reply names files constantly ("check `docs/architecture.md`"), and those
// mentions open in Review exactly like a tool row's path. The handler reaches
// them through context because react-markdown's element maps are built once at
// module load and settled replies are cached as rendered elements: passing it
// down as a prop would rebuild both on every streamed token.
const ProseFileContext = createContext<OpenReviewFileHandler | null>(null);

/**
 * Scopes the file mentions inside `children`. Without a handler they stay plain
 * pills, which is also how a prompt the user typed renders: their own text
 * names files they already have open, and a bubble is not a set of controls.
 */
export function ProseFileLinks({
  onOpenReviewFile,
  children,
}: {
  onOpenReviewFile?: OpenReviewFileHandler;
  children: ReactNode;
}) {
  return (
    <ProseFileContext.Provider value={onOpenReviewFile ?? null}>
      {children}
    </ProseFileContext.Provider>
  );
}

export function InlineCode({ children }: { children?: ReactNode }) {
  const onOpenReviewFile = useContext(ProseFileContext);
  const path = typeof children === 'string' ? repoPathInProse(children) : null;
  if (!path || !onOpenReviewFile) return <code className={PILL}>{children}</code>;
  const open = () => {
    onOpenReviewFile(path);
  };
  // The pill stays a pill and keeps wrapping with the sentence, so the control
  // is the code element itself rather than a button that cannot break a line.
  return (
    <code
      role="button"
      tabIndex={0}
      title="Open in Review"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
      className={`${PILL} cursor-pointer underline decoration-transparent underline-offset-2 transition-colors hover:bg-droid-text/[0.14] hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent/60`}
    >
      {children}
    </code>
  );
}
