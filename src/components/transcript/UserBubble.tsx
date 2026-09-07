import { FileText, MousePointer2, PenLine } from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../../types/bridge';
import { ImageAttachmentChip } from '../media/ImageAttachmentChip';
import { isImagePath } from '../../lib/localImage';
import { userMessageAttachments } from '../../lib/promptMentions';
import { pathFileName } from '../../lib/pathDisplay';
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

export function UserBubble({
  event,
}: {
  event: Pick<TranscriptEvent, 'text' | 'skills' | 'files' | 'browserRefs' | 'steered'>;
}) {
  const skills = event.skills ?? [];
  const browserRefs = event.browserRefs ?? [];
  // A replayed message has no files metadata, only the composed text it was sent
  // as, so attachments are recovered from its trailing @mention block.
  const message = userMessageAttachments(event.text, event.files);
  const images = message.files.filter((f) => isImagePath(f));
  const files = message.files.filter((f) => !isImagePath(f));
  const hasAttachments = message.files.length > 0 || browserRefs.length > 0;
  return (
    <div className="group/msg flex flex-col items-end gap-1.5 py-1">
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
          {images.map((f) => (
            <ImageAttachmentChip key={f} path={f} />
          ))}
          {files.map((f) => (
            <span
              key={f}
              title={f}
              className="flex items-center gap-1 rounded-lg border border-droid-border bg-droid-elevated/80 px-2 py-1 text-[11px] text-droid-text-secondary"
            >
              <FileText className="h-3 w-3 text-droid-text-muted" />
              {pathFileName(f)}
            </span>
          ))}
        </div>
      )}
      {(message.text || skills.length > 0) && (
        <div className="flex max-w-[80%] flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-relaxed text-droid-text">
          {skills.map((skill) => (
            <span key={skill} title={`Skill: ${skill}`} className="font-medium text-droid-skill">
              {skill}
            </span>
          ))}
          {message.text && <span className="whitespace-pre-wrap break-words">{message.text}</span>}
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
