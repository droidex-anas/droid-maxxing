const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserPermissionController } = require('./browserPermissions.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

let nextContentsId = 1;

function browserContents(url = 'https://camera.example/page') {
  return {
    id: nextContentsId++,
    destroyed: false,
    url,
    getURL() {
      return this.url;
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
}

function controllerFor(contents, overrides = {}) {
  const siteDecisions = overrides.siteDecisions ?? new Map();
  const persisted = [];
  let nextPromptId = 1;
  const controller = createBrowserPermissionController({
    isNativeBrowserContents: (candidate) => candidate === contents,
    getSiteDecision: (origin, mediaType) => siteDecisions.get(`${origin}\0${mediaType}`),
    persistSiteDecision: async ({ origin, mediaTypes, decision }) => {
      persisted.push({ origin, mediaTypes, decision });
      for (const mediaType of mediaTypes) {
        siteDecisions.set(`${origin}\0${mediaType}`, decision);
      }
    },
    requestPermission: async ({ promptId }) => ({ promptId, decision: 'deny_once' }),
    nextPromptId: () => `prompt-${nextPromptId++}`,
    ...overrides,
  });
  return { controller, persisted, siteDecisions };
}

function requestDecision(controller, contents, details) {
  return new Promise((resolve) => {
    controller.handleRequest(contents, 'media', resolve, details);
  });
}

function canAccess(controller, contents, origin, mediaType) {
  return controller.canAccess(contents, 'media', origin, {
    securityOrigin: origin,
    mediaType,
  });
}

test('permission checks fail closed before an app approval', () => {
  const contents = browserContents();
  const { controller } = controllerFor(contents);

  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'audio'), false);
  assert.equal(controller.canAccess(contents, 'geolocation', 'https://camera.example', {}), false);
  for (const permission of ['hid', 'usb', 'serial']) {
    assert.equal(controller.canAccess(contents, permission, 'https://camera.example', {}), false);
  }
  assert.equal(
    controller.canAccess({}, 'media', 'https://camera.example', { mediaType: 'video' }),
    false,
  );
  assert.equal(
    controller.canAccess(contents, 'media', 'file:///tmp', { mediaType: 'video' }),
    false,
  );
});

test('allow-once approval is correlated and grants only exact requested access', async () => {
  const contents = browserContents();
  let prompt;
  const { controller } = controllerFor(contents, {
    requestPermission: async (request) => {
      prompt = request;
      return { promptId: request.promptId, decision: 'allow_once' };
    },
  });

  const decision = await requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example/path',
    mediaTypes: ['video', 'audio', 'video'],
  });

  assert.equal(decision, true);
  assert.equal(prompt.origin, 'https://camera.example');
  assert.deepEqual(prompt.mediaTypes, ['audio', 'video']);
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), true);
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'audio'), true);
  assert.equal(canAccess(controller, contents, 'https://other.example', 'video'), false);
});

test('forged and malformed app prompt responses fail closed', async () => {
  const contents = browserContents();
  for (const response of [
    { promptId: 'wrong-prompt', decision: 'allow_once' },
    { promptId: 'prompt-1', decision: 'allow' },
    undefined,
  ]) {
    const { controller } = controllerFor(contents, {
      requestPermission: async () => response,
    });
    assert.equal(
      await requestDecision(controller, contents, {
        securityOrigin: 'https://camera.example',
        mediaTypes: ['video'],
      }),
      false,
    );
    assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
  }
});

test('an embedded or navigated origin cannot use another site permission', async () => {
  const contents = browserContents('https://top-level.example');
  const siteDecisions = new Map([['https://camera.example\0video', 'allow']]);
  let promptCount = 0;
  const { controller } = controllerFor(contents, {
    siteDecisions,
    requestPermission: async (request) => {
      promptCount += 1;
      return { promptId: request.promptId, decision: 'allow_once' };
    },
  });

  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://camera.example',
      mediaTypes: ['video'],
    }),
    false,
  );
  assert.equal(promptCount, 0);

  contents.url = 'https://camera.example/page';
  const prompt = deferred();
  const pendingController = controllerFor(contents, {
    requestPermission: () => prompt.promise,
  }).controller;
  const decision = requestDecision(pendingController, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video'],
  });
  contents.url = 'https://other.example';
  prompt.resolve({ promptId: 'prompt-1', decision: 'allow_once' });
  assert.equal(await decision, false);
});

