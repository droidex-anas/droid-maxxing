import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Children, createContext, isValidElement, useContext, memo, type ReactNode } from 'react';
import { AppBlock } from './AppBlock';
import { appFencesInMarkdown, type MarkdownAppFence } from '../lib/appBlocks';
import { CodeCard, HighlightJson, JSON_HIGHLIGHT_MAX_CHARS } from './MarkdownCode';
import { markdownTableComponents } from './MarkdownTable';
import { LinkBadge } from './transcript/LinkBadge';
import { describeLink, linkTextIsUrl } from '../lib/linkPresentation';
import { TranscriptImage } from './media/TranscriptImage';
import { MermaidBlock, SvgCodeBlock } from './MarkdownDiagrams';
import { InlineCode, ProseFileLinks } from './transcript/ProseFileLink';

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

// remark-gfm marks task-list nodes with these classes; reading them off the
// hast element keeps the presentation driven by the parsed markdown.
function hastClassNames(node: { properties?: { className?: unknown } } | undefined): string[] {
  const names = node?.properties?.className;
  if (Array.isArray(names)) return names.map(String);
  return typeof names === 'string' ? [names] : [];
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
  // The app fences found in the source, each carrying the line it opens on, so
  // a fence recognises itself by position rather than by counting renders.
  // Rendering one twice therefore cannot shift the building state onto its
  // neighbour. The scan is deliberately simpler than a full CommonMark parse,
  // so a fence nested deeper than it follows is absent from this list and falls
  // back to whether the response is still streaming.
  appFences: readonly MarkdownAppFence[];
}

const FenceOptionsContext = createContext<FenceRenderOptions>({
  allowGeneratedContent: true,
  autoPlayAppBlocks: false,
  buildingAppBlocks: false,
  cutOffAppBlocks: false,
  appFences: [],
});

// A fence the scan did not report cannot be judged by position, so it counts as
// unfinished for as long as the response is streaming: better a building card
// for one token than auto-playing half an app.
function appFenceIsFinished(
  fences: readonly MarkdownAppFence[],
  startLine: number | undefined,
  streaming: boolean,
): boolean {
  return fences.find((fence) => fence.startLine === startLine)?.complete ?? !streaming;
}

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
    appFences,
  } = useContext(FenceOptionsContext);
  const inline = !className;
  // Inline code owns its own pill, and inside a transcript a mention that names
  // a file opens it in Review.
  if (inline) return <InlineCode>{children}</InlineCode>;

  const codeText = typeof children === 'string' ? children : '';

  if (allowGeneratedContent && isAppLang(className)) {
    const isComplete = appFenceIsFinished(appFences, startLine, buildingAppBlocks);
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
      highlighted={
        isJsonLang(className) && codeText.length <= JSON_HIGHLIGHT_MAX_CHARS ? (
          <HighlightJson code={codeText} />
        ) : undefined
      }
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
    // Headings read as structure, not as bold text: a clear size ladder with
    // air above each level, and a hairline under the top level so a document
    // break is visible even when a model leans on `#`.
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
        <h1
          id={id}
          className="text-[19px] font-semibold tracking-tight text-droid-text mt-5 first:mt-0 mb-2 pb-1.5 border-b border-droid-border/70 scroll-mt-8"
        >
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
        <h2
          id={id}
          className="text-[16px] font-semibold text-droid-text mt-4 first:mt-0 mb-1.5 scroll-mt-8"
        >
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
        <h3
          id={id}
          className="text-[15px] font-semibold text-droid-text mt-3.5 first:mt-0 mb-1 scroll-mt-8"
        >
          {children}
        </h3>
      );
    },
    h4: ({ children }) =>
      specMode ? (
        <h4 className="text-[14px] font-semibold text-droid-text-secondary mt-4 first:mt-0 mb-1.5">
          {children}
        </h4>
      ) : (
        <h4 className="text-[14px] font-semibold text-droid-text mt-3.5 first:mt-0 mb-1">
          {children}
        </h4>
      ),
    h5: ({ children }) => (
      <h5 className="text-[14px] font-semibold text-droid-text-secondary mt-3 first:mt-0 mb-1">
        {children}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-[11.5px] font-medium uppercase tracking-wide text-droid-text-muted mt-3 first:mt-0 mb-1">
        {children}
      </h6>
    ),
    p: ({ children }) => <p className={specMode ? 'leading-[1.8]' : 'leading-[1.6]'}>{children}</p>,
    ul: ({ children }) => (
      <ul
        className={`marker:text-droid-text-muted ${specMode ? 'list-disc pl-6 space-y-2' : 'list-disc pl-5 space-y-1'}`}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol
        className={`marker:text-droid-text-muted ${specMode ? 'list-decimal pl-6 space-y-2' : 'list-decimal pl-5 space-y-1'}`}
      >
        {children}
      </ol>
    ),
    // A GFM task item carries its own checkbox, so it drops the bullet marker
    // and lets the checkbox lead the line instead.
    li: ({ children, node }) => {
      const taskItem = hastClassNames(node).includes('task-list-item');
      return taskItem ? (
        <li className="list-none pl-0 leading-[1.6]">{children}</li>
      ) : (
        <li
          className={
            specMode ? 'leading-[1.75] pl-1' : 'leading-[1.6] pl-0.5 [&>ol]:mt-1 [&>ul]:mt-1'
          }
        >
          {children}
        </li>
      );
    },
    input: ({ checked }) => (
      <input
        type="checkbox"
        defaultChecked={checked}
        disabled
        className="mr-1.5 h-3 w-3 translate-y-[0.5px] accent-[var(--droid-accent)]"
      />
    ),
    strong: ({ children }) => <strong className="font-semibold text-droid-text">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => (
      <del className="line-through decoration-droid-text-muted/80 text-droid-text-secondary">
        {children}
      </del>
    ),
    a: ({ children, href, node }) => {
      // A linked markdown image would otherwise produce invalid nested
      // interactive HTML (<a><button>), so the image viewer wins and the
      // redundant outer link is omitted. Inspect the parsed markdown node
      // rather than React element identity, which react-markdown wraps.
      const linkedImage = node?.children.some(
        (child) => child.type === 'element' && child.tagName === 'img',
      );
      if (linkedImage) return <>{children}</>;
      // The site's mark leads the link so a list of sources can be scanned by
      // where they point. A bare URL that names its own page — a pull request,
      // an issue — shows that name instead, with the full address on hover; a
      // link the author titled keeps their title. Links read by colour and
      // underline on hover; a bare URL may break anywhere, so it starts beside
      // its mark instead of leaving the mark alone on the line above.
      const link = href === undefined ? null : describeLink(href);
      const textIsUrl = href !== undefined && linkTextIsUrl(reactText(children), href);
      const named = textIsUrl && link?.label != null;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={href}
          className="group/link"
          style={{ color: 'var(--droid-link)' }}
        >
          {link ? <LinkBadge key={link.host} link={link} /> : null}
          <span
            className={`underline decoration-transparent underline-offset-2 transition-colors group-hover/link:decoration-current ${textIsUrl && !named ? 'break-all' : ''}`}
          >
            {/* A path used as a link label stays a plain pill: the link is the
                control, and a button cannot nest inside an anchor. */}
            {named ? link.label : <ProseFileLinks>{children}</ProseFileLinks>}
          </span>
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote
        className={`text-droid-text-secondary ${specMode ? 'border-l border-droid-border pl-4 py-0.5 my-4' : 'border-l-2 border-droid-border-hover pl-3.5 py-0.5 my-2.5'}`}
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
    ...markdownTableComponents(specMode),
  };
}

