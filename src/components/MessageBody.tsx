import { memo } from 'react';

import { hasAppBlock, hasCompleteAppBlock, hasIncompleteAppBlock } from './appBlockRuntime';
import { JsonRender, splitJsonRender, hasJsonRender } from './JsonRender';
import { StreamingMarkdown } from './StreamingMarkdown';
import { parseTruncatedTail } from '../lib/tools';

export const MessageBody = memo(function MessageBody({
  text,
  live,
  autoPlayAppBlocks,
  cacheId,
}: {
  text: string;
  live: boolean;
  autoPlayAppBlocks: boolean;
  cacheId: string;
}) {
  const { body, truncatedChars } = parseTruncatedTail(text);
  const hasCompleteApp = hasCompleteAppBlock(body);
  const buildingAppBlocks = live && hasAppBlock(body);
  const cutOffAppBlocks = !live && truncatedChars !== null && hasIncompleteAppBlock(body);
  const shouldAutoPlayAppBlocks = autoPlayAppBlocks && hasCompleteApp;
  if (!hasJsonRender(body)) {
    return (
      <StreamingMarkdown
        cacheId={cacheId}
        source={body}
        live={live}
        autoPlayAppBlocks={shouldAutoPlayAppBlocks}
        buildingAppBlocks={buildingAppBlocks}
        cutOffAppBlocks={cutOffAppBlocks}
      />
    );
  }
  const segments = splitJsonRender(body);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'json-render') return <JsonRender key={i} source={seg.value} />;
        if (!seg.value.trim()) return null;
        return (
          <StreamingMarkdown
            key={i}
            cacheId={`${cacheId}:${String(i)}`}
            source={seg.value}
            live={live}
            autoPlayAppBlocks={shouldAutoPlayAppBlocks}
            buildingAppBlocks={buildingAppBlocks}
            cutOffAppBlocks={cutOffAppBlocks}
          />
        );
      })}
    </>
  );
});
