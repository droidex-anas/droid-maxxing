import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Markdown } from '../components/Markdown';
import { appFencesInMarkdown } from './appBlocks';
import { ingestStreamingMarkdown } from './streamingMarkdown';

function padParagraphs(targetBytes: number): string {
  const chunk = 'This is a realistic assistant paragraph with enough texture to parse.\n\n';
  let source = '';
  while (source.length < targetBytes) source += chunk;
  return source;
}

function growingMessage(closedBytes: number, pendingLines: number): string {
  return `${padParagraphs(closedBytes)}\`\`\`js\n${'const value = 1;\n'.repeat(pendingLines)}`;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  return value ?? 0;
}

function measure(fn: () => void, rounds = 12): number {
  fn();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

const SIZES = [1_024, 10_240, 51_200] as const;

test('per-delta streaming work stays with the pending region as the message grows', () => {
  const rows: Array<{
    bytes: number;
    canonicalMs: number;
    streamingMs: number;
    scannedChars: number;
    appFenceScanMs: number;
  }> = [];

  for (const bytes of SIZES) {
    const source = growingMessage(bytes, 8);
    const canonicalMs = measure(() => {
      appFencesInMarkdown(source);
      renderToStaticMarkup(createElement(Markdown, null, source));
    });
    const appFenceScanMs = measure(() => {
      appFencesInMarkdown(source);
    });
    const closed = padParagraphs(bytes);
    const prior = ingestStreamingMarkdown(null, closed);
    const ingest = ingestStreamingMarkdown({ source: closed, document: prior.document }, source);
    const pending = ingest.document.pendingSource;
    const streamingMs = measure(() => {
      ingestStreamingMarkdown({ source: closed, document: prior.document }, source);
      renderToStaticMarkup(createElement(Markdown, null, pending));
    });
    rows.push({
      bytes,
      canonicalMs,
      streamingMs,
      scannedChars: ingest.stats.scannedChars,
      appFenceScanMs,
    });
    assert.equal(ingest.stats.usedIncremental, true);
    assert.ok(ingest.stats.scannedChars < source.length / 2);
  }

  const small = rows[0];
  const large = rows[2];
  assert.ok(small && large);
  assert.ok(
    large.scannedChars < small.bytes,
    'large-message pending scan should not grow with the frozen prefix',
  );
  console.info('stream-md per-delta cost', JSON.stringify(rows, null, 2));
});
