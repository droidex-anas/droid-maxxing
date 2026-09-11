// The right-click menu. Electron ships no context menu of its own, so without
// this the app offers nothing on right-click anywhere: no cut, copy or paste in
// a field, no way to copy a link's address, no spelling suggestions. The items
// are the ones every desktop app has, built from what the click actually landed
// on so the menu never offers an action that cannot run.

function spellingItems(params, options) {
  if (!params.misspelledWord) return [];
  const suggestions = params.dictionarySuggestions.slice(0, 5).map((word) => ({
    label: word,
    click: () => options.replaceMisspelling(word),
  }));
  return [
    // A misspelling with no suggestion still offers the dictionary, so the menu
    // does not open empty on a name the checker does not know.
    ...(suggestions.length > 0 ? suggestions : [{ label: 'No guesses found', enabled: false }]),
    { type: 'separator' },
    {
      label: 'Add to Dictionary',
      click: () => options.addToDictionary(params.misspelledWord),
    },
    { type: 'separator' },
  ];
}

function linkItems(params, options) {
  if (!params.linkURL) return [];
  return [
    { label: 'Open Link', click: () => options.openExternal(params.linkURL) },
    { label: 'Copy Link Address', click: () => options.copyText(params.linkURL) },
    { type: 'separator' },
  ];
}

function editItems(params) {
  const flags = params.editFlags;
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ];
  }
  // Read-only content: copying a selection is the only edit that means anything.
  if (params.selectionText) {
    return [{ role: 'copy', enabled: flags.canCopy }];
  }
  return [];
}

function trimSeparators(template) {
  const items = template.filter(
    (item, index) =>
      item.type !== 'separator' || (index > 0 && template[index - 1].type !== 'separator'),
  );
  while (items.length > 0 && items[items.length - 1].type === 'separator') items.pop();
  return items[0]?.type === 'separator' ? items.slice(1) : items;
}

function createContextMenuTemplate(params, options) {
  return trimSeparators([
    ...spellingItems(params, options),
    ...linkItems(params, options),
    ...editItems(params),
  ]);
}

function installContextMenu(options) {
  const { webContents } = options;
  webContents.on('context-menu', (_event, params) => {
    const template = createContextMenuTemplate(params, {
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      addToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
      copyText: (text) => options.clipboard.writeText(text),
      openExternal: (url) => {
        // The same http(s)-only rule the renderer's links go through.
        Promise.resolve()
          .then(() => options.openExternal(url))
          .catch((error) => options.logError(error.message));
      },
    });
    // An empty menu would flash a bare grey box; a right-click on nothing
    // actionable should do nothing at all.
    if (template.length === 0) return;
    options.Menu.buildFromTemplate(template).popup({ window: options.window });
  });
}

module.exports = { createContextMenuTemplate, installContextMenu };
