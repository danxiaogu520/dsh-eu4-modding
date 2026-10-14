import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harness } from './helpers.mjs';
import { toolNames, applyTextEdits } from '../lib/tools.js';

const server = resolve('test/fixtures/server.mjs');
await chmod(server, 0o755);

async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tools-test-'));
  const h = await harness({ serverPath: server, workspace: root, vanillaMode: 'disabled', autoRefresh: false, ...config });
  t.after(async () => { await h.dispose(); await rm(root, { recursive: true, force: true }); });
  return { ...h, root };
}

test('plugin loads into real Cordis/tools runtime, contributes workflow, and unloads cleanly', async t => {
  const h = await fixture(t);
  const assembly = await h.ctx.systemPrompt.assemble();
  assert.deepEqual(assembly.tools.map(x => x.name).sort(), [...toolNames].sort());
  assert.match(assembly.sections.find(x => x.name === 'eu4-modding:workflow').text, /Jointly validate/);
  const result = await h.call('paradoxcode_workspace');
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.workspace, h.root);
  await h.pluginFork.dispose();
  const after = await h.ctx.systemPrompt.assemble();
  assert.equal(after.tools.length, 0);
  assert.equal(after.sections.some(x => x.name === 'eu4-modding:workflow'), false);
});

test('invalid schemas, limits, filters and logical paths are rejected', async t => {
  const h = await fixture(t);
  for (const [name, args] of [
    ['paradoxcode_search', { query: 'x' }],
    ['paradoxcode_search', { query: 'test', limit: 0 }],
    ['paradoxcode_search', { query: 2 }],
    ['paradoxcode_search', { query: 'test', typo: true }],
    ['paradoxcode_rules', {}],
    ['paradoxcode_validate_text', { files: [] }],
    ['paradoxcode_validate_text', { files: [{ path: '../events/test.txt', text: '' }] }],
    ['paradoxcode_validate_text', { files: [{ path: 'events/t.txt', text: '' }, { path: 'events/t.txt', text: '' }] }],
    ['paradoxcode_diagnostics', { files: [] }],
  ]) {
    const result = await h.call(name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  }
});

test('document drafts close their overlays, and UTF-16 cursor positions are validated', async t => {
  const h = await fixture(t);
  const args = { action: 'hover', path: 'events/draft.txt', text: '😀 key = value', line: 1, character: 3 };
  const result = await h.call('paradoxcode_document', args);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.result.params.position.character, 3);
  const next = await h.call('paradoxcode_search', { query: 'test' });
  assert.ok(next.value.result.notifications.some(n => n.method === 'textDocument/didClose'));
  assert.equal((await h.call('paradoxcode_document', { ...args, character: 100 })).isError, true);
});

test('session cwd selects the Mod, and explicit tool workspace overrides plugin defaults', async t => {
  const h = await fixture(t, { workspace: '' });
  // A minimal caller is sufficient for this workspace-selection seam.
  const result = await h.call('paradoxcode_workspace', {}, undefined, { session: { header: { cwd: h.root } } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.workspace, h.root);
  const second = join(h.root, 'other-mod');
  await mkdir(second);
  const override = await h.call('paradoxcode_workspace', { workspace: second });
  assert.equal(override.value.workspace, second);
});

test('bounded native rendering preserves full canonical JSON for PTC', async t => {
  const h = await fixture(t, { maxOutputChars: 1024 });
  const result = await h.call('paradoxcode_search', { query: 'z'.repeat(4000) });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Native display truncated/);
  assert.equal(result.value.result.params.query.length, 4000);
});

test('formatting edit application respects CRLF and UTF-16; overlapping edits fail', () => {
  const range = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
  assert.equal(applyTextEdits('😀 key\r\nother\r\n', [{ range: range(0, 3, 0, 6), newText: 'value' }]), '😀 value\r\nother\r\n');
  assert.throws(() => applyTextEdits('abcdef', [
    { range: range(0, 1, 0, 4), newText: 'x' }, { range: range(0, 2, 0, 5), newText: 'y' },
  ]), /Overlapping/);
});

