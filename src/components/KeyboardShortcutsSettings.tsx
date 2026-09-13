// Settings → Keyboard. One row per rebindable app action; the bindings
// themselves live in lib/shortcuts.

import { useEffect, useState } from 'react';
import { useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import {
  PRIMARY_MODIFIER_LABEL,
  SHORTCUT_DEFINITIONS,
  chordFromEvent,
  conflictingActions,
  defaultChordFor,
  formatChord,
  serializeChord,
  type ShortcutAction,
} from '../lib/shortcuts';
import { SectionTitle, SettingRow } from './settingsKit';

export function KeyboardShortcutsSettings() {
  const dispatch = useStoreDispatch();
  const bindings = useStoreSelector((state) => state.shortcutBindings);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    // Capture phase on window: the chord being recorded must not reach the
    // app's own shortcut handler or the settings panel's Escape listener.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        dispatch({
          type: 'SET_SHORTCUT_BINDING',
          shortcut: capturing,
          chord: defaultChordFor(capturing),
        });
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(event);
      // Keep listening for modifier-only presses, and for chords the window
      // handler could never see: it ignores anything without the primary
      // modifier so plain typing stays plain typing.
      if (!chord?.meta) return;
      dispatch({ type: 'SET_SHORTCUT_BINDING', shortcut: capturing, chord: serializeChord(chord) });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [capturing, dispatch]);

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle
        title="Keyboard"
        sub={`Press a new chord after choosing Change. Escape cancels, Delete restores the default. Every shortcut needs ${PRIMARY_MODIFIER_LABEL}.`}
      />
      <div className="overflow-hidden rounded-2xl border border-droid-border/80 bg-droid-surface">
        {SHORTCUT_DEFINITIONS.map((definition, index) => {
          const active = capturing === definition.action;
          const conflicts = conflictingActions(bindings, definition.action);
          return (
            <div
              key={definition.action}
              className={index > 0 ? 'border-t border-droid-border/50' : ''}
            >
              <SettingRow
                label={definition.label}
                description={
                  conflicts.length > 0 ? (
                    <span className="text-droid-orange">
                      Also bound to {conflicts.map((other) => other.label).join(', ')}.
                    </span>
                  ) : undefined
                }
              >
                <div className="flex shrink-0 items-center gap-2">
                  <kbd
                    className={`min-w-[52px] rounded-md px-2 py-1 text-center font-mono text-[11px] ${
                      active
                        ? 'bg-droid-elevated text-droid-text ring-1 ring-inset ring-droid-border-hover'
                        : 'bg-droid-elevated text-droid-text-muted'
                    }`}
                  >
                    {active ? 'Press…' : formatChord(bindings[definition.action])}
                  </kbd>
                  <button
                    type="button"
                    aria-label={`Change the ${definition.label.toLowerCase()} shortcut`}
                    onClick={() => {
                      setCapturing(active ? null : definition.action);
                    }}
                    className="rounded-xl bg-droid-elevated/80 px-3 py-1.5 text-[12px] font-medium text-droid-text transition-colors hover:bg-droid-elevated"
                  >
                    {active ? 'Cancel' : 'Change'}
                  </button>
                </div>
              </SettingRow>
            </div>
          );
        })}
      </div>
    </div>
  );
}
