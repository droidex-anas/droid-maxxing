import './capture.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Plus, Scan, Trash2 } from 'lucide-react';
import { Dropdown, GroupLabel, SectionTitle, SettingRow } from '../../components/settingsKit';
import { Switch } from '../../components/Switch';
import { toast } from '../../lib/toast';
import {
  captureApi,
  type CapturePreferences,
  type CaptureRecord,
  type CaptureStatus,
} from './types';
import { StyleControls } from './StyleControls';
import { attachRecentCapture } from './composerDestination';
import CaptureDialog from './CaptureDialog';

function RecentThumbnail({ record, onOpen }: { record: CaptureRecord; onOpen: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void captureApi()
      .thumbnail(record.id)
      .then((value) => {
        if (!cancelled) setSource(value);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, record.revision]);
  return (
    <button
      type="button"
      className="capture-recent-thumbnail"
      onClick={onOpen}
      aria-label={`Edit ${record.title}`}
    >
      {source ? (
        <img src={source} alt={record.title} loading="lazy" />
      ) : (
        <span>
          <Scan size={24} />
          <span>Original saved · Open to edit</span>
        </span>
      )}
    </button>
  );
}
export function CaptureSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [draft, setDraft] = useState<CapturePreferences | null>(null);
  const [records, setRecords] = useState<CaptureRecord[]>([]);
  const [editor, setEditor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const records = await captureApi().list();
    if (alive.current) setRecords(records);
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!window.droidCapture) {
      setError('Screenshot settings need the DROIDEX desktop app');
      return () => {
        alive.current = false;
      };
    }
    void Promise.all([captureApi().preferences(), captureApi().list()])
      .then(([current, list]) => {
        if (alive.current) {
          setStatus(current);
          setDraft(current.preferences);
          setRecords(list);
        }
      })
      .catch((reason: unknown) => {
        if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Capture action failed');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function saveDefaults() {
    if (!draft) return;
    const next = await captureApi().setPreferences(draft);
    if (alive.current) {
      setStatus(next);
      setDraft(next.preferences);
      toast.success('Screenshot defaults saved');
    }
  }
  async function attach(id: string) {
    await attachRecentCapture(id);
    onClose();
  }
  const dirty = draft && status && JSON.stringify(draft) !== JSON.stringify(status.preferences);
  return (
    <div className="max-w-3xl mx-auto capture-settings">
      <SectionTitle
        title="Screenshots"
        sub="Capture a component, frame it beautifully, and bring it straight back to your draft."
      />
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      {draft ? (
        <>
          <GroupLabel>Default presentation</GroupLabel>
          <div className="rounded-xl border border-droid-border bg-droid-surface p-5 mb-5">
            <StyleControls
              value={draft.style}
              disabled={busy}
              onChange={(style) => {
                setDraft({ ...draft, style });
              }}
            />
            <p className="capture-note">
              Used for every new capture until you change it. Editing a recent screenshot does not
              change your default.
            </p>
          </div>
          <GroupLabel>Capture behavior</GroupLabel>
          <div className="rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border mb-4">
            <SettingRow
              label="Intelligent selection assistance"
              description="Suggest panel boundaries while refining screenshots. Live Droidex components use their actual UI bounds. Suggestions stay editable."
            >
              <Switch
                label="Intelligent selection assistance"
                checked={draft.smartSelection}
                disabled={busy}
                onChange={(smartSelection) => {
                  setDraft({ ...draft, smartSelection });
                }}
              />
            </SettingRow>
            <SettingRow
              label="Calm capture click"
              description="A short, quiet click after a successful capture. Never on cancellation."
            >
              <Switch
                label="Calm capture click"
                checked={draft.sound}
                disabled={busy}
                onChange={(sound) => {
                  setDraft({ ...draft, sound });
                }}
              />
            </SettingRow>
            <SettingRow
              label="Global screenshot shortcut"
              description="Opens Capture for the active chat. The macOS screenshot shortcuts are left unchanged."
            >
              <Dropdown
                ariaLabel="Global screenshot shortcut"
                value={draft.shortcut}
                options={[
                  { value: '', label: 'Disabled' },
                  { value: 'CommandOrControl+Shift+2', label: '⌘/Ctrl + Shift + 2' },
                  { value: 'CommandOrControl+Shift+6', label: '⌘/Ctrl + Shift + 6' },
                  { value: 'CommandOrControl+Shift+9', label: '⌘/Ctrl + Shift + 9' },
                ]}
                onChange={(shortcut) => {
                  setDraft({ ...draft, shortcut });
                }}
              />
            </SettingRow>
          </div>
          {status?.preferences.shortcut && !status.shortcutRegistered && (
            <p role="status" className="capture-note">
              That shortcut could not be registered. Another app may be using it; choose a different
              shortcut. The composer button still works.
            </p>
          )}
          <div className="capture-settings-save">
            <button
              type="button"
              className="capture-button capture-primary"
              disabled={!dirty || busy}
              onClick={() => void run(saveDefaults)}
            >
              {busy ? 'Saving…' : 'Save defaults'}
            </button>
          </div>
        </>
      ) : (
        !error && (
          <p role="status" className="capture-note">
            Loading screenshot settings…
          </p>
        )
      )}
      <div className="capture-recent-heading">
        <div>
          <GroupLabel>Recent captures</GroupLabel>
          <p className="capture-note">
            Stored only on this Mac. Up to 30 captures, 30 days, or 512 MiB. Original captures may
            contain content outside your edited crop. Deleting a capture removes its original and
            edits, not copies already attached to chats.
          </p>
        </div>
        <button
          type="button"
          className="capture-button"
          disabled={!status || busy}
          onClick={() => {
            setEditor('new');
          }}
        >
          <Plus size={15} />
          Capture
        </button>
      </div>
      {records.length === 0 ? (
        <div className="capture-empty">
          <Scan size={28} />
          <h3>Your next capture starts here</h3>
          <p>
            Use the Screenshot action in the composer, or import an image through Capture. Recent
            originals stay available for another edit.
          </p>
        </div>
      ) : (
        <div className="capture-recents">
          {records.map((record) => (
            <article key={record.id} className="capture-recent-card">
              <RecentThumbnail
                record={record}
                onOpen={() => {
                  setEditor(record.id);
                }}
              />
              <div className="capture-recent-details">
                <strong title={record.title}>{record.title}</strong>
                <span>
                  {new Date(record.createdAt).toLocaleString()} · {record.width} × {record.height}{' '}
                  original
                </span>
                <div className="capture-recent-actions">
                  <button
                    type="button"
                    className="capture-button"
                    onClick={() => {
                      setEditor(record.id);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="capture-icon"
                    title="Copy PNG"
                    aria-label={`Copy ${record.title}`}
                    disabled={busy || !record.hasExport}
                    onClick={() =>
                      void run(async () => {
                        await captureApi().copy(record.id);
                        toast.success('Full-resolution capture copied');
                      })
                    }
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className="capture-icon"
                    title="Save PNG"
                    aria-label={`Export ${record.title}`}
                    disabled={busy || !record.hasExport}
                    onClick={() =>
                      void run(async () => {
                        await captureApi().export(record.id);
                      })
                    }
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    className="capture-button"
                    disabled={busy || !record.hasExport}
                    onClick={() => void run(() => attach(record.id))}
                  >
                    Attach
                  </button>
                  <button
                    type="button"
                    className="capture-icon"
                    title="Delete original and edits"
                    aria-label={`Delete ${record.title}`}
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Delete this capture and its original? Copies already attached to chats will stay.',
                        )
                      )
                        void run(async () => {
                          await captureApi().delete(record.id);
                          await refresh();
                        });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {editor && (
        <CaptureDialog
          captureId={editor === 'new' ? undefined : editor}
          onClose={() => {
            setEditor(null);
            void refresh().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
          onAttach={editor === 'new' ? undefined : attach}
          onSaved={() => {
            void refresh().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        />
      )}
    </div>
  );
}
