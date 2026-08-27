import { memo } from 'react';
import { StreamingCaret } from './StreamingCaret';
import { StreamingMarkdown } from './StreamingMarkdown';
import {
  childStreamPresentation,
  childStreamPreviewBoxClass,
  childStreamShowsCaret,
  type ChildStreamSnapshot,
} from '../lib/childSessionStream';

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
  const presentation = childStreamPresentation(snapshot);
  const caret = childStreamShowsCaret(snapshot) ? (
    <span data-testid="subagent-stream-caret">
      <StreamingCaret />
    </span>
  ) : null;
  return (
    <div
      data-testid="subagent-stream-preview"
      data-preview-kind={snapshot.previewKind}
      data-presentation={presentation}
      data-stream-fidelity={snapshot.fidelity}
      className={childStreamPreviewBoxClass(expanded)}
    >
      {presentation === 'working' || presentation === 'tool' ? (
        <div className="text-[12.5px] leading-5">
          <p
            data-testid="subagent-working-cue"
            className="shimmer-text font-medium text-droid-text-secondary"
          >
            {snapshot.step}…
          </p>
          {snapshot.preview ? (
            <p className="text-droid-text-muted whitespace-pre-wrap break-words">
              {snapshot.preview}
            </p>
          ) : null}
        </div>
      ) : snapshot.previewKind === 'markdown' && snapshot.preview ? (
        <div className="text-[12.5px] leading-5 text-droid-text-secondary">
          <StreamingMarkdown
            source={snapshot.preview}
            live={snapshot.live && presentation === 'typewriter'}
            cacheId={cacheId}
            allowGeneratedContent={false}
          />
          {caret}
        </div>
      ) : (
        <p className="text-[12.5px] leading-5 text-droid-text-muted whitespace-pre-wrap break-words">
          {snapshot.preview}
          {caret}
        </p>
      )}
    </div>
  );
});
