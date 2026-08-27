import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { AppBlock } from './AppBlock';
import {
  Markdown,
  MarkdownTree,
  markdownFenceOptions,
  markdownShellClass,
  type MarkdownFenceFlags,
} from './Markdown';
import { CodeCard } from './MarkdownCode';
import {
  getSettledMarkdownElement,
  settledMarkdownCacheKey,
  settledMarkdownFlags,
} from '../lib/settledMarkdownCache';
import {
  ingestStreamingMarkdown,
  pendingFenceBody,
  type StreamingBlock,
  type StreamingDocument,
} from '../lib/streamingMarkdown';

export interface StreamingMarkdownProps {
  source: string;
  live: boolean;
  cacheId: string;
  specMode?: boolean;
  allowGeneratedContent?: boolean;
  autoPlayAppBlocks?: boolean;
  buildingAppBlocks?: boolean;
  cutOffAppBlocks?: boolean;
}

function useFrameThrottledValue<T>(value: T, enabled: boolean): T {
  const [shown, setShown] = useState(value);
  const pendingRef = useRef(value);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      setShown(value);
      return;
    }
    pendingRef.current = value;
    if (frameRef.current) return;
    if (typeof requestAnimationFrame !== 'function') {
      setShown(value);
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setShown(pendingRef.current);
    });
  }, [enabled, value]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return enabled ? shown : value;
}

function useStreamingDocument(source: string): StreamingDocument {
  const previousRef = useRef<{ source: string; document: StreamingDocument } | null>(null);
  const result = ingestStreamingMarkdown(previousRef.current, source);
  previousRef.current = { source, document: result.document };
  return result.document;
}

const FrozenMarkdownBlock = memo(function FrozenMarkdownBlock({
  block,
  specMode,
  allowGeneratedContent,
  autoPlayAppBlocks,
  cutOffAppBlocks,
}: {
  block: StreamingBlock;
  specMode: boolean;
  allowGeneratedContent: boolean;
  autoPlayAppBlocks: boolean;
  cutOffAppBlocks: boolean;
}) {
  const fenceOptions = useMemo(
    () =>
      markdownFenceOptions(block.source, {
        allowGeneratedContent,
        autoPlayAppBlocks,
        buildingAppBlocks: false,
        cutOffAppBlocks,
      }),
    [allowGeneratedContent, autoPlayAppBlocks, block.source, cutOffAppBlocks],
  );
  return (
    <MarkdownTree specMode={specMode} fenceOptions={fenceOptions}>
      {block.source}
    </MarkdownTree>
  );
});

function PendingFence({
  info,
  body,
  specMode,
  flags,
}: {
  info?: string;
  body: string;
  specMode: boolean;
  flags: MarkdownFenceFlags;
}) {
  if (flags.allowGeneratedContent && info === 'app') {
    return (
      <AppBlock
        source={body}
        autoPlay={false}
        isBuilding={flags.buildingAppBlocks}
        isCutOff={flags.cutOffAppBlocks}
      />
    );
  }
  return (
    <CodeCard code={body} className={info ? `language-${info}` : undefined} specMode={specMode} />
  );
}

function PendingMarkdown({
  source,
  kind,
  fenceInfo,
  specMode,
  flags,
}: {
  source: string;
  kind: StreamingDocument['pendingKind'];
  fenceInfo?: string;
  specMode: boolean;
  flags: MarkdownFenceFlags;
}) {
  if (kind === 'fence') {
    return (
      <PendingFence
        {...(fenceInfo !== undefined ? { info: fenceInfo } : {})}
        body={pendingFenceBody(source)}
        specMode={specMode}
        flags={flags}
      />
    );
  }
  const fenceOptions = markdownFenceOptions(source, flags);
  return (
    <MarkdownTree specMode={specMode} fenceOptions={fenceOptions}>
      {source}
    </MarkdownTree>
  );
}

function SettledMarkdown({
  source,
  cacheId,
  specMode,
  flags,
}: {
  source: string;
  cacheId: string;
  specMode: boolean;
  flags: MarkdownFenceFlags;
}) {
  const key = settledMarkdownCacheKey(
    cacheId,
    source,
    settledMarkdownFlags({
      specMode,
      allowGeneratedContent: flags.allowGeneratedContent,
      autoPlayAppBlocks: flags.autoPlayAppBlocks,
      cutOffAppBlocks: flags.cutOffAppBlocks,
    }),
  );
  return getSettledMarkdownElement(key, () => (
    <Markdown specMode={specMode} {...flags}>
      {source}
    </Markdown>
  ));
}

function LiveStreamingMarkdown({
  source,
  live,
  specMode,
  flags,
}: {
  source: string;
  live: boolean;
  specMode: boolean;
  flags: MarkdownFenceFlags;
}) {
  const shown = useFrameThrottledValue(source, live);
  const document = useStreamingDocument(shown);
  return (
    <div className={markdownShellClass(specMode)}>
      {document.completedBlocks.map((block) => (
        <FrozenMarkdownBlock
          key={block.id}
          block={block}
          specMode={specMode}
          allowGeneratedContent={flags.allowGeneratedContent}
          autoPlayAppBlocks={flags.autoPlayAppBlocks}
          cutOffAppBlocks={flags.cutOffAppBlocks}
        />
      ))}
      {document.pendingSource ? (
        <PendingMarkdown
          source={document.pendingSource}
          kind={document.pendingKind}
          {...(document.pendingFenceInfo !== undefined
            ? { fenceInfo: document.pendingFenceInfo }
            : {})}
          specMode={specMode}
          flags={flags}
        />
      ) : null}
    </div>
  );
}

function StreamingMarkdownImpl({
  source,
  live,
  cacheId,
  specMode = false,
  allowGeneratedContent = true,
  autoPlayAppBlocks = false,
  buildingAppBlocks = false,
  cutOffAppBlocks = false,
}: StreamingMarkdownProps) {
  const flags: MarkdownFenceFlags = {
    allowGeneratedContent,
    autoPlayAppBlocks,
    buildingAppBlocks,
    cutOffAppBlocks,
  };
  const streamedOnThisMount = useRef(live);
  if (live) streamedOnThisMount.current = true;
  // Historical rows use the settled LRU. A row that streamed on this mount keeps
  // its frozen block instances so mermaid/images/apps do not remount on settle.
  if (!live && !streamedOnThisMount.current) {
    return <SettledMarkdown source={source} cacheId={cacheId} specMode={specMode} flags={flags} />;
  }
  return <LiveStreamingMarkdown source={source} live={live} specMode={specMode} flags={flags} />;
}

export const StreamingMarkdown = memo(StreamingMarkdownImpl);
