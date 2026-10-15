import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harness, fakeFs, removeTempDir, tempDir } from './helpers.mjs';
import { toolNames, applyTextEdits } from '../lib/tools.js';

const server = resolve('test/fixtures/server.mjs');
await chmod(server, 0o755);

async function fixture(t, config = {}, prefix = 'dsh-tools-test-', services = {}) {
  const root = await tempDir(prefix);
  const h = await harness(
    { serverPath: server, workspace: root, vanillaMode: 'disabled', autoRefresh: false, ...config },
    typeof services === 'function' ? services(root) : services,
  );
  t.after(async () => { await h.dispose(); await removeTempDir(root); });
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
  const outside = join(await realpath(tmpdir()), `dsh-outside-${Math.random()}.txt`);
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

test('paradoxcode_read decodes legacy sources, windows lines and reports provenance', async t => {
  const h = await fixture(t);
  await mkdir(join(h.root, 'events'));
  await writeFile(join(h.root, 'events/plain.txt'), 'first\nsecond\nthird\n');
  // Invalid UTF-8: the fixture answers pdc/transcodeDecode with decoded Chinese text.
  await writeFile(join(h.root, 'events/legacy.txt'), Buffer.from([0xff, 0xfe, 0x01]));

  const plain = await h.call('paradoxcode_read', { path: 'events/plain.txt', limit: 2 });
  assert.equal(plain.isError, false, JSON.stringify(plain));
  assert.equal(plain.value.result.text, 'first\nsecond');
  assert.equal(plain.value.result.encoding, 'utf-8');
  assert.equal(plain.value.result.root, 'mod');
  assert.equal(plain.value.result.writable, true);
  assert.equal(plain.value.result.totalLines, 4);
  assert.equal(plain.value.result.truncated, true);
  assert.equal(plain.value.result.nextOffset, 3);
  assert.equal(plain.value.result.lossy, false);
  assert.match(plain.value.result.sha256, /^[a-f0-9]{64}$/);

  const resumed = await h.call('paradoxcode_read', { path: 'events/plain.txt', offset: plain.value.result.nextOffset });
  assert.equal(resumed.value.result.text, 'third\n');
  assert.equal(resumed.value.result.truncated, false);
  assert.equal(resumed.value.result.nextOffset, null);

  const legacy = await h.call('paradoxcode_read', { path: 'events/legacy.txt' });
  assert.equal(legacy.isError, false, JSON.stringify(legacy));
  assert.equal(legacy.value.result.text, '解码后的中文 key = value\n');
  assert.equal(legacy.value.result.encoding, 'transcode:plain');
  assert.equal(legacy.value.result.lossy, false);
});

test('paradoxcode_read refuses paths outside indexed roots, binary data and bad windows', async t => {
  const h = await fixture(t);
  await mkdir(join(h.root, 'events'));
  await writeFile(join(h.root, 'events/binary.txt'), Buffer.from([0x00, 0x01, 0x02]));
  const outside = join(await realpath(tmpdir()), `dsh-read-outside-${Math.random()}.txt`);
  await writeFile(outside, 'key = value');
  t.after(() => rm(outside, { force: true }));
  for (const [args, pattern] of [
    [{ path: outside }, /outside the indexed/],
    [{ path: '../escape.txt' }, /logical path/],
    [{ path: 'events/binary.txt' }, /NUL bytes/],
    [{ path: 'events/plain.txt', line: 1 }, /Unknown parameter/],
    [{ path: 'events/plain.txt', detail: 'full' }, /Unknown parameter/],
  ]) {
    const result = await h.call('paradoxcode_read', args);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, pattern);
  }
  await writeFile(join(h.root, 'events/plain.txt'), 'ab\n');
  const badColumn = await h.call('paradoxcode_read', { path: 'events/plain.txt', character: 5 });
  assert.equal(badColumn.isError, true);
  assert.match(badColumn.content[0].text, /character exceeds/);
});

test('paradoxcode_read keeps every line reachable inside a small display budget', async t => {
  const h = await fixture(t, { maxOutputChars: 2048 });
  await mkdir(join(h.root, 'events'));
  const lines = Array.from({ length: 400 }, (_, n) => `line-${String(n).padStart(3, '0')}-${'x'.repeat(40)}`);
  await writeFile(join(h.root, 'events/wide.txt'), `${lines.join('\n')}\n`);
  const seen = [];
  let offset = 1;
  for (let page = 0; page < 60; page++) {
    const result = await h.call('paradoxcode_read', { path: 'events/wide.txt', offset, limit: 200 });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(result.content[0].text.length <= 2048, `page ${page} exceeded the budget`);
    seen.push(...result.value.result.text.split('\n').filter(Boolean));
    if (!result.value.result.truncated) break;
    assert.ok(result.value.result.nextOffset > offset || result.value.result.lineIncomplete);
    offset = result.value.result.nextOffset;
  }
  assert.deepEqual(seen, lines);
});

