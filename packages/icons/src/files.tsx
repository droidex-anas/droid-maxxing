import { createIcon } from './Icon.js';

const PAGE = (
  <>
    <path d="M12.75 3.5H8.5c-2.2 0-3 1.15-3 3.5v10c0 2.35.8 3.5 3 3.5h7c2.2 0 3-1.15 3-3.5V9.25c0-.8-.25-1.4-.85-2l-2.9-2.9c-.6-.6-1.2-.85-2-.85Z" />
    <path d="M13 3.6V7c0 1.1.4 1.5 1.5 1.5h3.9" />
  </>
);

export const File = createIcon('file', PAGE);

export const FileText = createIcon(
  'file-text',
  <>
    {PAGE}
    <path d="M9 12.5h6" />
    <path d="M9 16h6" />
  </>,
);

export const FileImage = createIcon(
  'file-image',
  <>
    {PAGE}
    <circle cx="9.5" cy="12.5" r="1.5" />
    <path d="m18.5 16.5-3.3-3.3a1 1 0 0 0-1.4 0L9 18" />
  </>,
);

export const FileSpreadsheet = createIcon(
  'file-spreadsheet',
  <>
    {PAGE}
    <path d="M8.5 13h7" />
    <path d="M8.5 16.5h7" />
    <path d="M12 13v3.5" />
  </>,
);

export const FileArchive = createIcon(
  'file-archive',
  <>
    {PAGE}
    <path d="M10 3.5V6" />
    <path d="M10 8.5V11" />
    <rect x="8.5" y="13.5" width="3" height="3" rx="1" />
  </>,
);

export const FileCog = createIcon(
  'file-cog',
  <>
    {PAGE}
    <circle cx="12" cy="15" r="2.2" />
    <path d="M12 11.8v1" />
    <path d="M12 17.2v1" />
    <path d="M8.8 15h-1" />
    <path d="M15.2 15h1" />
  </>,
);

export const FileDiff = createIcon(
  'file-diff',
  <>
    {PAGE}
    <path d="M12 10.5v4.5" />
    <path d="M9.75 12.75h4.5" />
    <path d="M9.75 17h4.5" />
  </>,
);

export const Files = createIcon(
  'files',
  <>
    <path d="M15.5 3.5H10A2.5 2.5 0 0 0 7.5 6v10.5A2.5 2.5 0 0 0 10 19h7.5a2.5 2.5 0 0 0 2.5-2.5V7.5Z" />
    <path d="M15.5 3.5V6A1.5 1.5 0 0 0 17 7.5h3" />
    <path d="M4 8.5V18a2.5 2.5 0 0 0 2.5 2.5h9" />
  </>,
);

const FOLDER =
  'M3 8.5A2.5 2.5 0 0 1 5.5 6h3.2a2 2 0 0 1 1.4.6l1.2 1.2a2 2 0 0 0 1.4.6h5.8A2.5 2.5 0 0 1 21 10.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z';

export const Folder = createIcon('folder', <path d={FOLDER} />);

export const FolderOpen = createIcon(
  'folder-open',
  <>
    <path d="M3 17.5V8.5A2.5 2.5 0 0 1 5.5 6h3.2a2 2 0 0 1 1.4.6l1.2 1.2a2 2 0 0 0 1.4.6h4.8A2.5 2.5 0 0 1 19 10.9V12" />
    <path d="M3.2 18.6 6.3 13.4a2 2 0 0 1 1.9-1.4H21a1 1 0 0 1 1 1.3l-1.6 5.3a2 2 0 0 1-1.9 1.4H5.5a2.5 2.5 0 0 1-2.3-1.4Z" />
  </>,
);

export const FolderPlus = createIcon(
  'folder-plus',
  <>
    <path d={FOLDER} />
    <path d="M12 11v6" />
    <path d="M9 14h6" />
  </>,
);

export const FolderMinus = createIcon(
  'folder-minus',
  <>
    <path d={FOLDER} />
    <path d="M9 14h6" />
  </>,
);

export const FolderSearch = createIcon(
  'folder-search',
  <>
    <path d={FOLDER} />
    <circle cx="11.5" cy="13.5" r="2.5" />
    <path d="m13.4 15.4 2.1 2.1" />
  </>,
);

export const FolderGit = createIcon(
  'folder-git',
  <>
    <path d={FOLDER} />
    <circle cx="12" cy="14" r="2" />
    <path d="M14 14h3" />
    <path d="M7 14h3" />
  </>,
);
