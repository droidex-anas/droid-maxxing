#!/usr/bin/env node
// Measures sidecar boot impact: first sessions.list latency, 2s CPU, 1s peak threads/RSS.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { WebSocket } = require(join(__dirname, '..', 'sidecar', 'node_modules', 'ws'));

const RUNS = Number(process.env.RUNS || 15);
const ENTRY =
  process.argv[2] || join(__dirname, '..', 'sidecar', 'dist', 'sidecar.mjs');
const BRIDGE_PROTOCOL = 3;
const CLK_TCK = 100;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function spread(nums) {
  return Math.max(...nums) - Math.min(...nums);
}

function summarize(name, samples) {
  return {
    name,
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    spread: spread(samples),
    samples,
  };
}

function providerSessionJsonl(sessionStart, messageRoles = ['user', 'assistant']) {
  const messages = messageRoles.map((role) => ({
    type: 'message',
    timestamp: '2026-08-09T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text: 'hello' }] },
  }));
  return `${[sessionStart, ...messages].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function seedHome(home) {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bench-session.jsonl'),
    providerSessionJsonl(
      {
        type: 'session_start',
        cwd: join(home, 'workspace'),
        sessionTitle: 'Bench session',
        settings: { interactionMode: 'auto' },
      },
      ['user', 'assistant'],
    ),
  );
}

async function readProcStat(pid) {
  const raw = await fsp.readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const close = raw.lastIndexOf(')');
  const rest = raw.slice(close + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return (utime + stime) / CLK_TCK;
}

async function readProcStatus(pid) {
  const raw = await fsp.readFile(`/proc/${String(pid)}/status`, 'utf8');
  let threads = 0;
  let rssKb = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('Threads:')) threads = Number(line.split(/\s+/)[1] ?? 0);
    if (line.startsWith('VmRSS:')) rssKb = Number(line.split(/\s+/)[1] ?? 0);
  }
  return { threads, rssKb };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionsList(port, token) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${String(port)}/?token=${encodeURIComponent(token)}&bridgeProtocol=${String(BRIDGE_PROTOCOL)}`,
  );
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const listPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sessions.list timeout')), 30_000);
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type !== 'events.batch' || !Array.isArray(message.events)) return;
        for (const entry of message.events) {
          if (entry?.event?.type === 'sessions.list') {
            clearTimeout(timeout);
            resolve(entry.event);
            return;
          }
        }
      } catch {
        // ignore malformed frames
      }
    });
  });

  socket.send(JSON.stringify({ type: 'sessions.list' }));
  const event = await listPromise;
  socket.close();
  return event;
}

async function sampleProcess(pid, durationMs, intervalMs, onSample) {
  const endAt = performance.now() + durationMs;
  while (performance.now() < endAt) {
    try {
      await onSample();
    } catch {
      break;
    }
    await sleep(intervalMs);
  }
}

async function measureOnce(home) {
  await fsp.mkdir(home, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  const assetToken = crypto.randomBytes(32).toString('hex');
  const spawnAt = performance.now();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_TOKEN: token,
      BROWSER_ASSET_TOKEN: assetToken,
      BRIDGE_PORT: '0',
      DROIDEX_USER_DATA_DIR: home,
      HOME: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let readyMs = null;
  let peakThreads = 0;
  let peakRssKb = 0;
  let cpuStart = null;
  let cpuEnd = null;

  const sampler = child.pid
    ? sampleProcess(child.pid, 1000, 20, async () => {
        const status = await readProcStatus(child.pid);
        peakThreads = Math.max(peakThreads, status.threads);
        peakRssKb = Math.max(peakRssKb, status.rssKb);
      })
    : Promise.resolve();

  const cpuSampler = child.pid
    ? (async () => {
        cpuStart = await readProcStat(child.pid);
        await sleep(2000);
        try {
          cpuEnd = await readProcStat(child.pid);
        } catch {
          cpuEnd = cpuStart;
        }
      })()
    : Promise.resolve();

  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SIDECAR_READY timeout')), 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/SIDECAR_READY (\d+)/);
      if (!match) return;
      readyMs = performance.now() - spawnAt;
      resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (readyMs === null) {
        reject(new Error(`exited ${String(code)} before ready: ${stdout}`));
      }
    });
  });

  const port = await readyPromise;
  const listEvent = await waitForSessionsList(port, token);
  const firstListMs = performance.now() - spawnAt;

  await Promise.all([sampler, cpuSampler]);
  child.kill();

  if (listEvent?.type !== 'sessions.list' || !Array.isArray(listEvent.sessions)) {
    throw new Error(`sessions.list missing or malformed: ${JSON.stringify(listEvent)}`);
  }

  return {
    readyMs,
    firstListMs,
    bootCpuSec: Math.max(0, (cpuEnd ?? 0) - (cpuStart ?? 0)),
    peakThreads,
    peakRssKb,
  };
}

async function runLabel(label) {
  const ready = [];
  const firstList = [];
  const bootCpu = [];
  const peakThreads = [];
  const peakRssMb = [];

  for (let i = 0; i < RUNS; i += 1) {
    const home = join('/tmp', `droid-sidecar-bench-${process.pid}-${label}-${String(i)}`);
    await fsp.rm(home, { recursive: true, force: true });
    const sample = await measureOnce(home);
    ready.push(sample.readyMs);
    firstList.push(sample.firstListMs);
    bootCpu.push(sample.bootCpuSec);
    peakThreads.push(sample.peakThreads);
    peakRssMb.push(sample.peakRssKb / 1024);
    await fsp.rm(home, { recursive: true, force: true });
  }

  return {
    label,
    entry: ENTRY,
    runs: RUNS,
    ready: summarize('readyMs', ready),
    firstList: summarize('firstListMs', firstList),
    bootCpu: summarize('bootCpuSec', bootCpu),
    peakThreads: summarize('peakThreads', peakThreads),
    peakRssMb: summarize('peakRssMb', peakRssMb),
  };
}

runLabel(process.env.LABEL || 'current')
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
