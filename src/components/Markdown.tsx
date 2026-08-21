import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  memo,
  type ReactNode,
} from 'react';
import { AppBlock } from './AppBlock';
import { appFencesInMarkdown } from '../lib/appBlocks';
import { CodeCard } from './MarkdownCode';
import { TranscriptImage } from './media/TranscriptImage';
import { MermaidBlock, SvgCodeBlock } from './MarkdownDiagrams';

export { copyMarkdownCode } from './MarkdownCode';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function reactText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return Children.toArray(node).map(reactText).join('');
  }
  return reactText(node.props.children);
}

function hasLanguage(className: string | undefined, language: string): boolean {
  return (
    className
      ?.split(/\s+/)
      .some((name) => name === `language-${language}` || name === `lang-${language}`) ?? false
  );
}

const isJsonLang = (className?: string) => hasLanguage(className, 'json');
const isSvgLang = (className?: string) => hasLanguage(className, 'svg');
const isMermaidLang = (className?: string) => hasLanguage(className, 'mermaid');
const isAppLang = (className?: string) => hasLanguage(className, 'app');

function HighlightJson({ code }: { code: string }) {
  const nodes = useMemo(() => {
    const tokens = code.split(
      /("(?:\\.|[^"\\])*"|:|true|false|null|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[[\]{}!,])/g,
    );
    return tokens.map((token, i) => {
      if (/^"(?:\\.|[^"\\])*"$/.exec(token)) {
        const next = tokens[i + 1].trimStart();
        if (next.startsWith(':')) {
          return (
            <span key={i} style={{ color: 'var(--droid-accent)' }}>
              {token}
            </span>
          );
        }
        return (
          <span key={i} style={{ color: 'var(--droid-green)' }}>
            {token}
          </span>
        );
      }
      if (token === 'true' || token === 'false')
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (token === 'null')
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      if (/^\d/.exec(token))
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (/^[{}[\],:!]$/.test(token))
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      return <span key={i}>{token}</span>;
    });
  }, [code]);

  return <>{nodes}</>;
}

/* ── Fenced content that changes while a response streams ──
   Presentation is fixed by `specMode`, which selects one of the two element
   maps built below. Everything else a fence needs changes token by token, so it
   travels through context instead of being captured in a map. */

interface FenceRenderOptions {
  allowGeneratedContent: boolean;
  autoPlayAppBlocks: boolean;
  buildingAppBlocks: boolean;
  cutOffAppBlocks: boolean;
  // Source line of the one app fence still being written, when the response is
  // mid-stream. Only the trailing fence can be unterminated, and a fence
  // recognises itself by position, so rendering one twice cannot shift the
  // building state onto its neighbour.
  incompleteAppFenceLine: number | null;
}

const FenceOptionsContext = createContext<FenceRenderOptions>({
  allowGeneratedContent: true,
  autoPlayAppBlocks: false,
  buildingAppBlocks: false,
  cutOffAppBlocks: false,
  incompleteAppFenceLine: null,
});

