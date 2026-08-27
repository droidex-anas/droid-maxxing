export const GUI_BENCH_PROBE_SOURCE = `(function installGuiBenchProbe() {
  if (window.__guiBench) return 'already';
  const longTasks = [];
  const frames = [];
  const blanks = [];
  let sampling = false;
  let rafId = 0;
  let longObserver = null;

  function scroller() {
    return document.querySelector('[data-testid="chat-view"] .overflow-y-auto');
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
    for (const [top, bottom] of segments) {
      const start = Math.max(top, cursor);
      if (bottom > start) {
        covered += bottom - start;
        cursor = bottom;
      }
    }
    return covered;
  }

  function sampleBlank(at) {
    const node = scroller();
    if (!node) {
      return { at, blankRatio: 1, blankPx: 0, viewportPx: 0, mountedRows: 0, coveredPx: 0 };
    }
    const viewport = node.getBoundingClientRect();
    const rows = node.querySelectorAll('[data-feed-row-id]');
    const coveredPx = unionCoverage(viewport, rows);
    const viewportPx = Math.max(0, viewport.height);
    const blankPx = Math.max(0, viewportPx - coveredPx);
    return {
      at,
      blankRatio: viewportPx === 0 ? 0 : blankPx / viewportPx,
      blankPx,
      viewportPx,
      mountedRows: rows.length,
      coveredPx,
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
          longObserver.observe({ type: 'longtask', buffered: true });
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
      const over50 = longTasks.filter((task) => task.duration > 50);
      const blankHits = blanks.filter((sample) => sample.blankRatio > 0.08);
      let blankDurationMs = 0;
      for (let i = 1; i < blanks.length; i += 1) {
        if (blanks[i].blankRatio > 0.08) blankDurationMs += blanks[i].at - blanks[i - 1].at;
      }
      return {
        frameCount: frames.length,
        droppedFrames: dropped,
        longestFrameMs: longest,
        expectedFrames: frames.length === 0 ? 0 : Math.round((frames[frames.length - 1] - frames[0]) / expectedFrameMs),
        longTasksOver50Ms: over50.length,
        longTaskMaxMs: over50.reduce((max, task) => Math.max(max, task.duration), 0),
        longTaskTotalMs: over50.reduce((sum, task) => sum + task.duration, 0),
        blankSampleCount: blanks.length,
        blankHitCount: blankHits.length,
        blankHitRatio: blanks.length === 0 ? 0 : blankHits.length / blanks.length,
        blankDurationMs,
        blankMaxRatio: blanks.reduce((max, sample) => Math.max(max, sample.blankRatio), 0),
        mountedRowsMax: blanks.reduce((max, sample) => Math.max(max, sample.mountedRows), 0),
        mountedRowsLast: blanks.length ? blanks[blanks.length - 1].mountedRows : 0,
        rendererPerf: perfSnapshot(),
      };
    },
    sampleBlankNow() {
      return sampleBlank(performance.now());
    },
    waitForChat(sessionId, timeoutMs) {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          const row = document.querySelector('[data-app-session-id="' + sessionId + '"]');
          const feed = document.querySelector('[data-testid="chat-view"] [data-feed-row-id]');
          const skeleton = document.querySelector('[data-testid="chat-view"] .absolute.inset-0');
          const selected = row && row.getAttribute('aria-current') === 'true';
          const hasFeed = Boolean(feed);
          const restoring = Boolean(skeleton);
          if ((selected || hasFeed) && hasFeed && !restoring) {
            resolve({
              ok: true,
              elapsedMs: performance.now() - started,
              mountedRows: document.querySelectorAll('[data-testid="chat-view"] [data-feed-row-id]').length,
              title: (row && row.textContent) || '',
            });
            return;
          }
          if (performance.now() - started > timeoutMs) {
            reject(new Error('Timed out waiting for chat ' + sessionId + ' (feed=' + hasFeed + ', restoring=' + restoring + ')'));
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    },
    openSession(sessionId) {
      const row = document.querySelector('[data-app-session-id="' + sessionId + '"]');
      if (!row) throw new Error('Session row not found: ' + sessionId);
      row.click();
      return window.__guiBench.waitForChat(sessionId, 45000);
    },
    sessionIds() {
      return Array.from(document.querySelectorAll('[data-app-session-id]')).map((node) => node.getAttribute('data-app-session-id'));
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
    async sendPrompt(text) {
      const area = document.querySelector('textarea');
      if (!area) throw new Error('composer textarea not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
      area.focus();
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
