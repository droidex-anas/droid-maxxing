import assert from 'node:assert/strict';
import test from 'node:test';

import { ChildSessions } from './ChildSessions.js';
import { MissionControlPolicy } from './MissionControlPolicy.js';
import { SessionLifecycle } from './SessionLifecycle.js';
import { SessionTimeline } from './SessionTimeline.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

test(
  'shutdown runs the generic child safety sweep before clearing Mission policy',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const closeAll = SessionLifecycle.prototype.closeAll;
    const shutdownChildren = ChildSessions.prototype.shutdown;
    const clearMission = MissionControlPolicy.prototype.clear;
    SessionLifecycle.prototype.closeAll = async function () {
      await closeAll.call(this);
      order.push('lifecycle.closeAll');
    };
    ChildSessions.prototype.shutdown = async function () {
      order.push('children.shutdown');
      await shutdownChildren.call(this);
    };
    MissionControlPolicy.prototype.clear = function () {
      order.push('mission.clear');
      clearMission.call(this);
    };

    const harness = createSessionManagerTestContext();
    try {
      await harness.shutdown();
      assert.deepEqual(order, ['lifecycle.closeAll', 'children.shutdown', 'mission.clear']);
    } finally {
      SessionLifecycle.prototype.closeAll = closeAll;
      ChildSessions.prototype.shutdown = shutdownChildren;
      MissionControlPolicy.prototype.clear = clearMission;
      await harness.dispose();
    }
  },
);

test(
  'shutdown drains timeline buffers before closing authoritative history',
  { concurrency: false },
  async () => {
    const order: string[] = [];
    const flushStreaming = SessionTimeline.prototype.flushStreaming;
    SessionTimeline.prototype.flushStreaming = function () {
      order.push('timeline.flushStreaming');
      flushStreaming.call(this);
    };

    const harness = createSessionManagerTestContext();
    const historyClose = harness.history.close.bind(harness.history);
    harness.history.close = () => {
      order.push('history.close');
      historyClose();
    };
    try {
      await harness.shutdown();
      assert.deepEqual(order, ['timeline.flushStreaming', 'history.close']);
    } finally {
      SessionTimeline.prototype.flushStreaming = flushStreaming;
      await harness.dispose();
    }
  },
);
