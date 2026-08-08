const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;

function runFile(file, args, { cwd, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...(cwd ? { cwd } : {}), timeout, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          spawnFailed: !!err && err.code === 'ENOENT',
        });
      },
    );
  });
}

async function resolveExecutable({ binaryName, commonPaths }, options = {}) {
  const env = options.env || process.env;
  const access =
    options.access || ((candidate) => fs.promises.access(candidate, fs.constants.X_OK));
  const execute = options.runFile || runFile;
  const pathCandidates = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, binaryName));
  const candidates = [...new Set([...pathCandidates, ...commonPaths])];

  const validate = async (candidate) => {
    try {
      await access(candidate);
      const version = await execute(candidate, ['--version'], { timeout: 5_000 });
      return version.code === 0 ? candidate : null;
    } catch {
      return null;
    }
  };

  for (const candidate of candidates) {
    const valid = await validate(candidate);
    if (valid) return valid;
  }

  const shell = String(env.SHELL || '').trim();
  if (!shell) return null;
  const lookup = await execute(shell, ['-lc', `command -v ${binaryName}`], { timeout: 5_000 });
  if (lookup.code !== 0) return null;
  const shellCandidate = lookup.stdout.trim().split(/\r?\n/, 1)[0];
  if (!path.isAbsolute(shellCandidate)) return null;
  return validate(shellCandidate);
}

module.exports = { resolveExecutable, runFile };
