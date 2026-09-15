import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Mermaid } from 'mermaid';

import { useVisibleOnce } from '../hooks/useVisibleOnce';

/* Renderers for the fenced languages that draw a diagram instead of code. */

let mermaidPromise: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'dark',
      themeVariables: {
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '13px',
      },
    });
    return mermaid;
  });
  return mermaidPromise;
}

let mermaidSeq = 0;

// Models frequently emit flowchart syntax mermaid rejects (unquoted special
// characters in subgraph titles, and `[/text]` which mermaid reads as a
// parallelogram shape). Quote these so common flowcharts render instead of
// falling back to a raw code block.
function sanitizeMermaid(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const sg = /^(\s*subgraph\s+)(.+?)\s*$/i.exec(line);
      if (sg) {
        const title = sg[2].trim();
        const alreadySafe = title.startsWith('"') || /^[\w-]+(\[.*\]|\(.*\))?$/.test(title);
        if (!alreadySafe && /[/()\-:&.,]/.test(title)) {
          return `${sg[1]}"${title.replace(/"/g, '')}"`;
        }
        return line;
      }
      // [/register] -> ["/register"] (but keep real parallelograms [/text/]).
      return line.replace(/\[\/([^/\]\n]+)\]/g, '["/$1"]');
    })
    .join('\n');
}

// Every rendered diagram (mermaid, fenced or inline SVG) sits on a soft
// elevated wash with balanced breathing room — no header bar or border, the
// drawing is the content. `source` (a diagram that failed to render) shows
// the fenced code left-aligned instead.
function DiagramFrame({ source, children }: { source?: boolean; children: ReactNode }) {
  return (
    <figure
      className={`my-4 overflow-hidden rounded-2xl bg-droid-elevated/25 px-6 py-7 ${
        source ? '' : 'flex items-center justify-center'
      }`}
    >
      {children}
    </figure>
  );
}

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const idRef = useRef(`mmd-${String(++mermaidSeq)}`);
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = useVisibleOnce(hostRef);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const raw = code.trim();
    loadMermaid()
      .then(async (mermaid) => {
        try {
          return await mermaid.render(idRef.current, raw);
        } catch {
          // Retry once with a sanitized version of common bad flowchart syntax.
          return mermaid.render(`${idRef.current}-s`, sanitizeMermaid(raw));
        }
      })
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg);
          setError('');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [code, visible]);

  return (
    <div ref={hostRef}>
      {error ? (
        <DiagramFrame source>
          <pre className="w-full overflow-x-auto">
            <code className="font-mono text-[12px] whitespace-pre text-droid-text-secondary">
              {code}
            </code>
          </pre>
        </DiagramFrame>
      ) : (
        <DiagramFrame>
          <div
            className="flex w-full items-center justify-center [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </DiagramFrame>
      )}
    </div>
  );
});

/* ── SVG diagram renderer (fenced ```svg blocks and inline <svg> markup) ── */

// The diagram should scale to its container, but only the ROOT element's fixed
// dimensions may change — blanket-stripping width/height would destroy the
// geometry of every rect/circle inside. When the root has pixel dimensions but
// no viewBox, synthesize one so the drawing scales proportionally.
function scaleRootSvg(raw: string): string {
  return raw.replace(/<svg\b[^>]*>/i, (tag) => {
    const width = /\bwidth="(\d+)(?:px)?"/i.exec(tag)?.[1];
    const height = /\bheight="(\d+)(?:px)?"/i.exec(tag)?.[1];
    let next = tag.replace(/\s(?:width|height)="\d+(?:px)?"/gi, '');
    if (!/\bviewBox=/i.test(next) && width && height) {
      next = next.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
    }
    if (!/\bxmlns=/i.test(next)) {
      next = next.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return next.replace(/<svg\b/i, '<svg width="100%"');
  });
}

export function SvgCodeBlock({ content }: { content: string }) {
  const safeSvg = useMemo(() => {
    let raw = content.trim();
    if (!raw.startsWith('<svg')) {
      raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="100%">${raw}</svg>`;
    }
    return scaleRootSvg(raw);
  }, [content]);

  return (
    <DiagramFrame>
      <div
        className="flex w-full items-center justify-center [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: safeSvg }}
      />
    </DiagramFrame>
  );
}
