import { memo, type ReactNode } from 'react';
import { StreamingCaret } from './StreamingCaret';
import { StreamingMarkdown } from './StreamingMarkdown';
import {
  childStreamPresentation,
  childStreamPreviewBoxClass,
  childStreamShowsCaret,
  type ChildStreamPresentation,
  type ChildStreamSnapshot,
} from '../lib/childSessionStream';

function StreamCaret({ show }: { show: boolean }): ReactNode {
  if (!show) return null;
  return (
    <span data-testid="subagent-stream-caret">
      <StreamingCaret />
    </span>
  );
}

function ObservedPreview({ snapshot }: { snapshot: ChildStreamSnapshot }): ReactNode {
  return (
    <div className="text-[12.5px] leading-5">
      <p
        data-testid="subagent-working-cue"
        className="shimmer-text font-medium text-droid-text-secondary"
      >
        {snapshot.step}…
      </p>
      {snapshot.preview ? (
        <p className="whitespace-pre-wrap break-words text-droid-text-muted">{snapshot.preview}</p>
      ) : null}
    </div>
  );
}

function TokenPreview({
  snapshot,
  cacheId,
  caret,
}: {
  snapshot: ChildStreamSnapshot;
  cacheId: string;
  caret: ReactNode;
}): ReactNode {
  if (snapshot.previewKind === 'markdown' && snapshot.preview) {
    return (
      <div className="text-[12.5px] leading-5 text-droid-text-secondary">
        <StreamingMarkdown
          source={snapshot.preview}
          live={snapshot.live}
          cacheId={cacheId}
          allowGeneratedContent={false}
        />
        {caret}
      </div>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-droid-text-muted">
      {snapshot.preview}
      {caret}
    </p>
  );
}

function previewBody(
  snapshot: ChildStreamSnapshot,
  presentation: ChildStreamPresentation,
  cacheId: string,
): ReactNode {
  if (presentation === 'working' || presentation === 'tool') {
    return <ObservedPreview snapshot={snapshot} />;
  }
  return (
    <TokenPreview
      snapshot={snapshot}
      cacheId={cacheId}
      caret={<StreamCaret show={childStreamShowsCaret(snapshot)} />}
    />
  );
}

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
  return (
    <div
      data-testid="subagent-stream-preview"
      data-preview-kind={snapshot.previewKind}
      data-presentation={presentation}
      data-stream-fidelity={snapshot.fidelity}
      className={childStreamPreviewBoxClass(expanded)}
    >
      {previewBody(snapshot, presentation, cacheId)}
    </div>
  );
});
