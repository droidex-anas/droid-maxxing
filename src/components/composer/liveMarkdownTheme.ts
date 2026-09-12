// How the composer's live markdown looks. The class names come from
// liveMarkdownDecorations; the sizes and weights mirror the transcript's
// rendered markdown so a draft previews the message it will become.

import { EditorView } from '@codemirror/view';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// Tints are mixed from the text colour rather than white so they hold up on
// light themes as well as dark ones.
const textTint = (pct: number) =>
  `color-mix(in srgb, var(--droid-text) ${String(pct)}%, transparent)`;

export const liveMarkdownTheme = EditorView.theme({
  '&': { fontSize: '14px', minHeight: '44px', maxHeight: '200px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': {
    fontFamily: 'inherit',
    padding: '12px 16px 10px calc(16px + var(--composer-indent, 0px))',
    caretColor: 'var(--droid-accent)',
  },
  // CodeMirror ships a fixed #888 placeholder, which is unreadable on a light
  // canvas; the muted token is derived to stay legible in either scheme.
  '.cm-placeholder': { color: 'var(--droid-text-muted)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--droid-accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: textTint(14),
  },
  '.cm-md-strong': { fontWeight: '600' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through', opacity: '0.65' },
  '.cm-md-code': {
    fontFamily: MONO,
    fontSize: '12px',
    background: textTint(8),
    borderRadius: '5px',
    padding: '1px 5px',
  },
  // Links read by colour, as in the transcript; the underline shows on hover.
  '.cm-md-link, .cm-md-url': {
    color: 'var(--droid-link)',
    textDecoration: 'underline',
    textDecorationColor: 'transparent',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-md-link:hover, .cm-md-url:hover': { textDecorationColor: 'currentColor' },
  '.cm-md-h1': { fontSize: '19px', fontWeight: '600', lineHeight: '26px' },
  '.cm-md-h2': { fontSize: '16px', fontWeight: '600', lineHeight: '24px' },
  '.cm-md-h3': { fontSize: '15px', fontWeight: '600', lineHeight: '22px' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontWeight: '600' },
  '.cm-md-quote': {
    color: 'var(--droid-text-secondary)',
    fontStyle: 'italic',
    borderLeft: '2px solid var(--droid-border-hover)',
    paddingLeft: '8px',
  },
  '.cm-md-codeline': {
    fontFamily: MONO,
    fontSize: '12px',
    background: textTint(4),
  },
  '.cm-md-fence': { color: 'var(--droid-text-muted)' },
  // A block marker showing on the caret's own line: visible enough to see and
  // delete, quiet enough that the content still reads as the message.
  '.cm-md-marker': { color: 'var(--droid-text-muted)', fontWeight: '400' },
  '.cm-md-listmark': { color: 'var(--droid-accent)', fontWeight: '600' },
  '.cm-md-task': { color: 'var(--droid-text-muted)' },
  '.cm-md-task-done': { color: 'var(--droid-accent)', fontWeight: '600' },
  // Monospace keeps a table's pipes in a column while it is being edited; away
  // from the caret the block is drawn as the table it will become.
  '.cm-md-table': { fontFamily: MONO, fontSize: '12px' },
  '.cm-md-tablehead': { fontWeight: '600' },
  '.cm-md-tableframe': {
    margin: '6px 0',
    maxWidth: '100%',
    overflowX: 'auto',
    border: '1px solid var(--droid-border-hover)',
    borderRadius: '10px',
    cursor: 'text',
    padding: '1px',
  },
  '.cm-md-tableframe table': {
    minWidth: '100%',
    borderCollapse: 'collapse',
    fontSize: '12.5px',
  },
  '.cm-md-tableframe th, .cm-md-tableframe td': { outline: 'none' },
  '.cm-md-tableframe th:focus, .cm-md-tableframe td:focus': {
    background: 'color-mix(in srgb, var(--droid-link) 14%, transparent)',
  },
  '.cm-md-tableframe th': {
    padding: '5px 10px',
    textAlign: 'left',
    fontWeight: '600',
    whiteSpace: 'nowrap',
    color: 'var(--droid-text)',
    background: textTint(4),
    borderBottom: '1px solid var(--droid-border-hover)',
  },
  '.cm-md-tableframe td': {
    padding: '5px 10px',
    verticalAlign: 'top',
    color: 'var(--droid-text-secondary)',
    borderTop: '1px solid var(--droid-border)',
  },
  '.cm-md-tableframe tbody tr:nth-child(even)': { background: textTint(2) },
  '.cm-md-hr': {
    display: 'inline-block',
    width: '90%',
    height: '2px',
    background: 'var(--droid-border-hover)',
    borderRadius: '1px',
    verticalAlign: 'middle',
  },
});
