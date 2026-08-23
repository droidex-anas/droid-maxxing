import { useState } from 'react';

import { Markdown } from '../../../components/Markdown';
import type { PrCommentBlock } from '../lib/prCommentBody';
import { FoldChevron, PrCollapse } from './PrCollapse';

// Review bots hide their machine-readable prompts behind a disclosure on
// GitHub; the workspace keeps that contract instead of inlining the payload.
function Disclosure({ summary, body }: { summary: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-droid-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="group flex w-full items-center gap-1.5 bg-droid-elevated/40 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/70"
      >
        <FoldChevron open={open} />
        <span className="truncate text-[12.5px] text-droid-text-secondary">{summary}</span>
      </button>
      <PrCollapse open={open}>
        <div className="px-2.5 py-2 text-[13px] leading-[1.6] text-droid-text-secondary">
          <Markdown allowGeneratedContent={false}>{body}</Markdown>
        </div>
      </PrCollapse>
    </div>
  );
}

// A GitHub body: the pull request description and every comment share this
// renderer, because they are written and generated the same way.
export function PrBody({ blocks }: { blocks: readonly PrCommentBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'markdown' ? (
          <div
            key={index}
            className="mt-2 text-[13.5px] leading-[1.6] text-droid-text first:mt-0 [&_div]:!text-[13.5px] [&_div]:!leading-[1.6]"
          >
            <Markdown allowGeneratedContent={false}>{block.text}</Markdown>
          </div>
        ) : (
          <Disclosure key={index} summary={block.summary} body={block.body} />
        ),
      )}
    </>
  );
}
