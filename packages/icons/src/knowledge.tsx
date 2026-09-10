import { createIcon } from './Icon.js';

const BOOK = 'M7.5 4h10A1.5 1.5 0 0 1 19 5.5V20H7.5A2.5 2.5 0 0 1 5 17.5v-11A2.5 2.5 0 0 1 7.5 4Z';

export const Book = createIcon(
  'book',
  <>
    <path d={BOOK} />
    <path d="M19 15H7.5a2.5 2.5 0 0 0 0 5M9 4v11" />
  </>,
);

export const BookFilled = createIcon(
  'book-filled',
  <>
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      d={`${BOOK}M9 5a.75.75 0 0 0-.75.75v8a.75.75 0 0 0 1.5 0v-8A.75.75 0 0 0 9 5Zm-1.5 11a1.5 1.5 0 0 0 0 3h10v-3Z`}
    />
  </>,
);

const BOOKS = (
  <>
    <rect x="3.5" y="5" width="5" height="15" rx="1.5" />
    <rect x="8.5" y="3.5" width="5" height="16.5" rx="1.5" />
    <path d="m15.1 5.55 2.4-.55c.8-.2 1.35.2 1.55 1l2.6 12c.15.8-.2 1.35-1 1.55l-2.4.55c-.8.2-1.35-.2-1.55-1l-2.6-12c-.15-.8.2-1.35 1-1.55Z" />
  </>
);

export const Books = createIcon(
  'books',
  <>
    {BOOKS}
    <path d="M5.5 8h1m4-1h1m5.2 1.8 1-.2M5.5 17h1m4 0h1m7.3-.4 1-.2" />
  </>,
);

export const BooksFilled = createIcon(
  'books-filled',
  <g fill="currentColor" stroke="none">
    <rect x="3" y="4.5" width="4.5" height="16" rx="1.5" />
    <rect x="9" y="3" width="4.5" height="17.5" rx="1.5" />
    <path d="m16.2 5.05 1.4-.3c.8-.2 1.35.2 1.55 1l2.65 12.5c.15.8-.2 1.35-1 1.55l-1.4.3c-.8.2-1.35-.2-1.55-1L15.2 6.6c-.15-.8.2-1.35 1-1.55Z" />
  </g>,
);

const NOTEBOOK_RINGS = <path d="M4 8h3m-3 4h3m-3 4h3" />;

export const Notebook = createIcon(
  'notebook',
  <>
    <rect x="6" y="3.5" width="13" height="17" rx="3" />
    {NOTEBOOK_RINGS}
    <path d="M10 8h5m-5 4h3" />
  </>,
);

export const NotebookFilled = createIcon(
  'notebook-filled',
  <>
    {NOTEBOOK_RINGS}
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      d="M9 2.75h7a3.75 3.75 0 0 1 3.75 3.75v11A3.75 3.75 0 0 1 16 21.25H9a3.75 3.75 0 0 1-3.75-3.75v-11A3.75 3.75 0 0 1 9 2.75Zm1 4.5a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5Zm0 4a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5Z"
    />
  </>,
);

const FILE_SEARCH_LENS = (
  <>
    <circle cx="15.5" cy="16.5" r="3.5" />
    <path d="m18 19 3 3" />
  </>
);

export const FileSearch = createIcon(
  'file-search',
  <>
    <path d="M9 20.5h-.5c-2.2 0-3-1.15-3-3.5V7c0-2.35.8-3.5 3-3.5h4.25c.8 0 1.4.25 2 .85l2.9 2.9c.6.6.85 1.2.85 2v1.25" />
    <path d="M13 3.6V7c0 1.1.4 1.5 1.5 1.5h3.9" />
    {FILE_SEARCH_LENS}
  </>,
);

export const FileSearchFilled = createIcon(
  'file-search-filled',
  <>
    <path
      fill="currentColor"
      stroke="none"
      d="M8.5 2.75c-2.65 0-3.75 1.5-3.75 4.25v10c0 2.75 1.1 4.25 3.75 4.25H11a6.4 6.4 0 0 1-2-4.75 6.5 6.5 0 0 1 10.25-5.3V10h-4.5A3.25 3.25 0 0 1 11.5 6.75v-4ZM13 2.8v3.95c0 1.15.6 1.75 1.75 1.75H19c-.15-.6-.45-1.1-1-1.65l-2.9-2.9c-.65-.65-1.25-1-2.1-1.15Z"
    />
    {FILE_SEARCH_LENS}
  </>,
);
