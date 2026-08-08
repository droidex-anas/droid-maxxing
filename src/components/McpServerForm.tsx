import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { parseMcpVariables } from '../lib/mcpConfig';
import type { McpServerInput } from '../types/bridge';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AddMcpServerDialog({
  disabled,
  serverError,
  onCancel,
  onAdd,
}: {
  disabled: boolean;
  serverError?: string;
  onCancel: () => void;
  onAdd: (server: McpServerInput) => void;
}) {
  const [serverType, setServerType] = useState<'http' | 'sse' | 'stdio'>('http');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [argumentsText, setArgumentsText] = useState('');
  const [variablesText, setVariablesText] = useState('');
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !disabled) onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [disabled, onCancel]);

  const submit = () => {
    try {
      const pairs = parseMcpVariables(variablesText);
      if (!name.trim() || !location.trim()) throw new Error('Name and connection are required.');
      if (serverType === 'stdio') {
        onAdd({
          name: name.trim(),
          serverType,
          command: location.trim(),
          args: argumentsText
            .split('\n')
            .map((argument) => argument.trim())
            .filter(Boolean),
          env: pairs,
        });
      } else {
        onAdd({ name: name.trim(), serverType, url: location.trim(), headers: pairs });
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !disabled) onCancel();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-mcp-title"
        aria-describedby="add-mcp-description"
        aria-busy={disabled}
        tabIndex={-1}
        onKeyDown={trapTab}
        initial={{ y: 14, scale: 0.98, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 8, scale: 0.99, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="max-h-[calc(100vh-2rem)] w-full max-w-[620px] overflow-y-auto rounded-2xl border border-droid-border bg-droid-surface shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
      >
        <header className="flex items-start justify-between gap-5 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div>
            <h2
              id="add-mcp-title"
              className="text-[18px] font-semibold tracking-[-0.015em] text-droid-text"
            >
              Add MCP server
            </h2>
            <p
              id="add-mcp-description"
              className="mt-1 max-w-md text-[12px] leading-5 text-droid-text-secondary"
            >
              Saved to your Droid CLI user configuration and available to new DROIDEX sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            aria-label="Close add MCP server"
            className="rounded-lg p-2 text-droid-text-secondary transition-all duration-150 hover:bg-droid-elevated hover:text-droid-text active:scale-[0.96] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-y border-droid-border/70 px-5 py-5 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Field
              inputRef={nameRef}
              label="Name"
              value={name}
              onChange={setName}
              placeholder="sentry"
            />
            <label className="block text-[11.5px] font-medium text-droid-text-secondary">
              Type
              <select
                value={serverType}
                onChange={(event) => {
                  setServerType(serverTypeFromValue(event.target.value));
                }}
                className="mt-1.5 h-10 w-full rounded-xl border border-droid-border bg-droid-field px-3 text-[13px] text-droid-text outline-none transition-colors focus:border-droid-border-hover focus-visible:ring-1 focus-visible:ring-droid-accent/30"
              >
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
                <option value="stdio">Local command</option>
              </select>
            </label>
          </div>

          <div className="mt-4">
            <Field
              label={serverType === 'stdio' ? 'Command' : 'URL'}
              value={location}
              onChange={setLocation}
              placeholder={serverType === 'stdio' ? 'npx' : 'https://mcp.example.com/mcp'}
            />
          </div>

          {serverType === 'stdio' && (
            <TextAreaField
              label="Arguments"
              hint="One argument per line"
              value={argumentsText}
              onChange={setArgumentsText}
              placeholder={'-y\n@example/mcp'}
            />
          )}

          <TextAreaField
            label={serverType === 'stdio' ? 'Environment' : 'Headers'}
            hint="One KEY=VALUE per line"
            value={variablesText}
            onChange={setVariablesText}
          />

          {(error ?? serverError) && (
            <div role="alert" className="mt-3 text-[11.5px] text-droid-orange">
              {error ?? serverError}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 bg-droid-bg/30 px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-droid-text-secondary transition-all duration-150 hover:bg-droid-elevated/70 hover:text-droid-text active:scale-[0.97] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={submit}
            className="min-w-[104px] rounded-lg bg-droid-accent px-4 py-2 text-[12px] font-semibold text-droid-bg transition-all duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-40"
          >
            {disabled ? 'Adding…' : 'Add server'}
          </button>
        </footer>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function serverTypeFromValue(value: string): 'http' | 'sse' | 'stdio' {
  if (value === 'sse' || value === 'stdio') return value;
  return 'http';
}

function Field({
  inputRef,
  label,
  value,
  placeholder,
  onChange,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[11.5px] font-medium text-droid-text-secondary">
      {label}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="mt-1.5 h-10 w-full rounded-xl border border-droid-border bg-droid-field px-3 text-[13px] text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/70 focus:border-droid-border-hover focus-visible:ring-1 focus-visible:ring-droid-accent/30"
      />
    </label>
  );
}

function TextAreaField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="mt-4 block text-[11.5px] font-medium text-droid-text-secondary">
      {label} <span className="font-normal text-droid-text-muted">· {hint}</span>
      <textarea
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        rows={3}
        placeholder={placeholder}
        className="mt-1.5 w-full resize-none rounded-xl border border-droid-border bg-droid-field px-3 py-2.5 text-[12.5px] leading-5 text-droid-text outline-none transition-colors placeholder:text-droid-text-muted/70 focus:border-droid-border-hover focus-visible:ring-1 focus-visible:ring-droid-accent/30"
      />
    </label>
  );
}
