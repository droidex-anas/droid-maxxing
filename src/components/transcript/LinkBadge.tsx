import { useState } from 'react';
import { Globe } from 'lucide-react';
import { faviconUrl, type LinkPresentation } from '../../lib/linkPresentation';

// The mark shown before a link, so a list of sources can be scanned by site
// rather than read URL by URL. Inline rather than a flex row: the link text has
// to keep wrapping normally around it.

const MARK = 'mr-1.5 inline-block h-3.5 w-3.5 shrink-0 align-[-2px]';

// Favicons come from the desktop app's main process; a renderer running without
// it — the plain dev server, server-side rendering — has nowhere to ask.
const canLoadIcons = typeof window !== 'undefined' && 'droidControl' in window;

// Hosts whose icon failed this session. A badge that remounts — a virtualized
// row scrolling back into view — goes straight to the fallback instead of
// flashing an empty box while the request fails again.
const missingIcons = new Set<string>();

export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="h-full w-full">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function LinkBadge({ link }: { link: LinkPresentation }) {
  const [missing, setMissing] = useState(() => !canLoadIcons || missingIcons.has(link.host));

  if (link.isGitHub) {
    return (
      <span className={`${MARK} text-droid-text-secondary`}>
        <GitHubMark />
      </span>
    );
  }
  if (missing) {
    return <Globe aria-hidden strokeWidth={1.75} className={`${MARK} text-droid-text-muted`} />;
  }
  return (
    <img
      src={faviconUrl(link.host)}
      alt=""
      aria-hidden
      width={14}
      height={14}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`${MARK} rounded-[3px] object-contain`}
      onError={() => {
        missingIcons.add(link.host);
        setMissing(true);
      }}
    />
  );
}
