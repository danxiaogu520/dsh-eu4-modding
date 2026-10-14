import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultStore, diagnosticPage } from '../lib/results.js';

test('snapshot retention is bounded, recent active cursors survive, and invalidation is explicit', () => {
  const store = new ResultStore();
  const active = store.save('active', { result: 'first' });
  for (let n = 0; n < 30; n++) { store.get(active); store.save('other', { n }); }
  assert.equal(store.get(active).value.result, 'first');
  assert.throws(() => store.get(active, 'wrong'), /another tool/);
  store.invalidate();
  assert.throws(() => store.get(active), /expired/);
});

test('line filtering includes diagnostics overlapping the requested source range', () => {
  const raw = [{ path: 'events/x.txt', diagnostics: [{ severity: 1, code: 'ParseError', range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } } }] }];
  const page = diagnosticPage(raw, { startLine: 5, endLine: 5 }, 0, 10);
  assert.equal(page.filteredCounts.total, 1);
  assert.equal(diagnosticPage(raw, { startLine: 6, endLine: 6 }, 0, 10).filteredCounts.total, 0);
  assert.throws(() => diagnosticPage(raw, { codes: [1] }, 0, 10), /diagnostic codes/);
  assert.throws(() => diagnosticPage([{ path: 'bad' }], {}, 0, 10), /missing/);
});
