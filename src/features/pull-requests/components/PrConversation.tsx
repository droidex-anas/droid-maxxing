import type { ReactNode } from 'react';

import { PrComposer } from './PrComposer';

// The scrolling half of the workspace: whatever the tab wants to show, with the
// comment composer pinned below it. Content ownership stays with the caller so
// the summary tab can fold its sections and the chat tab can stay plain.
export function PrConversation({
  children,
  viewerLogin,
  draft,
  posting,
  onDraftChange,
  onSubmit,
}: {
  children: ReactNode;
  viewerLogin: string | null;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="pr-workspace-scroll min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-6">
        {children}
      </div>
      <div className="px-8 pb-5">
        <PrComposer
          viewerLogin={viewerLogin}
          draft={draft}
          posting={posting}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
