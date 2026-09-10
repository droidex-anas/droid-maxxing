import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Blocks, MousePointer2, PenLine } from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../../types/bridge';
import { ImageAttachmentChip } from '../media/ImageAttachmentChip';
import { FileChip } from '../composer/FileChip';
import { isImagePath } from '../../lib/localImage';
import { promptDisplayParts } from '../../lib/composePrompt';
import { userMessageAttachments } from '../../lib/promptMentions';
import { VisualizeIcon } from '../icons/VisualizeIcon';
import { Markdown } from '../Markdown';
import { CopyButton } from './primitives';

function BrowserReferenceChip({ reference }: { reference: BrowserTranscriptReference }) {
  const Icon = reference.kind === 'element' ? MousePointer2 : PenLine;
  return (
    <span
      title={
        reference.selector
          ? `${reference.selector}\n${reference.url ?? ''}`
          : (reference.url ?? `Design reference: ${reference.label}`)
      }
      className="flex min-w-0 items-center gap-1.5 rounded-lg bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-text ring-1 ring-inset ring-droid-accent/30"
    >
      {reference.imageDataUrl ? (
        <img
          src={reference.imageDataUrl}
          alt={reference.label}
          className="h-5 max-w-12 rounded-sm object-cover"
        />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-droid-accent" />
      )}
      <span className="max-w-40 truncate">@{reference.label}</span>
    </span>
  );
}

function PromptChip({
  icon: Icon,
  label,
  title,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  title?: string;
}) {
  return (
    <span
      title={title ?? label}
      className="inline-flex items-center gap-1.5 font-medium text-droid-skill"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}

// The clamp is measured in whole rendered lines so it never slices through the
// middle of one, and it only engages when there is a meaningful amount to hide.
const PROMPT_LINE_PX = 22.4; // 14px text at 1.6 leading, matching the markdown shell
const PROMPT_CLAMP_LINES = 16;
const PROMPT_CLAMP_PX = PROMPT_LINE_PX * PROMPT_CLAMP_LINES;

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      className={`h-3 w-3 transition-transform duration-200 ${up ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-full border border-droid-border bg-droid-surface px-2.5 py-1 text-[11px] font-medium text-droid-text-secondary shadow-sm transition-colors hover:border-droid-border-hover hover:text-droid-text"
    >
      {expanded ? 'Show less' : 'Show more'}
      <Chevron up={expanded} />
    </button>
  );
}

function ClampedPrompt({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The cap lives on the outer box, so the inner box always reports the real
  // content height, including when an image or code card settles later. The
  // observer hands over a height the browser has already laid out, so a
  // transcript mounting many prompts never forces a synchronous layout for
  // each one. `flow-root` keeps the last child's margin inside that height: a
  // reading even a pixel short would slice the final line once expanded.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(([entry]) => {
      setContentHeight(Math.ceil(entry.contentRect.height));
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Capped until measured, so a long prompt is short from its first paint
  // instead of drawn at full height and then collapsed. Once measured, one line
  // of slack: a prompt that only just overflows shows in full rather than
  // hiding a single line behind a control.
  const clamped = contentHeight !== null && contentHeight > PROMPT_CLAMP_PX + PROMPT_LINE_PX;
  let maxHeight: number | undefined;
  if (contentHeight === null) maxHeight = PROMPT_CLAMP_PX;
  else if (clamped) maxHeight = expanded ? contentHeight : PROMPT_CLAMP_PX;

  return (
    <div className="relative w-full min-w-0">
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-out motion-reduce:transition-none"
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        <div ref={contentRef} className="flow-root">
          <Markdown authored>{source}</Markdown>
        </div>
      </div>
      {clamped && !expanded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-droid-elevated via-droid-elevated/90 to-transparent">
          <div className="pointer-events-auto">
            <ExpandButton
              expanded={false}
              onClick={() => {
                setExpanded(true);
              }}
            />
          </div>
        </div>
      )}
      {clamped && expanded && (
        <div className="mt-2 flex justify-center">
          <ExpandButton
            expanded
            onClick={() => {
              setExpanded(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function UserBubble({
  event,
}: {
  event: Pick<TranscriptEvent, 'text' | 'skills' | 'files' | 'browserRefs' | 'steered'>;
}) {
  const browserRefs = event.browserRefs ?? [];
  // A replayed message has no files metadata, only the composed text it was sent
  // as, so attachments are recovered from its trailing @mention block.
  const message = userMessageAttachments(event.text, event.files);
  const display = promptDisplayParts(message.text, event.skills);
  const hasAttachments = message.files.length > 0 || browserRefs.length > 0;
  const hasPrompt = Boolean(display.text) || display.skills.length > 0 || display.visualize;
  return (
    <div className="group/msg flex flex-col items-end gap-1.5">
      {event.steered && (
        <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
          <svg
            className="h-3 w-3"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
          Steered the conversation
        </span>
      )}
      {hasAttachments && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {browserRefs.map((reference) => (
            <BrowserReferenceChip key={`${reference.kind}:${reference.id}`} reference={reference} />
          ))}
          {message.files.map((f) =>
            isImagePath(f) ? (
              <ImageAttachmentChip key={f} path={f} />
            ) : (
              <FileChip key={f} path={f} />
            ),
          )}
        </div>
      )}
      {hasPrompt && (
        <div className="flex min-w-0 max-w-[80%] flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-[1.6] text-droid-text">
          {display.visualize && <PromptChip icon={VisualizeIcon} label="Visualize" />}
          {display.skills.map((skill) => (
            <PromptChip key={skill} icon={Blocks} label={skill} title={`Skill: ${skill}`} />
          ))}
          {display.text ? (
            <div className="w-full min-w-0">
              <ClampedPrompt source={display.text} />
            </div>
          ) : null}
        </div>
      )}
      {message.text ? (
        <div className="-mr-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={message.text} />
        </div>
      ) : null}
    </div>
  );
}
