import { useMemo } from 'react';
import { Markdown } from './Markdown';
import { SvgCodeBlock } from './MarkdownDiagrams';

interface Segment {
  type: 'text' | 'svg';
  content: string;
}

// Spec documents mix prose with diagrams. Fenced ```mermaid / ```svg blocks
// render through the normal markdown pipeline (MermaidBlock / SvgCodeBlock);
// only raw inline <svg> markup needs extracting, because react-markdown drops
// unsanitized HTML before it can reach a renderer.
function parseSpecSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const inlineSvg = /<svg\b[\s\S]*?<\/svg>/g;
  let last = 0;
  for (let m = inlineSvg.exec(markdown); m; m = inlineSvg.exec(markdown)) {
    if (m.index > last) segments.push({ type: 'text', content: markdown.slice(last, m.index) });
    segments.push({ type: 'svg', content: m[0] });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) segments.push({ type: 'text', content: markdown.slice(last) });
  return segments;
}

export function SpecRenderer({ content }: { content: string }) {
  const segments = useMemo(() => parseSpecSegments(content), [content]);

  return (
    <div>
      {segments.map((seg, i) =>
        seg.type === 'svg' ? (
          <SvgCodeBlock key={i} content={seg.content} />
        ) : (
          <Markdown key={i} specMode>
            {seg.content}
          </Markdown>
        ),
      )}
    </div>
  );
}
