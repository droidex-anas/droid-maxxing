import type { CSSProperties } from 'react';
import type { Components } from 'react-markdown';

// GFM only knows left, center and right; the hast type also allows values
// HTML tables never produce here.
function alignStyle(align: string | undefined): CSSProperties | undefined {
  return align === 'left' || align === 'center' || align === 'right'
    ? { textAlign: align }
    : undefined;
}

// GFM tables for the chat and spec presentations. A table wider than its column
// scrolls inside its own frame instead of stretching the transcript: the frame
// is capped at the available width, and a body cell never narrows past ~14
// characters, so a wide table scrolls instead of stacking its prose one word per
// line. With the scrollbar only shown on hover, the edge the table continues past
// fades instead, so a clipped table never reads as complete. The border sits on
// an outer frame so the fade never eats its rounded edge. Zebra rows
// keep wide rows scannable, and the header is set apart by tone and a stronger
// rule rather than by centered shouty caps.
export function markdownTableComponents(specMode: boolean): Components {
  const cell = specMode ? 'px-3.5 py-2.5' : 'px-2.5 py-1.5';
  return {
    table: ({ children }) => (
      <div
        className={`max-w-full overflow-hidden rounded-xl border border-droid-border ${specMode ? 'my-6' : 'my-2.5'}`}
      >
        <div className="scrollbar-on-hover scroll-fade-x overflow-x-auto overscroll-x-contain">
          <table className="min-w-full border-collapse text-[13px]">{children}</table>
        </div>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-droid-surface/45">{children}</thead>,
    tbody: ({ children }) => (
      <tbody className="[&_tr:nth-child(even)]:bg-droid-surface/25 [&_tr:hover]:bg-droid-active/25">
        {children}
      </tbody>
    ),
    th: ({ children, align }) => (
      <th
        style={alignStyle(align)}
        className={`border-b border-droid-border-hover text-left align-top font-semibold whitespace-nowrap text-droid-text ${cell}`}
      >
        {children}
      </th>
    ),
    td: ({ children, align }) => (
      <td
        style={alignStyle(align)}
        className={`min-w-[14ch] border-t border-droid-border/60 align-top text-droid-text-secondary first:font-medium first:text-droid-text ${cell}`}
      >
        {children}
      </td>
    ),
  };
}
