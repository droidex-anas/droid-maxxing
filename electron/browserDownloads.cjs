const fs = require('node:fs');
const path = require('node:path');

const MAX_RESERVED_FILENAME_BYTES = 240;

function reserveDownloadPath(directory, filename, reservedPaths) {
  const sanitizedName =
    path
      .basename(String(filename || 'download'))
      // eslint-disable-next-line no-control-regex -- Download filenames must sanitize control bytes.
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/[. ]+$/g, '') || 'download';
  const safeName =
    truncateFilenameUtf8(sanitizedName, MAX_RESERVED_FILENAME_BYTES).replace(/[. ]+$/g, '') ||
    'download';
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let candidate = path.join(directory, safeName);
  for (
    let index = 2;
    fs.existsSync(candidate) || reservedPaths.has(downloadReservationKey(candidate));
    index += 1
  ) {
    candidate = path.join(directory, `${stem} ${index}${extension}`);
  }
  reservedPaths.add(downloadReservationKey(candidate));
  return candidate;
}

function downloadReservationKey(filePath) {
  return path.normalize(filePath).normalize('NFD').toLowerCase();
}

function truncateFilenameUtf8(filename, maxBytes) {
  const extension = path.extname(filename);
  const extensionBytes = Buffer.byteLength(extension, 'utf8');
  if (!extension || extensionBytes >= maxBytes) return truncateUtf8(filename, maxBytes);
  const stem = path.basename(filename, extension);
  return `${truncateUtf8(stem, maxBytes - extensionBytes)}${extension}`;
}

function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

module.exports = { downloadReservationKey, reserveDownloadPath };