test('undecodable sources are reported as lossy with damage metadata and advice', async t => {
  const h = await fixture(t, {}, 'pdc-damaged-');
  await mkdir(join(h.root, 'events'));
  await writeFile(join(h.root, 'events/legacy.txt'), Buffer.from([0xff, 0xfe, 0x01]));
  const read = await h.call('paradoxcode_read', { path: 'events/legacy.txt' });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.value.result.lossy, true);
  assert.deepEqual(read.value.result.damage, { eligible: true, profile: 'localisation', form: 'damaged', error: 'invalid-utf8', refused: 'invalidUtf8' });
  assert.equal(read.value.result.encoding, 'transcode:damaged (lossy)');
  assert.match(read.value.result.warning, /replacement characters/);

  const preview = await h.call('paradoxcode_transcode_preview', { path: 'events/legacy.txt', action: 'decode' });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  assert.equal(preview.value.result.damageSummary, 'form=damaged profile=localisation error=invalid-utf8 refused=invalidUtf8');
  assert.match(preview.value.result.advice.join(' '), /not valid UTF-8/);

  const broken = await fixture(t, {}, 'pdc-refuse-');
  await mkdir(join(broken.root, 'events'));
  await writeFile(join(broken.root, 'events/legacy.txt'), Buffer.from([0xff, 0xfe, 0x01]));
  const escape = await broken.call('paradoxcode_transcode_preview', { path: 'events/legacy.txt', action: 'decode' });
  assert.match(escape.value.result.advice.join(' '), /incomplete at byte 3/);
  const unencodable = await broken.call('paradoxcode_transcode_preview', { path: 'events/legacy.txt', action: 'encode', text: '中文' });
  assert.equal(unencodable.value.result.refused, 'unencodable');
  assert.match(unencodable.value.result.advice.join(' '), /1 character\(s\) cannot be represented/);
});

test('workspace orientation reports server features and summarizes symbol statistics', async t => {
  const plain = await fixture(t);
  const summary = (await plain.call('paradoxcode_workspace')).value.result;
  assert.deepEqual(summary.serverFeatures, {
    queryPagination: true, hiddenEventOptions: true, scanDetails: true, wholeFileTranscode: true,
    missing: [], upgradeRequired: false, available: ['pdcQueryPagination', 'pdcHiddenEventOptions', 'pdcScanDetails', 'pdcWholeFileTranscode'],
  });
  assert.equal(summary.symbols.omitted, true);
  // 0.5.3 reports its own scope strings; the plugin must not overwrite them.
  assert.equal(summary.fileCountsScope, 'all indexed roots');
  assert.equal(summary.scanScope, 'live roots; installed caches excluded');
  const full = (await plain.call('paradoxcode_workspace', { detail: 'full' })).value.result;
  assert.deepEqual(full.symbols, { definitions: { event: 3, mission: 1 }, references: { event: 12 } });

  // A server older than the supported 0.5.3 must be reported, not silently degraded.
  const old = await fixture(t, {}, 'pdc-old-');
  const features = (await old.call('paradoxcode_workspace')).value.result.serverFeatures;
  assert.equal(features.upgradeRequired, true);
  assert.deepEqual(features.missing.map(entry => entry.feature), ['queryPagination', 'hiddenEventOptions', 'scanDetails', 'wholeFileTranscode']);
  assert.ok(features.missing.every(entry => entry.needs === 'ParadoxCode 0.5.3 or newer'));
  await mkdir(join(old.root, 'localisation'));
  await writeFile(join(old.root, 'localisation/k_l_english.yml'), 'l_english:\n key:0 "x"\n');
  const transcode = await old.call('paradoxcode_transcode_preview', { path: 'localisation/k_l_english.yml', action: 'encode', text: 'x' });
  assert.equal(transcode.isError, true);
  assert.match(transcode.content[0].text, /requires ParadoxCode 0.5\.3 or newer/);
  const write = await old.call('paradoxcode_write', { path: 'localisation/k_l_english.yml', text: 'x', expectedSha256: 'a'.repeat(64), apply: true });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /ParadoxCode 0\.5\.3 or newer|Cannot read the session file policy/);
});

