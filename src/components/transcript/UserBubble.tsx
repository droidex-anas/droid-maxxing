import type { ComponentType } from 'react';
import { Blocks, MousePointer2, PenLine } from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../../types/bridge';
import type { OpenReviewFileHandler } from '../../lib/reviewFocus';
import { ImageAttachmentChip } from '../media/ImageAttachmentChip';
import { FileChip } from '../composer/FileChip';
import { isImagePath } from '../../lib/localImage';
import { promptDisplayParts } from '../../lib/composePrompt';
import { userMessageAttachments } from '../../lib/promptMentions';
import { VisualizeIcon } from '../icons/VisualizeIcon';
import { Markdown } from '../Markdown';
import { ClampedReveal } from '../ClampedReveal';
import { MessageActions } from './primitives';

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

// Long prompts clamp to 16 lines of 14px text at 1.6 leading, matching the
// markdown shell; the fade lands on the bubble's elevated surface.
const PROMPT_LINE_PX = 22.4;
const PROMPT_CLAMP_PX = PROMPT_LINE_PX * 16;

export function UserBubble({
  event,
  onOpenReviewFile,
}: {
  event: Pick<TranscriptEvent, 'text' | 'skills' | 'files' | 'browserRefs' | 'steered'>;
  onOpenReviewFile?: OpenReviewFileHandler;
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
        <span className="flex items-center gap-1 text-[11px] font-medium tracking-wide text-droid-text-muted">
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
              <FileChip
                key={f}
                path={f}
                {...(onOpenReviewFile
                  ? {
                      onOpen: () => {
                        onOpenReviewFile(f);
                      },
                    }
                  : {})}
              />
            ),
          )}
        </div>
      )}
      {hasPrompt && (
        // The bubble's actions float in the free space to its left, so a prompt
        // row is exactly its bubble: no reserved action row under it.
        <div className="relative min-w-0 max-w-[80%]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-[1.6] text-droid-text">
            {display.visualize && <PromptChip icon={VisualizeIcon} label="Visualize" />}
            {display.skills.map((skill) => (
              <PromptChip key={skill} icon={Blocks} label={skill} title={`Skill: ${skill}`} />
            ))}
            {display.text ? (
              <div className="w-full min-w-0">
                <ClampedReveal
                  clampPx={PROMPT_CLAMP_PX}
                  linePx={PROMPT_LINE_PX}
                  fadeClassName="from-droid-elevated via-droid-elevated/90"
                >
                  <Markdown authored>{display.text}</Markdown>
                </ClampedReveal>
              </div>
            ) : null}
          </div>
          {message.text ? <MessageActions text={message.text} side="start" /> : null}
        </div>
      )}
    </div>
  );
}