const REMARK_PLUGINS = [remarkGfm];
// For text the user typed line by line (their own messages, the composer
// preview): every Enter they pressed stays a visible break, the way GitHub
// renders issue comments, instead of collapsing into prose paragraphs.
const REMARK_BREAKS_PLUGINS = [remarkGfm, remarkBreaks];
const CHAT_COMPONENTS = createMarkdownComponents(false);
const SPEC_COMPONENTS = createMarkdownComponents(true);

// Chat text matches the composer's 14px, so a draft and the message it becomes
// read at the same size; 1.6 leading keeps paragraphs and lists close without
// crowding them.
export function markdownShellClass(specMode: boolean): string {
  return `md-shell min-w-0 max-w-full text-droid-text break-words ${specMode ? 'text-[15px] leading-[1.8] space-y-5' : 'text-[14px] leading-[1.6] space-y-2.5'}`;
}

export type MarkdownFenceFlags = Omit<FenceRenderOptions, 'appFences'>;

export function markdownFenceOptions(
  source: string,
  flags: MarkdownFenceFlags,
): FenceRenderOptions {
  return { ...flags, appFences: appFencesInMarkdown(source) };
}

export function MarkdownTree({
  children,
  specMode,
  fenceOptions,
  allowImages = true,
  breaks = false,
}: {
  children: string;
  specMode: boolean;
  fenceOptions: FenceRenderOptions;
  allowImages?: boolean;
  breaks?: boolean;
}) {
  return (
    <FenceOptionsContext.Provider value={fenceOptions}>
      <ReactMarkdown
        disallowedElements={allowImages ? undefined : ['img']}
        remarkPlugins={breaks ? REMARK_BREAKS_PLUGINS : REMARK_PLUGINS}
        components={specMode ? SPEC_COMPONENTS : CHAT_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </FenceOptionsContext.Provider>
  );
}

// One renderer for everything markdown in the app. `authored` is the only
// difference between a prompt the user typed and a model's reply: their Enters
// stay visible breaks, and their fences stay code instead of launching
// generated-content runtimes. Both sides then share the same typography,
// spacing, tables and code cards, so a sent message reads like the reply to it.
function MarkdownImpl({
  children,
  specMode = false,
  authored = false,
  allowImages = true,
  allowGeneratedContent = !authored,
  autoPlayAppBlocks = false,
  buildingAppBlocks = false,
  cutOffAppBlocks = false,
}: {
  children: string;
  specMode?: boolean;
  authored?: boolean;
  allowGeneratedContent?: boolean;
  allowImages?: boolean;
  autoPlayAppBlocks?: boolean;
  buildingAppBlocks?: boolean;
  cutOffAppBlocks?: boolean;
}) {
  const fenceOptions = markdownFenceOptions(children, {
    allowGeneratedContent,
    autoPlayAppBlocks,
    buildingAppBlocks,
    cutOffAppBlocks,
  });
  const tree = (
    <div className={markdownShellClass(specMode)}>
      <MarkdownTree
        specMode={specMode}
        fenceOptions={fenceOptions}
        allowImages={allowImages}
        breaks={authored}
      >
        {children}
      </MarkdownTree>
    </div>
  );
  // Text the user typed names files they already have in front of them, so a
  // prompt bubble stays reading matter: its mentions keep the plain pill.
  return authored ? <ProseFileLinks>{tree}</ProseFileLinks> : tree;
}

export const Markdown = memo(MarkdownImpl);
