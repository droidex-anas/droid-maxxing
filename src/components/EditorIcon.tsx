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
    const request = editorIcon(editor).then((icon) => {
      // Only a real icon is kept; a failed read is asked again next time,
      // as the main process does, instead of pinning the fallback glyph.
      if (icon) iconsByEditor.set(editor, icon);
      else if (pendingByEditor.get(editor) === request) pendingByEditor.delete(editor);
      return icon;
    });
    pending = request;
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
  // Keyed by editor so a menu switching targets never paints the previous
  // target's icon for the render before the effect below catches up.
  const [loaded, setLoaded] = useState(() => ({ editor, icon: iconsByEditor.get(editor) ?? null }));
  const icon = loaded.editor === editor ? loaded.icon : (iconsByEditor.get(editor) ?? null);

  useEffect(() => {
    let cancelled = false;
    void loadIcon(editor).then((found) => {
      if (!cancelled) setLoaded({ editor, icon: found });
    });
    return () => {
      cancelled = true;
    };
  }, [editor]);

  if (icon) return <img src={icon} width={size} height={size} alt="" className="shrink-0" />;

  const Glyph = FALLBACK[editor];
  return <Glyph size={size} className="shrink-0 text-droid-text-muted" aria-hidden />;
}
