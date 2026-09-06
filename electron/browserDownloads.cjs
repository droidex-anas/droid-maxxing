const fs = require('node:fs');
const path = require('node:path');

function reserveDownloadPath(directory, filename, reservedPaths) {
  const safeName =
    path
      .basename(String(filename || 'download'))
      // eslint-disable-next-line no-control-regex -- Download filenames must sanitize control bytes.
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 240) || 'download';
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let candidate = path.join(directory, safeName);
  for (let index = 2; fs.existsSync(candidate) || reservedPaths.has(candidate); index += 1) {
    candidate = path.join(directory, `${stem} ${index}${extension}`);
  }
  reservedPaths.add(candidate);
  return candidate;
}

module.exports = { reserveDownloadPath };
