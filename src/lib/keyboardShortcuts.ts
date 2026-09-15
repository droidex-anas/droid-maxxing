type ShortcutEvent = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>;

function isMod(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return event.metaKey || event.ctrlKey;
}

export function isTerminalTabShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'key'>): boolean {
  return event.ctrlKey && event.key === '`';
}

function targetWithin(target: EventTarget | null, selector: string): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === 'function' && Boolean(closest.call(target, selector));
}

export function isTerminalInputTarget(target: EventTarget | null): boolean {
  return targetWithin(target, '[data-terminal-input]');
}

export function isSpecOutlineFindTarget(target: EventTarget | null): boolean {
  return targetWithin(target, '[data-spec-outline]');
}

// The docked spec reader owns Cmd/Ctrl+F (its outline jump menu) whenever the
// event originates inside the reader, so transcript find stays out of the way.
export function isSpecReaderFindTarget(target: EventTarget | null): boolean {
  return targetWithin(target, '[data-spec-reader]');
}

// Cmd/Ctrl+F without Shift. Shift+Cmd/Ctrl+F already opens the Files pane.
export function isTranscriptFindShortcut(event: ShortcutEvent): boolean {
  return isMod(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

export function isTranscriptFindNextShortcut(event: ShortcutEvent): boolean {
  if (event.key === 'F3' && !event.shiftKey && !event.altKey) return true;
  return isMod(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'g';
}

export function isTranscriptFindPreviousShortcut(event: ShortcutEvent): boolean {
  if (event.key === 'F3' && event.shiftKey && !event.altKey) return true;
  return isMod(event) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'g';
}

export function shouldOpenTranscriptFind(
  event: ShortcutEvent,
  target: EventTarget | null,
  specOutlineOpen: boolean,
): boolean {
  if (!isTranscriptFindShortcut(event)) return false;
  if (isTerminalInputTarget(target)) return false;
  if (isSpecOutlineFindTarget(target) || isSpecReaderFindTarget(target)) return false;
  return !specOutlineOpen;
}
