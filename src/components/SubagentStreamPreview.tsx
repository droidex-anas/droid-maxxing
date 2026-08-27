import { memo } from 'react';
import { StreamingCaret } from './StreamingCaret';
import { StreamingMarkdown } from './StreamingMarkdown';
import { childStreamPreviewBoxClass, type ChildStreamSnapshot } from '../lib/childSessionStream';

export const SubagentStreamPreview = memo(function SubagentStreamPreview({
  snapshot,
  expanded,
  cacheId,
}: {
  snapshot: ChildStreamSnapshot;
  expanded: boolean;
  cacheId: string;
}) {
  if (!snapshot.preview && !snapshot.live) return null;
  return (
    <div
      data-testid="subagent-stream-preview"
      data-preview-kind={snapshot.previewKind}
      className={childStreamPreviewBoxClass(expanded)}
    >
      {snapshot.previewKind === 'markdown' && snapshot.preview ? (
        <div className="text-[12.5px] leading-5 text-droid-text-secondary">
          <StreamingMarkdown
            source={snapshot.preview}
            live={snapshot.live}
            cacheId={cacheId}
            allowGeneratedContent={false}
          />
          {snapshot.live ? <StreamingCaret /> : null}
        </div>
      ) : (
        <p className="text-[12.5px] leading-5 text-droid-text-muted">
          {snapshot.preview}
          {snapshot.live ? <StreamingCaret /> : null}
        </p>
      )}
    </div>
  );
});