test('transcoding is whole-file only: the removed quote-only options are gone', async t => {
  const h = await fixture(t);
  await mkdir(join(h.root, 'localisation'));
  await writeFile(join(h.root, 'localisation/k_l_english.yml'), '\uFEFFl_english:\n key:0 "中文"\n');
  const encoded = await h.call('paradoxcode_transcode_preview', { action: 'encode', path: 'localisation/k_l_english.yml', text: 'l_english:\n key:0 "中文"\n' });
  assert.equal(encoded.isError, false, JSON.stringify(encoded));
  assert.ok(encoded.value.result.bytes);
  assert.match(encoded.value.result.advice.join(' '), /paradoxcode_write/);
  const decoded = await h.call('paradoxcode_transcode_preview', { action: 'decode', path: 'localisation/k_l_english.yml', bytesHex: encoded.value.result.bytes });
  assert.equal(decoded.isError, false, JSON.stringify(decoded));
  assert.equal(decoded.value.result.text, 'l_english:\n key:0 "中文"\n');
  // The 0.5.2-only options are not part of the tool contract any more.
  for (const key of ['quotedOnly', 'preserveEscaped']) {
    const rejected = await h.call('paradoxcode_transcode_preview', { action: 'encode', path: 'localisation/k_l_english.yml', text: 'x', [key]: true });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unknown parameter/);
  }
});

test('legacy query paging requires 0.5.3 and passes nextOffset through', async t => {
  const h = await fixture(t);
  const first = await h.call('paradoxcode_rules', { context: 'trigger', key: 'war' });
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(first.value.result.continuationSupported, true);
  // A continuation without the revision from the first page is rejected instead of racing the index.
  const noRevision = await h.call('paradoxcode_rules', { context: 'trigger', key: 'war', offset: 20 });
  assert.equal(noRevision.isError, true);
  assert.match(noRevision.content[0].text, /Continuations require the revision/);

  const bounded = await fixture(t, {}, 'pdc-bounded-');
  const truncated = await bounded.call('paradoxcode_search', { query: 'EDG' });
  assert.equal(truncated.isError, false, JSON.stringify(truncated));
  assert.equal(truncated.value.result.continuationSupported, true);
  assert.equal(truncated.value.result.nextOffset, 5);
  const continued = await bounded.call('paradoxcode_search', { query: 'EDG', offset: 5, revision: 7 });
  assert.equal(continued.isError, false, JSON.stringify(continued));
  assert.equal(continued.value.result.requestedOffset, 5);
  assert.equal(continued.value.result.requestedRevision, 7);

  const old = await fixture(t, {}, 'pdc-old-');
  const unavailable = await old.call('paradoxcode_rules', { context: 'trigger', key: 'war' });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /upgrade to ParadoxCode 0\.5\.3 or newer/);
});

test('enum parameters are validated instead of degrading silently', async t => {
  const h = await fixture(t);
  // The DSH tool layer rejects schema enums first; option() keeps the same guarantee in-run.
  const detail = await h.call('paradoxcode_workspace', { detail: 'everything' });
  assert.equal(detail.isError, true);
  assert.match(detail.content[0].text, /"detail" must be one of/);
  const values = await h.call('paradoxcode_localisation', { key: 'K', values: 'some' });
  assert.equal(values.isError, true);
  assert.match(values.content[0].text, /"values" must be one of/);
});

test('localisation values modes enumerate keys before fetching text', async t => {
  const h = await fixture(t);
  const full = await h.call('paradoxcode_localisation', { key: 'EDG_KTP_example', keyMatch: 'exact' });
  assert.equal(full.isError, false, JSON.stringify(full));
  assert.equal(full.value.result.hits[0].value.length, 500);
  assert.equal(full.value.result.hits[0].valueLength, undefined);

  const keys = await h.call('paradoxcode_localisation', { key: 'EDG_KTP', keyMatch: 'prefix', values: 'none' });
  assert.equal(keys.value.result.hits[0].value, undefined);
  assert.equal(keys.value.result.hits[0].valueLength, 500);
  assert.equal(keys.value.result.hits[0].key, 'EDG_KTP_example');

  const clipped = await h.call('paradoxcode_localisation', { key: 'EDG_KTP', keyMatch: 'prefix', values: 'truncated' });
  assert.equal(clipped.value.result.hits[0].value.length, 400);
  assert.equal(clipped.value.result.hits[0].valueTruncated, true);
  assert.equal(clipped.value.result.hits[0].valueLength, 500);
});

