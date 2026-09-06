// Validates page-originated IPC and binds asynchronous design captures to a document.
function createNativeBrowserPageEvents({ findEntryForContents, page, credentials, navigation }) {
  function entryForEvent(event) {
    const entry = findEntryForContents(event.sender);
    return entry && event.senderFrame === event.sender.mainFrame ? entry : undefined;
  }

  function selectionForEvent(event, selection) {
    const entry = entryForEvent(event);
    return entry && selection && typeof selection === 'object'
      ? { ...selection, browserSessionId: entry.browserSessionId }
      : undefined;
  }

  async function prepareDesignPrompt(event, payload) {
    const entry = entryForEvent(event);
    const selection = selectionForEvent(event, payload?.selection);
    if (!entry || !selection) return undefined;
    const view = entry.view;
    const generation = entry.documentGeneration;
    const screenshot = await page.captureDesignSelection(event.sender, selection);
    if (
      entry.view !== view ||
      entry.documentGeneration !== generation ||
      entryForEvent(event) !== entry ||
      event.sender.isDestroyed()
    )
      return undefined;
    return { ...payload, selection: screenshot ? { ...selection, screenshot } : selection };
  }

  function recordUserNavigation(event, payload) {
    const entry = entryForEvent(event);
    if (!entry) return;
    navigation.recordTrustedUserNavigation(
      entry,
      entry.view,
      payload?.activationId,
      payload?.destinationUrl,
    );
  }

  function expireUserNavigation(event, payload) {
    const entry = entryForEvent(event);
    if (entry) navigation.expireTrustedUserNavigation(entry, payload?.activationId);
  }

  async function captureCredential(event, payload) {
    const entry = entryForEvent(event);
    if (entry) await credentials.capture(entry, event.sender, event.senderFrame.url, payload);
  }

  return {
    selectionForEvent,
    prepareDesignPrompt,
    recordUserNavigation,
    expireUserNavigation,
    captureCredential,
  };
}

module.exports = { createNativeBrowserPageEvents };
