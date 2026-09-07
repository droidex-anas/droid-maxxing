const crypto = require('node:crypto');

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_QUEUED_PROMPTS = 32;

function createBrowserPromptController(options) {
  const queue = [];
  let active = null;
  const now = options.now ?? Date.now;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
  const maxQueuedPrompts = nonNegativeInteger(options.maxQueuedPrompts, DEFAULT_MAX_QUEUED_PROMPTS);

  function request(input, requestOptions = {}) {
    const prompt = validatePrompt(input);
    if (requestOptions.signal?.aborted) return Promise.resolve({ response: prompt.cancelId });
    expireQueuedPrompts();
    if (active && queue.length >= maxQueuedPrompts) {
      return Promise.resolve({ response: prompt.cancelId });
    }
    return new Promise((resolve) => {
      const pending = {
        prompt,
        resolve,
        signal: requestOptions.signal,
        abortListener: null,
        expiresAt: now() + timeoutMs,
      };
      if (pending.signal) {
        pending.abortListener = () => abortPending(pending);
        pending.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      pending.timeout = (options.setTimeout || setTimeout)(() => expirePending(pending), timeoutMs);
      enqueue(pending);
      showNext();
    });
  }

  function showNext() {
    if (active) return;
    while (queue.length > 0) {
      const pending = queue.shift();
      if (now() >= pending.expiresAt || !options.isAvailable()) {
        settleQueued(pending);
        continue;
      }
      const requestId = (options.randomUUID || crypto.randomUUID)();
      pending.requestId = requestId;
      active = pending;
      try {
        options.send({ requestId, ...pending.prompt });
      } catch {
        settle(requestId, pending.prompt.cancelId);
      }
      return;
    }
  }

  function enqueue(pending) {
    if (pending.prompt.kind !== 'credential') {
      queue.push(pending);
      return;
    }
    const firstLowerPriority = queue.findIndex(
      (candidate) => candidate.prompt.kind !== 'credential',
    );
    if (firstLowerPriority === -1) queue.push(pending);
    else queue.splice(firstLowerPriority, 0, pending);
  }

  function resolve(requestId, response) {
    if (!active || active.requestId !== requestId) return false;
    if (!Number.isInteger(response) || response < 0 || response >= active.prompt.buttons.length) {
      return false;
    }
    settle(requestId, response);
    return true;
  }

  function settle(requestId, response, dismiss = false) {
    if (!active || active.requestId !== requestId) return;
    const pending = active;
    active = null;
    (options.clearTimeout || clearTimeout)(pending.timeout);
    removeAbortListener(pending);
    if (dismiss) dismissBestEffort(requestId);
    pending.resolve({ response });
    showNext();
  }

  function dismissBestEffort(requestId) {
    try {
      options.dismiss?.(requestId);
    } catch (error) {
      try {
        (options.logError ?? console.error)('Failed to dismiss browser prompt.', error);
      } catch {
        // Prompt settlement must survive a broken diagnostic sink.
      }
    }
  }

  function abortPending(pending) {
    if (active === pending) {
      settle(active.requestId, pending.prompt.cancelId, true);
      return;
    }
    const index = queue.indexOf(pending);
    if (index === -1) return;
    queue.splice(index, 1);
    settleQueued(pending);
  }

  function expirePending(pending) {
    if (active === pending) {
      settle(pending.requestId, pending.prompt.cancelId, true);
      return;
    }
    const index = queue.indexOf(pending);
    if (index === -1) return;
    queue.splice(index, 1);
    settleQueued(pending);
  }

  function expireQueuedPrompts() {
    for (const pending of [...queue]) {
      if (now() >= pending.expiresAt) expirePending(pending);
    }
  }

  function settleQueued(pending) {
    (options.clearTimeout || clearTimeout)(pending.timeout);
    removeAbortListener(pending);
    pending.resolve({ response: pending.prompt.cancelId });
  }

  function cancelAll() {
    if (active) {
      const pending = active;
      active = null;
      (options.clearTimeout || clearTimeout)(pending.timeout);
      removeAbortListener(pending);
      dismissBestEffort(pending.requestId);
      pending.resolve({ response: pending.prompt.cancelId });
    }
    while (queue.length > 0) {
      const pending = queue.shift();
      settleQueued(pending);
    }
  }

  return { cancelAll, request, resolve };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function removeAbortListener(pending) {
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener('abort', pending.abortListener);
    pending.abortListener = null;
  }
}

function validatePrompt(input) {
  if (!input || typeof input !== 'object') throw new Error('Browser prompt is invalid.');
  const buttons = Array.isArray(input.buttons)
    ? input.buttons.map((button) => boundedText(button, 80))
    : [];
  if (buttons.length < 2 || buttons.length > 4 || buttons.some((button) => !button)) {
    throw new Error('Browser prompt requires two to four labeled actions.');
  }
  const cancelId = Number(input.cancelId);
  if (!Number.isInteger(cancelId) || cancelId < 0 || cancelId >= buttons.length) {
    throw new Error('Browser prompt requires a valid cancel action.');
  }
  return {
    kind: ['question', 'warning', 'permission', 'credential'].includes(input.kind)
      ? input.kind
      : 'question',
    title: boundedText(input.title, 120),
    message: boundedText(input.message, 320),
    detail: boundedText(input.detail, 800),
    buttons,
    cancelId,
  };
}

function browserPromptFromDialogOptions(options) {
  return {
    ...options,
    kind:
      options.kind ||
      (options.type === 'warning'
        ? 'warning'
        : /login|password|authentication|passkey/i.test(`${options.title} ${options.message}`)
          ? 'credential'
          : 'permission'),
  };
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

module.exports = { browserPromptFromDialogOptions, createBrowserPromptController };
