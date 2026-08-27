export const GUI_BENCH_PROBE_SOURCE = `(function installGuiBenchProbe() {
  if (window.__guiBench) return 'already';
  const longTasks = [];
  const frames = [];
  const blanks = [];
  let sampling = false;
  let rafId = 0;
  let longObserver = null;
  let phaseStartedAt = 0;

  function scroller() {
    const chat = document.querySelector('[data-testid="chat-view"]');
    if (!chat) return null;
    const withRows = Array.from(chat.querySelectorAll('.overflow-y-auto')).find((node) =>
      node.querySelector('[data-feed-row-id]'),
    );
    return withRows || chat.querySelector('.overflow-y-auto');
  }

  function unionCoverage(viewport, rows) {
    const segments = [];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const top = Math.max(rect.top, viewport.top);
      const bottom = Math.min(rect.bottom, viewport.bottom);
      if (bottom > top) segments.push([top, bottom]);
    }
    segments.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cursor = viewport.top;
    let largestHolePx = 0;
    for (const [top, bottom] of segments) {
      if (top > cursor) largestHolePx = Math.max(largestHolePx, top - cursor);
      const start = Math.max(top, cursor);
      if (bottom > start) {
        covered += bottom - start;
        cursor = bottom;
      } else {
        cursor = Math.max(cursor, bottom);
      }
    }
    if (viewport.bottom > cursor) largestHolePx = Math.max(largestHolePx, viewport.bottom - cursor);
    return { covered, largestHolePx };
  }

  function sampleBlank(at) {
    const node = scroller();
    if (!node) {
      return { at, blankRatio: 1, blankPx: 0, viewportPx: 0, mountedRows: 0, coveredPx: 0 };
    }
    const viewport = node.getBoundingClientRect();
    const rows = node.querySelectorAll('[data-feed-row-id]');
    const coverage = unionCoverage(viewport, rows);
    const viewportPx = Math.max(0, viewport.height);
    const blankPx = Math.max(0, viewportPx - coverage.covered);
    return {
      at,
      blankRatio: viewportPx === 0 ? 0 : blankPx / viewportPx,
      blankPx,
      viewportPx,
      mountedRows: rows.length,
      coveredPx: coverage.covered,
      largestHolePx: coverage.largestHolePx,
    };
  }

  function onFrame(now) {
    if (!sampling) return;
    frames.push(now);
    blanks.push(sampleBlank(now));
    rafId = requestAnimationFrame(onFrame);
  }

  function perfSnapshot() {
    const api = window.__droidexPerf;
    if (!api || typeof api.getSnapshot !== 'function') return null;
    return api.getSnapshot();
  }

  window.__guiBench = {
    start() {
      sampling = true;
      phaseStartedAt = performance.now();
      frames.length = 0;
      blanks.length = 0;
      longTasks.length = 0;
      if (typeof PerformanceObserver === 'function') {
        try {
          longObserver?.disconnect();
          longObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTasks.push({ name: entry.name, duration: entry.duration, startTime: entry.startTime });
            }
          });
          longObserver.observe({ type: 'longtask', buffered: false });
        } catch {}
      }
      rafId = requestAnimationFrame(onFrame);
      return true;
    },
    stop() {
      sampling = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      longObserver?.disconnect();
      longObserver = null;
      return window.__guiBench.snapshot();
    },
    snapshot() {
      const expectedFrameMs = 1000 / 60;
      let dropped = 0;
      let longest = 0;
      for (let i = 1; i < frames.length; i += 1) {
        const dt = frames[i] - frames[i - 1];
        longest = Math.max(longest, dt);
        if (dt > expectedFrameMs * 1.5) dropped += 1;
      }
      const phaseTasks = longTasks.filter((task) => task.startTime >= phaseStartedAt);
      const over50 = phaseTasks.filter((task) => task.duration > 50);
      const holeHits = blanks.filter((sample) => sample.largestHolePx > 96);
      let blankDurationMs = 0;
      for (let i = 1; i < blanks.length; i += 1) {
        if (blanks[i].largestHolePx > 96) blankDurationMs += blanks[i].at - blanks[i - 1].at;
      }
      const maxHole = blanks.reduce((max, sample) => Math.max(max, sample.largestHolePx || 0), 0);
      return {
        frameCount: frames.length,
        droppedFrames: dropped,
        longestFrameMs: longest,
        expectedFrames: frames.length === 0 ? 0 : Math.round((frames[frames.length - 1] - frames[0]) / expectedFrameMs),
        longTasksOver50Ms: over50.length,
        longTaskMaxMs: over50.reduce((max, task) => Math.max(max, task.duration), 0),
        longTaskTotalMs: over50.reduce((sum, task) => sum + task.duration, 0),
        blankSampleCount: blanks.length,
        blankHitCount: holeHits.length,
        blankHitRatio: blanks.length === 0 ? 0 : holeHits.length / blanks.length,
        blankDurationMs,
        blankMaxRatio: blanks.reduce((max, sample) => Math.max(max, sample.blankRatio || 0), 0),
        blankMaxHolePx: maxHole,
        mountedRowsMax: blanks.reduce((max, sample) => Math.max(max, sample.mountedRows), 0),
        mountedRowsLast: blanks.length ? blanks[blanks.length - 1].mountedRows : 0,
        rendererPerf: perfSnapshot(),
      };
    },
    sampleBlankNow() {
      return sampleBlank(performance.now());
    },
    waitForChat(sessionId, timeoutMs, previousRowId) {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          const row = document.querySelector('[data-app-session-id="' + sessionId + '"]');
          const selected = Boolean(row && row.getAttribute('aria-current') === 'true');
          const first = document.querySelector('[data-testid="chat-view"] [data-feed-row-id]');
          const firstId = first ? first.getAttribute('data-feed-row-id') : null;
          const feedCount = document.querySelectorAll('[data-testid="chat-view"] [data-feed-row-id]').length;
          const restoring = Boolean(document.querySelector('[data-testid="chat-view"] .z-10.overflow-hidden'));
          const feedChanged = !previousRowId || firstId !== previousRowId;
          if (selected && feedCount > 0 && !restoring && feedChanged) {
            resolve({
              ok: true,
              elapsedMs: performance.now() - started,
              mountedRows: feedCount,
              title: (row && row.textContent) || '',
            });
            return;
          }
          if (performance.now() - started > timeoutMs) {
            reject(new Error('Timed out waiting for chat ' + sessionId + ' (selected=' + selected + ', feed=' + feedCount + ', restoring=' + restoring + ', changed=' + feedChanged + ')'));
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    dismissOverlays() {
      const dismiss = document.querySelector('button[aria-label="Dismiss"]');
      if (dismiss) dismiss.click();
      try { localStorage.setItem('droid-notes-intro-seen', '1'); } catch {}
      return Boolean(dismiss);
    },
    openSession(sessionId) {
      const row = document.querySelector('[data-app-session-id="' + sessionId + '"]');
      if (!row) throw new Error('Session row not found: ' + sessionId);
      const already = row.getAttribute('aria-current') === 'true';
      const previous = document.querySelector('[data-testid="chat-view"] [data-feed-row-id]');
      const previousRowId = already ? null : previous ? previous.getAttribute('data-feed-row-id') : null;
      if (!already) row.click();
      return window.__guiBench.waitForChat(sessionId, 45000, previousRowId);
    },
    sessionIds() {
      return Array.from(document.querySelectorAll('[data-app-session-id]')).map((node) => node.getAttribute('data-app-session-id'));
    },
    activeSessionId() {
      const row = document.querySelector('[data-app-session-id][aria-current="true"]');
      return row ? row.getAttribute('data-app-session-id') : null;
    },
    scrollerBox() {
      const node = scroller();
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(240, rect.height / 2), width: rect.width, height: rect.height, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight };
    },
    scrollMetrics() {
      const node = scroller();
      if (!node) return null;
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    },
    waitForShell(timeoutMs) {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          const button = document.querySelector('[data-testid="new-workspaceless-chat"]');
          const area = document.querySelector('textarea');
          if (button && area) {
            resolve({ elapsedMs: performance.now() - started });
            return;
          }
          if (performance.now() - started > timeoutMs) {
            reject(new Error('Shell never became ready.'));
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    async clickNewChat() {
      const button = document.querySelector('[data-testid="new-workspaceless-chat"]');
      if (!button) throw new Error('new-workspaceless-chat not found');
      button.click();
      const started = performance.now();
      while (performance.now() - started < 15000) {
        const area = document.querySelector('textarea');
        if (area && !area.disabled) return true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error('Composer did not become ready.');
    },
    fillPrompt(text) {
      const area = document.querySelector('textarea');
      if (!area) throw new Error('composer textarea not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
      area.dispatchEvent(new Event('change', { bubbles: true }));
      area.focus();
      return area.value;
    },
    waitForSendReady(timeoutMs) {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          const area = document.querySelector('textarea');
          const shell = document.querySelector('[data-testid="chat-view"]') || document.body;
          const send = Array.from(shell.querySelectorAll('button.rounded-full')).find((button) =>
            button.querySelector('svg'),
          );
          const ready = Boolean(
            area && send && !send.disabled && send.getAttribute('title') !== 'Agent runtime is unavailable',
          );
          if (ready) {
            resolve({ elapsedMs: performance.now() - started, title: send ? send.getAttribute('title') : null });
            return;
          }
          if (performance.now() - started > timeoutMs) {
            reject(
              new Error(
                'Send never became ready (disabled=' +
                  String(send && send.disabled) +
                  ', title=' +
                  (send && send.getAttribute('title')) +
                  ')',
              ),
            );
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    waitForStreamPaint(timeoutMs) {
      const started = performance.now();
      let lastLen = 0;
      let lastPaints = 0;
      let stableSince = started;
      return new Promise((resolve) => {
        const poll = () => {
          const text = (document.querySelector('[data-testid="chat-view"]') || document.body).innerText || '';
          const len = text.length;
          const paints = window.__droidexPerf && window.__droidexPerf.getSnapshot
            ? window.__droidexPerf.getSnapshot().receiveToPaintMs?.count || 0
            : 0;
          if (len > lastLen || paints > lastPaints) {
            lastLen = Math.max(lastLen, len);
            lastPaints = Math.max(lastPaints, paints);
            stableSince = performance.now();
          }
          const grew = lastPaints >= 8 || lastLen > 800;
          const settled = grew && performance.now() - stableSince > 900;
          if (settled || performance.now() - started > timeoutMs) {
            resolve({
              elapsedMs: performance.now() - started,
              textLen: lastLen,
              paints: lastPaints,
              timedOut: !settled,
            });
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    async sendPrompt(text) {
      window.__guiBench.fillPrompt(text);
      await window.__guiBench.waitForSendReady(20000);
      const area = document.querySelector('textarea');
      if (area) area.focus();
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return true;
    },
    childRows() {
      return Array.from(document.querySelectorAll('[data-testid="subagent-row"]')).map((node) => node.getAttribute('data-child-session-id') || node.textContent || '');
    },
    async metrics() {
      if (!window.droidControl || typeof window.droidControl.getPerformanceMetrics !== 'function') return null;
      return window.droidControl.getPerformanceMetrics();
    },
  };
  return 'installed';
})()`;
