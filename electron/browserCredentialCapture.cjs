function createCredentialCaptureGuard(entry, contents, submittedUrl) {
  const view = entry.view;
  const origin = new URL(submittedUrl).origin;
  return () => {
    try {
      return (
        entry.view === view &&
        view?.webContents === contents &&
        !contents.isDestroyed() &&
        new URL(contents.getURL()).origin === origin
      );
    } catch {
      return false;
    }
  };
}

module.exports = { createCredentialCaptureGuard };
