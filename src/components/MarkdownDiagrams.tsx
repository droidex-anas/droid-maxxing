import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Mermaid } from 'mermaid';

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

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const idRef = useRef(`mmd-${String(++mermaidSeq)}`);

  useEffect(() => {
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
  }, [code]);

  if (error) {
    return (
      <div className="rounded-2xl border border-droid-border bg-droid-elevated/20 overflow-hidden my-5">
        <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
          <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
            Diagram source
          </span>
          <span className="text-[10px] font-mono text-droid-text-muted/40">Mermaid</span>
        </div>
        <pre className="overflow-x-auto p-4">
          <code className="font-mono text-[12px] text-droid-text-secondary whitespace-pre">
            {code}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-droid-border bg-droid-elevated/20 overflow-hidden my-5">
      <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
        <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
          Diagram
        </span>
        <span className="text-[10px] font-mono text-droid-text-muted/40">Mermaid</span>
      </div>
      <div
        className="p-4 flex items-center justify-center [&_svg]:max-w-full [&_svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
});

/* ── SVG code block renderer ── */
export function SvgCodeBlock({ content }: { content: string }) {
  const safeSvg = useMemo(() => {
    let raw = content.trim();
    if (!raw.startsWith('<svg')) {
      raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="100%">${raw}</svg>`;
    }
    raw = raw.replace(/width="\d+(?:px)?"/gi, 'width="100%"');
    raw = raw.replace(/height="\d+(?:px)?"/gi, '');
    if (!raw.includes('xmlns=')) {
      raw = raw.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return raw;
  }, [content]);

  return (
    <div className="rounded-2xl border border-droid-border bg-droid-elevated/30 overflow-hidden my-4">
      <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
        <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
          Diagram
        </span>
        <span className="text-[10px] font-mono text-droid-text-muted/40">SVG</span>
      </div>
      <div className="p-4 flex items-center justify-center min-h-[100px]">
        <div
          className="w-full flex items-center justify-center [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:block"
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
      </div>
    </div>
  );
}