function MarkdownFence({
  className,
  specMode,
  startLine,
  children,
}: {
  className?: string;
  specMode: boolean;
  startLine?: number;
  children?: ReactNode;
}) {
  const {
    allowGeneratedContent,
    autoPlayAppBlocks,
    buildingAppBlocks,
    cutOffAppBlocks,
    incompleteAppFenceLine,
  } = useContext(FenceOptionsContext);
  const inline = !className;
  if (inline)
    return (
      <code
        className={`font-mono px-1.5 py-0.5 rounded-md bg-droid-elevated/70 text-droid-text break-words ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
      >
        {children}
      </code>
    );

  const codeText = typeof children === 'string' ? children : '';

  if (allowGeneratedContent && isAppLang(className)) {
    const isComplete =
      startLine === undefined ? !buildingAppBlocks : startLine !== incompleteAppFenceLine;
    return (
      <AppBlock
        source={codeText}
        autoPlay={autoPlayAppBlocks && isComplete}
        isBuilding={buildingAppBlocks && !isComplete}
        isCutOff={cutOffAppBlocks && !isComplete}
      />
    );
  }

  if (allowGeneratedContent && isMermaidLang(className)) {
    return <MermaidBlock code={codeText} />;
  }

  if (allowGeneratedContent && isSvgLang(className)) {
    return <SvgCodeBlock content={codeText} />;
  }

  return (
    <CodeCard
      code={codeText}
      className={className}
      specMode={specMode}
      highlighted={isJsonLang(className) ? <HighlightJson code={codeText} /> : undefined}
    />
  );
}

/* ── react-markdown element overrides ──
   react-markdown uses each entry of `components` as the JSX element type for
   the matching markdown node. A map built during the render gives every node a
   brand-new type on every render, and React answers that by unmounting and
   remounting the whole response: App iframes reload, Mermaid diagrams restart,
   images refetch, and anything the reader is interacting with is thrown away on
   every streamed token. Both maps are built once, at module load. */

function createMarkdownComponents(specMode: boolean): Components {
  return {
    h1: ({ children }) => {
      const id = slugify(reactText(children));
      return specMode ? (
        <h1
          id={id}
          className="text-[24px] font-semibold tracking-tight text-droid-text mt-10 first:mt-0 mb-4 scroll-mt-8"
        >
          {children}
        </h1>
      ) : (
        <h1 className="text-[17px] font-semibold text-droid-text mt-4 first:mt-0 mb-1">
          {children}
        </h1>
      );
    },
    h2: ({ children }) => {
      const id = slugify(reactText(children));
      return specMode ? (
        <h2
          id={id}
          className="text-[18px] font-semibold text-droid-text mt-7 first:mt-0 mb-2.5 scroll-mt-8"
        >
          {children}
        </h2>
      ) : (
        <h2 className="text-[15px] font-semibold text-droid-text mt-4 first:mt-0 mb-1">
          {children}
        </h2>
      );
    },
    h3: ({ children }) => {
      const id = slugify(reactText(children));
      return specMode ? (
        <h3
          id={id}
          className="text-[15px] font-semibold text-droid-text-secondary mt-5 first:mt-0 mb-2 scroll-mt-8"
        >
          {children}
        </h3>
      ) : (
        <h3 className="text-[14px] font-semibold text-droid-text mt-3 first:mt-0 mb-1">
          {children}
        </h3>
      );
    },
    p: ({ children }) => <p className={specMode ? 'leading-[1.8]' : 'leading-[1.7]'}>{children}</p>,
    ul: ({ children }) => (
      <ul
        className={`marker:text-droid-text-muted ${specMode ? 'list-disc pl-6 space-y-2' : 'list-disc pl-5 space-y-1.5'}`}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={`marker:text-droid-text-muted ${specMode ? 'list-decimal pl-6 space-y-2' : 'list-decimal pl-5 space-y-1.5'}`}
      >
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className={specMode ? 'leading-[1.75] pl-1' : 'leading-[1.65] pl-0.5'}>{children}</li>
    ),
    strong: ({ children }) => <strong className="font-semibold text-droid-text">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ children, href, node }) => {
      // A linked markdown image would otherwise produce invalid nested
      // interactive HTML (<a><button>), so the image viewer wins and the
      // redundant outer link is omitted. Inspect the parsed markdown node
      // rather than React element identity, which react-markdown wraps.
      const linkedImage = node?.children.some(
        (child) => child.type === 'element' && child.tagName === 'img',
      );
      if (linkedImage) return <>{children}</>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:opacity-80 transition-opacity"
          style={{ color: 'var(--droid-accent)' }}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote
        className={`italic text-droid-text-secondary ${specMode ? 'border-l border-droid-border pl-4 py-0.5 my-4' : 'border-l-2 border-droid-border-hover pl-3.5'}`}
      >
        {children}
      </blockquote>
    ),
    // Without this, react-markdown emits a bare <img src="/abs/path">,
    // which the renderer origin cannot resolve; TranscriptImage routes
    // local paths through the desktop image source and bounds the preview.
    img: ({ src, alt, title }) =>
      typeof src === 'string' ? <TranscriptImage reference={src} alt={alt} title={title} /> : null,
    hr: () => <hr className={`border-0 h-px bg-droid-border/25 ${specMode ? 'my-8' : 'my-4'}`} />,
    // Every fenced renderer below owns its frame and preformatted region.
    // Removing react-markdown's wrapper avoids invalid <pre><div> nesting.
    pre: ({ children, node }) => {
      const child = node?.children.at(0);
      const className = child && 'properties' in child ? child.properties.className : undefined;
      const hasFenceLanguage = Array.isArray(className)
        ? className.length > 0
        : typeof className === 'string' && className.length > 0;
      return hasFenceLanguage ? (
        <>{children}</>
      ) : (
        <pre className="my-2.5 overflow-x-auto rounded-xl border border-droid-border bg-droid-elevated/40 p-3.5 whitespace-pre">
          {children}
        </pre>
      );
    },
    code: ({ className, children, node }) => (
      <MarkdownFence
        className={className}
        specMode={specMode}
        startLine={node?.position?.start.line}
      >
        {children}
      </MarkdownFence>
    ),
    table: ({ children }) => (
      <div
        className={`overflow-x-auto rounded-xl border border-droid-border ${specMode ? 'my-6' : 'my-2.5'}`}
      >
        <table className={`w-full border-collapse ${specMode ? 'text-[13.5px]' : 'text-[12.5px]'}`}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-droid-elevated/25">{children}</thead>,
    th: ({ children }) => (
      <th
        className={`border-b border-droid-border text-left align-top font-medium whitespace-nowrap text-droid-text ${specMode ? 'px-3.5 py-2.5' : 'px-2.5 py-1.5'}`}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td
        className={`border-t border-droid-border align-top text-droid-text-secondary first:whitespace-nowrap first:pr-4 first:font-medium first:text-droid-text ${specMode ? 'px-3.5 py-2.5' : 'px-2.5 py-1.5'}`}
      >
        {children}
      </td>
    ),
  };
}

const REMARK_PLUGINS = [remarkGfm];
const CHAT_COMPONENTS = createMarkdownComponents(false);
const SPEC_COMPONENTS = createMarkdownComponents(true);

function MarkdownImpl({
  children,
  specMode = false,
  allowGeneratedContent = true,
  autoPlayAppBlocks = false,
  buildingAppBlocks = false,
  cutOffAppBlocks = false,
}: {
  children: string;
  specMode?: boolean;
  allowGeneratedContent?: boolean;
  autoPlayAppBlocks?: boolean;
  buildingAppBlocks?: boolean;
  cutOffAppBlocks?: boolean;
}) {
  const fenceOptions: FenceRenderOptions = {
    allowGeneratedContent,
    autoPlayAppBlocks,
    buildingAppBlocks,
    cutOffAppBlocks,
    incompleteAppFenceLine:
      appFencesInMarkdown(children).find((fence) => !fence.complete)?.startLine ?? null,
  };
  return (
    <div
      className={`text-droid-text break-words ${specMode ? 'text-[15px] leading-[1.8] space-y-5' : 'text-[13.5px] leading-[1.7] space-y-3'}`}
    >
      <FenceOptionsContext.Provider value={fenceOptions}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          components={specMode ? SPEC_COMPONENTS : CHAT_COMPONENTS}
        >
          {children}
        </ReactMarkdown>
      </FenceOptionsContext.Provider>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
