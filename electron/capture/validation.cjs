const PRESETS = ['ember', 'tide', 'pearl', 'iris', 'graphite', 'transparent'];
const SHORTCUTS = [
  '',
  'CommandOrControl+Shift+2',
  'CommandOrControl+Shift+6',
  'CommandOrControl+Shift+9',
];
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 48_000_000;
const DEFAULT_STYLE = Object.freeze({
  preset: 'ember',
  padding: 64,
  radius: 18,
  shadow: 32,
  texture: 0.12,
});
const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  style: DEFAULT_STYLE,
  sound: true,
  smartSelection: true,
  shortcut: SHORTCUTS[1],
});

function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid capture request');
  return value;
}
function style(value) {
  const v = object(value);
  if (!PRESETS.includes(v.preset)) throw new Error('Unknown capture background');
  if (
    v.colors !== undefined &&
    (!Array.isArray(v.colors) ||
      v.colors.length !== 3 ||
      !v.colors.every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))
  )
    throw new Error('Invalid gradient colors');
  return {
    preset: v.preset,
    ...(v.colors ? { colors: [...v.colors] } : {}),
    padding: number(v.padding, 0, 240, 'padding'),
    radius: number(v.radius, 0, 100, 'radius'),
    shadow: number(v.shadow, 0, 100, 'shadow'),
    texture: number(v.texture, 0, 0.5, 'texture'),
  };
}
function preferences(value) {
  const v = object(value);
  if (
    v.version !== 1 ||
    typeof v.sound !== 'boolean' ||
    typeof v.smartSelection !== 'boolean' ||
    !SHORTCUTS.includes(v.shortcut)
  )
    throw new Error('Invalid capture preferences');
  return {
    version: 1,
    style: style(v.style),
    sound: v.sound,
    smartSelection: v.smartSelection,
    shortcut: v.shortcut,
  };
}
function rect(value, width, height) {
  const v = object(value);
  const x = Math.floor(number(v.x, 0, width - 1, 'crop x'));
  const y = Math.floor(number(v.y, 0, height - 1, 'crop y'));
  const w = Math.ceil(number(v.width, 1, width, 'crop width'));
  const h = Math.ceil(number(v.height, 1, height, 'crop height'));
  if (x + w > width || y + h > height) throw new Error('Crop extends outside the original image');
  return { x, y, width: w, height: h };
}
function recipe(value, width, height) {
  const v = object(value);
  return { version: 1, crop: rect(v.crop, width, height), style: style(v.style) };
}
function id(value) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error('Invalid capture identity');
  return value;
}
function png(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 33 ||
    buffer.length > MAX_IMAGE_BYTES ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Capture must be a PNG within 40 MiB');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS || width > 16000 || height > 16000)
    throw new Error('Capture exceeds the 48 megapixel / 16000px limit');
  return { width, height };
}
function decodePng(value) {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 22 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)
  )
    throw new Error('Invalid PNG payload');
  const buffer = Buffer.from(value.slice(22), 'base64');
  return { buffer, ...png(buffer) };
}
function title(value) {
  if (typeof value !== 'string') return 'Screenshot';
  return (
    Array.from(value.slice(0, 240))
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 120)
      .trim() || 'Screenshot'
  );
}

module.exports = {
  DEFAULT_PREFERENCES,
  MAX_IMAGE_BYTES,
  MAX_PIXELS,
  preferences,
  style,
  rect,
  recipe,
  id,
  png,
  decodePng,
  title,
};
