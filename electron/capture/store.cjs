const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  DEFAULT_PREFERENCES,
  MAX_IMAGE_BYTES,
  MAX_PIXELS,
  id: validateId,
  png: validatePng,
  preferences: validatePreferences,
  recipe: validateRecipe,
  title: sanitizeTitle,
} = require('./validation.cjs');

const MAX_RECORDS = 30;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function createCaptureStore(root) {
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
  async function directory() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Capture storage is not a private directory');
    await fs.chmod(root, 0o700);
  }
  function file(id, suffix) {
    return path.join(root, `${validateId(id)}.${suffix}`);
  }
  async function readFile(target) {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES)
      throw new Error('Unsafe capture file');
    return fs.readFile(target);
  }
  async function atomic(target, contents) {
    const temp = path.join(root, `.write-${randomUUID()}`);
    try {
      await fs.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async function record(id) {
    const raw = JSON.parse((await readFile(file(id, 'json'))).toString('utf8'));
    if (
      raw.id !== id ||
      !Number.isFinite(raw.createdAt) ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision < 0 ||
      !Number.isSafeInteger(raw.width) ||
      !Number.isSafeInteger(raw.height) ||
      raw.width < 1 ||
      raw.height < 1 ||
      raw.width * raw.height > MAX_PIXELS
    )
      throw new Error('Invalid capture record');
    return {
      id,
      createdAt: raw.createdAt,
      revision: raw.revision,
      width: raw.width,
      height: raw.height,
      title: sanitizeTitle(raw.title),
      recipe: validateRecipe(raw.recipe, raw.width, raw.height),
      hasExport: raw.hasExport === true,
    };
  }
  async function remove(id) {
    await Promise.all(
      ['json', 'source.png', 'output.png', 'thumb.png'].map((suffix) =>
        fs.rm(file(id, suffix), { force: true }),
      ),
    );
  }
  async function records() {
    const names = (await fs.readdir(root)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
    const result = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        result.push(await record(id));
      } catch (error) {
        console.warn('Capture record unavailable:', id, error.message);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }
  async function prune(protectedId, incomingBytes = 0) {
    const list = await records();
    let bytes = 0;
    const sizes = new Map();
    for (const name of await fs.readdir(root)) {
      const stat = await fs.lstat(path.join(root, name));
      if (name.startsWith('.write-') && Date.now() - stat.mtimeMs > 60_000) {
        await fs.rm(path.join(root, name), { force: true });
        continue;
      }
      bytes += stat.size;
      const id = name.slice(0, 36);
      sizes.set(id, (sizes.get(id) || 0) + stat.size);
    }
    let count = list.length;
    for (const item of list.slice().reverse()) {
      if (item.id === protectedId) continue;
      if (
        count <= MAX_RECORDS &&
        bytes + incomingBytes <= MAX_STORE_BYTES &&
        Date.now() - item.createdAt <= MAX_AGE_MS
      )
        continue;
      await remove(item.id);
      count -= 1;
      bytes -= sizes.get(item.id) || 0;
    }
    if (bytes + incomingBytes > MAX_STORE_BYTES)
      throw new Error('Capture history is full. Delete older captures and retry.');
  }
  async function getPreferences() {
    try {
      return validatePreferences(
        JSON.parse((await readFile(path.join(root, 'preferences.json'))).toString('utf8')),
      );
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'Capture preferences could not be read. Restore the preferences file before saving.',
          { cause: error },
        );
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }
  return {
    preferences: () =>
      serial(async () => {
        await directory();
        return getPreferences();
      }),
    setPreferences: (value) =>
      serial(async () => {
        await directory();
        const next = validatePreferences(value);
        await atomic(path.join(root, 'preferences.json'), JSON.stringify(next));
        return next;
      }),
    create: (buffer, title) =>
      serial(async () => {
        await directory();
        const size = validatePng(buffer);
        const prefs = await getPreferences();
        await prune(null, buffer.length + 4096);
        const id = randomUUID();
        const item = {
          id,
          title: sanitizeTitle(title),
          ...size,
          createdAt: Date.now(),
          revision: 0,
          recipe: { version: 1, crop: { x: 0, y: 0, ...size }, style: prefs.style },
          hasExport: false,
        };
        try {
          await fs.writeFile(file(id, 'source.png'), buffer, { flag: 'wx', mode: 0o600 });
          await atomic(file(id, 'json'), JSON.stringify(item));
          await prune(id);
        } catch (error) {
          await remove(id);
          throw error;
        }
        return item;
      }),
    list: () =>
      serial(async () => {
        await directory();
        await prune(null);
        return records();
      }),
    read: (id) =>
      serial(async () => {
        await directory();
        const item = await record(validateId(id));
        const buffer = await readFile(file(id, 'source.png'));
        validatePng(buffer);
        return { ...item, source: `data:image/png;base64,${buffer.toString('base64')}` };
      }),
    thumbnail: (id) =>
      serial(async () => {
        await directory();
        await record(validateId(id));
        try {
          return `data:image/png;base64,${(await readFile(file(id, 'thumb.png'))).toString('base64')}`;
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      }),
    save: (id, expectedRevision, recipe, output, thumbnail) =>
      serial(async () => {
        await directory();
        const item = await record(validateId(id));
        if (item.revision !== expectedRevision)
          throw new Error('This capture changed in another editor. Reopen it before saving.');
        const nextRecipe = validateRecipe(recipe, item.width, item.height);
        const size = validatePng(output);
        validatePng(thumbnail);
        const padding = Math.round(nextRecipe.style.padding);
        if (
          size.width !== nextRecipe.crop.width + padding * 2 ||
          size.height !== nextRecipe.crop.height + padding * 2
        )
          throw new Error('Export dimensions do not match the original-pixel recipe');
        await prune(id, output.length + thumbnail.length + 4096);
        const next = { ...item, recipe: nextRecipe, revision: item.revision + 1, hasExport: true };
        // Invalidate the previous export before replacing it. An interrupted write
        // must never pair a new recipe with an old image after restart.
        await atomic(file(id, 'json'), JSON.stringify({ ...item, hasExport: false }));
        await atomic(file(id, 'output.png'), output);
        await atomic(file(id, 'thumb.png'), thumbnail);
        await atomic(file(id, 'json'), JSON.stringify(next));
        return next;
      }),
    output: (id) =>
      serial(async () => {
        await directory();
        const item = await record(validateId(id));
        if (!item.hasExport)
          throw new Error('Open and save this capture before copying or attaching it');
        const buffer = await readFile(file(id, 'output.png'));
        const size = validatePng(buffer);
        const preview = `data:image/png;base64,${(await readFile(file(id, 'thumb.png'))).toString('base64')}`;
        return { item, buffer, preview, ...size };
      }),
    delete: (id) =>
      serial(async () => {
        await directory();
        await remove(validateId(id));
      }),
  };
}
module.exports = { createCaptureStore, MAX_RECORDS };