test('paradoxcode_write previews by default and publishes through the DSH writer for UTF-8', async t => {
  const fs = fakeFs();
  const h = await fixture(t, {}, 'dsh-tools-test-', root => ({ fs, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } }));
  await mkdir(join(h.root, 'events'));
  const target = join(h.root, 'events/plain.txt');
  await writeFile(target, 'alpha\nbeta\n');
  const read = await h.call('paradoxcode_read', { path: 'events/plain.txt' });
  assert.equal(read.isError, false, JSON.stringify(read));

  // Missing or wrong hashes never write; the preview reports the diff without touching disk.
  const missing = await h.call('paradoxcode_write', { path: 'events/plain.txt', text: 'alpha\ngamma\n', apply: true });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /expectedSha256 is required/);
  const stale = await h.call('paradoxcode_write', { path: 'events/plain.txt', text: 'alpha\ngamma\n', expectedSha256: 'b'.repeat(64), apply: true });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /does not match expectedSha256/);

  const preview = await h.call('paradoxcode_write', { path: 'events/plain.txt', text: 'alpha\ngamma\n', expectedSha256: read.value.result.sha256 });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  assert.equal(preview.value.result.applied, false);
  assert.equal(preview.value.result.mode, undefined);
  assert.deepEqual(preview.value.result.preview, { beforeLines: 3, afterLines: 3, firstChangeLine: 2, beforeLine: 'beta', afterLine: 'gamma' });
  assert.equal(preview.value.result.checks.decodeMatches, true);
  assert.equal(preview.value.result.checks.idempotent, null);
  assert.equal(await readFile(target, 'utf8'), 'alpha\nbeta\n');
  assert.equal(fs.calls.write, 0);

  const applied = await h.call('paradoxcode_write', { path: 'events/plain.txt', text: 'alpha\ngamma\n', expectedSha256: read.value.result.sha256, apply: true });
  assert.equal(applied.isError, false, JSON.stringify(applied));
  assert.equal(applied.value.result.applied, true);
  assert.equal(applied.value.result.mode, 'fs');
  assert.equal(applied.value.result.preview, null);
  assert.equal(await readFile(target, 'utf8'), 'alpha\ngamma\n');
  assert.equal(fs.calls.write, 1);
  const backup = join(h.root, applied.value.result.backup);
  assert.equal(await readFile(backup, 'utf8'), 'alpha\nbeta\n');

  // A new file is created when no hash is supplied; supplying one is contradictory.
  const created = await h.call('paradoxcode_write', { path: 'events/new.txt', text: 'fresh\n', apply: true });
  assert.equal(created.isError, false, JSON.stringify(created));
  assert.equal(await readFile(join(h.root, 'events/new.txt'), 'utf8'), 'fresh\n');
  const contradictory = await h.call('paradoxcode_write', { path: 'events/absent.txt', text: 'x', expectedSha256: 'a'.repeat(64) });
  assert.equal(contradictory.isError, true);
  assert.match(contradictory.content[0].text, /does not exist/);
});

