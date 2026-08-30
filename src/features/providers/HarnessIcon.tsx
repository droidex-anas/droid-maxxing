import type { ProviderInstanceId } from '../../types/bridge';
import { ModelIcon } from '../../components/ModelIcon';
import { HARNESS_DISPLAY_NAME } from './harnessIdentity';

function CursorMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-droid-text"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M4.2 2.4 21.4 11a.9.9 0 0 1 .04 1.6L13.8 16.1 10.3 22.4a.9.9 0 0 1-1.66-.16L4.04 3.28A.9.9 0 0 1 4.2 2.4Z"
      />
    </svg>
  );
}

function GrokMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-droid-text"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M3 3h6.4L12 7.2 14.6 3H21l-6.6 9L21 21h-6.4L12 16.8 9.4 21H3l6.6-9z"
      />
    </svg>
  );
}

export function HarnessIcon({
  harness,
  size = 16,
}: {
  harness: ProviderInstanceId;
  size?: number;
}) {
  if (harness === 'droid') return <ModelIcon provider="factory" size={size} />;
  if (harness === 'codex') return <ModelIcon provider="openai" size={size} />;
  if (harness === 'claude') return <ModelIcon provider="anthropic" size={size} />;
  if (harness === 'cursor') return <CursorMark size={size} />;
  return <GrokMark size={size} />;
}

export function harnessLabel(harness: ProviderInstanceId): string {
  return HARNESS_DISPLAY_NAME[harness];
}
