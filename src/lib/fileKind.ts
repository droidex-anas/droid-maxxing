// Type classification for file-attachment chips: the subtitle under the file
// name ("Text document", "PDF", "Video") and which icon tile the chip shows.
// Pure mapping from the file name (extension first, MIME as fallback) so the
// same logic serves pasted blobs, picker paths, and queued-prompt restores.

export type FileKind =
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'text'
  | 'data'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'file';

export interface FileKindInfo {
  kind: FileKind;
  label: string;
}

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  pages: 'document',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  log: 'text',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  ods: 'spreadsheet',
  numbers: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  ppt: 'presentation',
  pptx: 'presentation',
  odp: 'presentation',
  key: 'presentation',
  xml: 'data',
  json: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  html: 'data',
  htm: 'data',
  js: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  cs: 'code',
  swift: 'code',
  sh: 'code',
  sql: 'code',
  css: 'code',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  rar: 'archive',
  '7z': 'archive',
};

const KIND_LABELS: Record<FileKind, string> = {
  pdf: 'PDF',
  document: 'Text document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  text: 'Text file',
  data: 'Data file',
  code: 'Code file',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  archive: 'Archive',
  file: 'File',
};

function kindFromMime(mime: string): FileKind | null {
  if (mime === 'application/pdf') return 'pdf';
  const slash = mime.indexOf('/');
  if (slash <= 0) return null;
  const top = mime.slice(0, slash);
  if (top === 'video' || top === 'audio' || top === 'image' || top === 'text') return top;
  return null;
}

export function fileKindInfo(name: string, mime?: string): FileKindInfo {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const kind =
    (ext.length > 0 ? KIND_BY_EXTENSION[ext] : undefined) ??
    (mime !== undefined ? (kindFromMime(mime) ?? undefined) : undefined) ??
    'file';
  return { kind, label: KIND_LABELS[kind] };
}

// Temp-store saves are named file-<ts>-<rand>-<original name> (see
// electron/attachments.cjs); chips display only the original name part, so a
// chip restored from a queued prompt still reads like the user's file.
const TEMP_FILE_PREFIX = /^file-\d+-[0-9a-f]{8}-/;

export function attachmentDisplayName(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return TEMP_FILE_PREFIX.test(base) ? base.replace(TEMP_FILE_PREFIX, '') : base;
}