test('paradoxcode_write publishes legacy-encoded bytes itself and refuses unsafe writes', async t => {
  // The fixture's legacy codec prefixes bytes that cannot appear in UTF-8, so DSH's writer is unusable.
  const fs = fakeFs();
  const h = await fixture(t, {}, 'pdc-legacy-', root => ({ fs, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } }));
  await mkdir(join(h.root, 'localisation'));
  const target = join(h.root, 'localisation/legacy_l_english.yml');
  await writeFile(target, Buffer.concat([Buffer.from([0xb0, 0xa1]), Buffer.from('l_english:\n key:0 "中文"\n', 'utf8')]));
  const read = await h.call('paradoxcode_read', { path: 'localisation/legacy_l_english.yml' });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.value.result.encoding, 'transcode:whole');
  assert.equal(read.value.result.text, 'l_english:\n key:0 "中文"\n');

  const applied = await h.call('paradoxcode_write', { path: 'localisation/legacy_l_english.yml', text: 'l_english:\n key:0 "新的中文"\n', expectedSha256: read.value.result.sha256, apply: true });
  assert.equal(applied.isError, false, JSON.stringify(applied));
  assert.equal(applied.value.result.mode, 'bytes');
  assert.equal(applied.value.result.encoding.encoded, true);
  assert.equal(applied.value.result.checks.idempotent, true);
  assert.equal(fs.calls.write, 0);
  assert.deepEqual([...await readFile(target)].slice(0, 2), [0xb0, 0xa1]);
  const reread = await h.call('paradoxcode_read', { path: 'localisation/legacy_l_english.yml' });
  assert.equal(reread.value.result.encoding, 'transcode:whole');
  assert.equal(reread.value.result.text, 'l_english:\n key:0 "新的中文"\n');

  // `encode: true` stores the escaped form for a brand new file.
  const escaped = await h.call('paradoxcode_write', { path: 'localisation/fresh_l_english.yml', text: 'l_english:\n fresh:0 "中文"\n', encode: true, apply: true });
  assert.equal(escaped.isError, false, JSON.stringify(escaped));
  assert.equal(escaped.value.result.mode, 'bytes');
  assert.deepEqual([...await readFile(join(h.root, 'localisation/fresh_l_english.yml'))].slice(0, 2), [0xb0, 0xa1]);

  // Policy fence: read-only denies, a foreign workspace root denies, a missing service fails closed.
  for (const [services, pattern] of [
    [{ fs, sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: h.root }) } }, /denied under "read-only"/],
    [{ fs, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(process.cwd(), 'not-the-workspace') }) } }, /outside the policy workspace root/],
    [{ fs }, /sandboxPolicy service unavailable/],
  ]) {
    const fenced = await fixture(t, {}, 'dsh-tools-test-', services);
    await mkdir(join(fenced.root, 'events'));
    await writeFile(join(fenced.root, 'events/plain.txt'), 'alpha\n');
    const result = await fenced.call('paradoxcode_write', { path: 'events/plain.txt', text: 'beta\n', expectedSha256: (await fenced.call('paradoxcode_read', { path: 'events/plain.txt' })).value.result.sha256, apply: true });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, pattern);
    assert.equal(await readFile(join(fenced.root, 'events/plain.txt'), 'utf8'), 'alpha\n');
  }
});

test('paradoxcode_write refuses damaged sources, dependency roots and unencodable text', async t => {
  const damaged = await fixture(t, {}, 'pdc-damaged-', root => ({ fs: fakeFs(), sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } }));
  await mkdir(join(damaged.root, 'localisation'));
  await writeFile(join(damaged.root, 'localisation/k_l_english.yml'), Buffer.from([0xff, 0xfe, 0x01]));
  const lossy = await damaged.call('paradoxcode_write', { path: 'localisation/k_l_english.yml', text: 'x', expectedSha256: 'a'.repeat(64), apply: true });
  assert.equal(lossy.isError, true);
  assert.match(lossy.content[0].text, /cannot be decoded faithfully/);

  const refuse = await fixture(t, {}, 'pdc-refuse-', root => ({ fs: fakeFs(), sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } }));
  await mkdir(join(refuse.root, 'localisation'));
  await writeFile(join(refuse.root, 'localisation/k_l_english.yml'), 'l_english:\n key:0 "x"\n');
  const read = await refuse.call('paradoxcode_read', { path: 'localisation/k_l_english.yml' });
  const unencodable = await refuse.call('paradoxcode_write', { path: 'localisation/k_l_english.yml', text: '中文', expectedSha256: read.value.result.sha256, encode: true, apply: true });
  assert.equal(unencodable.isError, true);
  assert.match(unencodable.content[0].text, /refused to encode.*unencodable/s);
  // Without encode the same text is written as plain UTF-8, which needs no transcode profile.
  const plain = await refuse.call('paradoxcode_write', { path: 'localisation/k_l_english.yml', text: 'l_english:\n key:0 "中文"\n', expectedSha256: read.value.result.sha256, apply: true });
  assert.equal(plain.isError, false, JSON.stringify(plain));
  assert.equal(plain.value.result.encoding.encoded, false);
  assert.equal(await readFile(join(refuse.root, 'localisation/k_l_english.yml'), 'utf8'), 'l_english:\n key:0 "中文"\n');

  const h = await fixture(t, {}, 'dsh-tools-test-', root => ({ fs: fakeFs(), sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } }));
  const outside = await h.call('paradoxcode_write', { path: '../escape.txt', text: 'x', apply: true });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /logical path/);
  // An indexed dependency root is writable=false, so the writer must stay inside the Mod root.
  const dependency = await h.call('paradoxcode_write', { path: '../other-mod/events/a.txt', text: 'x', apply: true });
  assert.equal(dependency.isError, true);
  assert.match(dependency.content[0].text, /logical path|outside the Mod root/);
});
