import assert from 'node:assert/strict';
import test from 'node:test';

test('opening a settings dropdown focuses its option without scrolling the settings page', async () => {
  const settingsKit = await import('./settingsDropdown.js');
  const focusDropdownOption = Reflect.get(settingsKit, 'focusDropdownOption');
  assert.equal(typeof focusDropdownOption, 'function');

  let receivedOptions: FocusOptions | undefined;
  focusDropdownOption({
    focus(options?: FocusOptions) {
      receivedOptions = options;
    },
  });

  assert.deepEqual(receivedOptions, { preventScroll: true });
});
