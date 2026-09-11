import { useEffect, useState } from 'react';
import { Code, FolderOpen, Terminal } from 'lucide-react';

import { editorIcon } from '../lib/desktop';
import type { EditorId } from '../lib/editorOpen';

// The installed application's own icon, asked for once per launch target and
// kept for the life of the window so reopening the menu never flickers.
const iconsByEditor = new Map<EditorId, string | null>();
const pendingByEditor = new Map<EditorId, Promise<string | null>>();

function loadIcon(editor: EditorId): Promise<string | null> {
  let pending = pendingByEditor.get(editor);
  if (!pending) {
    pending = editorIcon(editor).then((icon) => {
      iconsByEditor.set(editor, icon);
      return icon;
    });
    pendingByEditor.set(editor, pending);
  }
  return pending;
}

// Outside the desktop app, and for the rare machine whose bundle cannot be
// read, a neutral glyph for what the target does — never a drawn brand mark.
const FALLBACK: Record<EditorId, typeof Code> = {
  vscode: Code,
  cursor: Code,
  xcode: Code,
  finder: FolderOpen,
  terminal: Terminal,
};

export function EditorIcon({ editor, size = 16 }: { editor: EditorId; size?: number }) {
  const [icon, setIcon] = useState<string | null>(() => iconsByEditor.get(editor) ?? null);

  useEffect(() => {
    let cancelled = false;
    setIcon(iconsByEditor.get(editor) ?? null);
    void loadIcon(editor).then((found) => {
      if (!cancelled) setIcon(found);
    });
    return () => {
      cancelled = true;
    };
  }, [editor]);

  if (icon) return <img src={icon} width={size} height={size} alt="" className="shrink-0" />;

  const Glyph = FALLBACK[editor];
  return <Glyph size={size} className="shrink-0 text-droid-text-muted" aria-hidden />;
}