test('persistent allow and deny decisions are exact-origin and media-specific', async () => {
  const contents = browserContents('https://media.example/page');
  let responseDecision = 'allow_always';
  const { controller, persisted } = controllerFor(contents, {
    requestPermission: async (request) => ({
      promptId: request.promptId,
      decision: responseDecision,
    }),
  });

  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://media.example/path',
      mediaTypes: ['video'],
    }),
    true,
  );
  assert.deepEqual(persisted[0], {
    origin: 'https://media.example',
    mediaTypes: ['video'],
    decision: 'allow',
  });
  controller.revokeForNavigation(contents);
  assert.equal(canAccess(controller, contents, 'https://media.example', 'video'), true);
  assert.equal(canAccess(controller, contents, 'https://media.example', 'audio'), false);
  assert.equal(canAccess(controller, contents, 'https://other.example', 'video'), false);

  responseDecision = 'deny_always';
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://media.example',
      mediaTypes: ['audio'],
    }),
    false,
  );
  assert.equal(canAccess(controller, contents, 'https://media.example', 'audio'), false);
  assert.equal(persisted[1].decision, 'deny');
});

test('persistent policy is resolved before prompting and deny wins mixed requests', async () => {
  const contents = browserContents('https://media.example/page');
  const siteDecisions = new Map([
    ['https://media.example\0video', 'allow'],
    ['https://media.example\0audio', 'deny'],
  ]);
  let promptCount = 0;
  const { controller } = controllerFor(contents, {
    siteDecisions,
    requestPermission: async (request) => {
      promptCount += 1;
      return { promptId: request.promptId, decision: 'allow_once' };
    },
  });

  assert.equal(canAccess(controller, contents, 'https://media.example', 'video'), true);
  assert.equal(canAccess(controller, contents, 'https://media.example', 'audio'), false);
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://media.example',
      mediaTypes: ['video'],
    }),
    true,
  );
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://media.example',
      mediaTypes: ['video', 'audio'],
    }),
    false,
  );
  assert.equal(promptCount, 0);
});

test('navigation invalidates a pending approval and temporary grants only', async () => {
  const contents = browserContents();
  const prompt = deferred();
  let signal;
  const { controller } = controllerFor(contents, {
    requestPermission: (request) => {
      signal = request.signal;
      return prompt.promise;
    },
  });
  const decision = requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video'],
  });

  await Promise.resolve();
  controller.revokeForNavigation(contents);
  assert.equal(signal.aborted, true);
  prompt.resolve({ promptId: 'prompt-1', decision: 'allow_once' });

  assert.equal(await decision, false);
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
});

test('a WebContents cannot queue overlapping media prompts', async () => {
  const contents = browserContents();
  const prompt = deferred();
  let promptCount = 0;
  const { controller } = controllerFor(contents, {
    requestPermission: (request) => {
      promptCount += 1;
      return prompt.promise.then((decision) => ({ promptId: request.promptId, decision }));
    },
  });
  const firstDecision = requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video'],
  });
  const secondDecision = requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['audio'],
  });

  assert.equal(await secondDecision, false);
  assert.equal(promptCount, 1);
  prompt.resolve('allow_once');
  assert.equal(await firstDecision, true);
});

test('site decisions revoke temporary grants and invalidate pending prompts', async () => {
  const contents = browserContents();
  const prompt = deferred();
  let promptCount = 0;
  const { controller } = controllerFor(contents, {
    requestPermission: (request) => {
      promptCount += 1;
      if (promptCount === 1) {
        return { promptId: request.promptId, decision: 'allow_once' };
      }
      return prompt.promise;
    },
  });
  await requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video'],
  });
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), true);

  await controller.setSiteDecision('https://camera.example/path', ['video'], 'ask');
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);

  const pending = requestDecision(controller, contents, {
    securityOrigin: 'https://camera.example',
    mediaTypes: ['video'],
  });
  await controller.setSiteDecision('https://camera.example', ['video'], 'deny');
  prompt.resolve({ promptId: 'prompt-2', decision: 'allow_once' });
  assert.equal(await pending, false);
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
});

test('persistence failures deny access and do not leave a temporary grant', async () => {
  const contents = browserContents();
  const { controller } = controllerFor(contents, {
    requestPermission: async (request) => ({
      promptId: request.promptId,
      decision: 'allow_always',
    }),
    persistSiteDecision: async () => {
      throw new Error('disk full');
    },
  });

  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://camera.example',
      mediaTypes: ['video'],
    }),
    false,
  );
  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
});

test('destroyed and foreign WebContents cannot retain or receive access', async () => {
  const contents = browserContents();
  const { controller } = controllerFor(contents, {
    requestPermission: async (request) => ({
      promptId: request.promptId,
      decision: 'allow_once',
    }),
  });
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://camera.example',
      mediaTypes: ['video'],
    }),
    true,
  );

  contents.destroyed = true;
  controller.revokeForContents(contents);

  assert.equal(canAccess(controller, contents, 'https://camera.example', 'video'), false);
  assert.equal(
    await requestDecision(controller, contents, {
      securityOrigin: 'https://camera.example',
      mediaTypes: ['video'],
    }),
    false,
  );
  assert.equal(
    await requestDecision(controller, browserContents(), {
      securityOrigin: 'https://camera.example',
      mediaTypes: ['video'],
    }),
    false,
  );
});
