import assert from 'node:assert/strict';
import test from 'node:test';
import { focusDropdownOption } from './settingsDropdown';

test('opening a settings dropdown focuses its option without scrolling the settings page', () => {
  let receivedOptions: FocusOptions | undefined;
  focusDropdownOption({
    focus(options?: FocusOptions) {
      receivedOptions = options;
    },
  });

  assert.deepEqual(receivedOptions, { preventScroll: true });
});