test('filesystem document access is restricted to indexed roots', async t => {
  const h = await fixture(t);
  const outside = join(tmpdir(), `dsh-outside-${Math.random()}.txt`);
  await writeFile(outside, 'key = value');
  t.after(() => rm(outside, { force: true }));
  const result = await h.call('paradoxcode_document', { action: 'symbols', path: outside });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outside the indexed/);
});

test('a large single file can be exhausted with diagnostic cursors and honest per-file counts', async t => {
  const h = await fixture(t, { maxOutputChars: 1024 });
  const first = await h.call('paradoxcode_diagnostics', { files: ['events/large.txt', 'events/clean.txt'], diagnosticLimit: 17 });
  assert.equal(first.isError, false, JSON.stringify(first));
  let page = first.value.result;
  assert.equal(page.counts.total, 300);
  assert.equal(page.items[1].counts.total, 0);
  assert.equal(page.items[0].diagnosticsComplete, false);
  assert.equal(JSON.parse(first.content[0].text).result.counts.total, 300);
  const lines = [];
  for (;;) {
    lines.push(...page.items.flatMap(file => file.diagnostics.map(d => d.line)));
    if (page.nextDiagnosticOffset === null) break;
    const next = await h.call('paradoxcode_diagnostics', { snapshot: page.snapshot, diagnosticOffset: page.nextDiagnosticOffset, diagnosticLimit: 17 });
    assert.equal(next.isError, false, JSON.stringify(next));
    assert.ok(next.content[0].text.length <= 1024);
    page = next.value.result;
  }
  assert.deepEqual(lines, Array.from({ length: 300 }, (_, n) => n + 1));
  const filtered = await h.call('paradoxcode_diagnostics', { files: ['events/large.txt'], severity: 'error', codes: ['UnknownKey'], startLine: 11, endLine: 20 });
  assert.equal(filtered.value.result.counts.total, 300);
  assert.equal(filtered.value.result.filteredCounts.total, 5);
  assert.deepEqual(filtered.value.result.items[0].diagnostics.map(d => d.line), [11, 13, 15, 17, 19]);
  assert.equal((await h.call('paradoxcode_diagnostics', { snapshot: page.snapshot, severity: 'error' })).isError, true);
});

test('native retrieval reconstructs complete JSON and expires after refresh', async t => {
  const h = await fixture(t, { maxOutputChars: 1024 });
  const result = await h.call('paradoxcode_search', { query: '中文😀'.repeat(1000) });
  assert.equal(result.isError, false);
  const { token } = result.value.retrieval;
  let offset = 0, full = '';
  for (;;) {
    const chunk = await h.call('paradoxcode_result', { token, offset });
    assert.equal(chunk.isError, false, JSON.stringify(chunk));
    assert.ok(chunk.content[0].text.length <= 1024);
    full += chunk.value.result.chunk;
    if (chunk.value.result.complete) break;
    assert.ok(chunk.value.result.nextOffset > offset);
    offset = chunk.value.result.nextOffset;
  }
  assert.deepEqual(JSON.parse(full), { workspace: result.value.workspace, result: result.value.result });
  await h.call('paradoxcode_refresh');
  assert.equal((await h.call('paradoxcode_result', { token })).isError, true);
});

test('all drafts are open together and their overlays are restored before returning', async t => {
  const h = await fixture(t);
  const batch = await h.call('paradoxcode_validate_text', { files: [
    { path: 'events/draft.txt', text: 'country_event = { id = batch.1 hidden = yes }' },
    { path: 'localisation/batch_l_english.yml', text: 'l_english:\n batch.1.t:0 "Title"\n' },
  ] });
  assert.equal(batch.isError, false, JSON.stringify(batch));
  assert.ok(batch.value.result.files.every(file => file.openCount === 2 && file.counts.total === 0));
  const after = await h.call('paradoxcode_search', { query: 'batch' });
  const closed = after.value.result.notifications.filter(note => note.method === 'textDocument/didClose');
  assert.equal(closed.length, 2);
});
