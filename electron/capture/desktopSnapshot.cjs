const { png, rect, MAX_PIXELS } = require('./validation.cjs');

// Screen thumbnails are not guaranteed to be source-sized. Refuse a smaller
// result instead of quietly upscaling it or selecting a different monitor.
async function snapshotDisplay(electron, display) {
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  if (width * height > MAX_PIXELS || width > 16000 || height > 16000)
    throw new Error('This display exceeds the capture pixel limit. Use Area instead.');
  const sources = await electron.desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty())
    throw new Error('This display could not be captured. Check Screen Recording permission.');
  const buffer = source.thumbnail.toPNG();
  const size = png(buffer);
  if (size.width !== width || size.height !== height)
    throw new Error(
      'macOS did not return this display at full resolution. Use Area or Window instead.',
    );
  return buffer;
}
function cropSnapshot(nativeImage, buffer, selection) {
  const size = png(buffer);
  const crop = rect(selection, size.width, size.height);
  const image = nativeImage.createFromBuffer(buffer);
  const decoded = image.getSize();
  if (decoded.width !== size.width || decoded.height !== size.height)
    throw new Error('Capture pixel coordinates do not match the original image.');
  const output = image.crop(crop).toPNG();
  const actual = png(output);
  if (actual.width !== crop.width || actual.height !== crop.height)
    throw new Error('The selected area could not be preserved at source resolution.');
  return output;
}
module.exports = { snapshotDisplay, cropSnapshot };
