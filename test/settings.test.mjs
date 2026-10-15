import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { Config, normalizeConfig } from '../lib/config.js';
import { dependencyChain } from '../lib/dependencies.js';
import { loadWorkspace, readSettings, saveDependencies } from '../lib/settings.js';
import { WorkspacePool } from '../lib/workspace.js';
import { harness, removeTempDir, tempDir } from './helpers.mjs';

const serverPath = resolve('test/fixtures/server.mjs');
async function fixture(t) {
  const parent = await tempDir('dsh-settings-test-');
  t.after(() => removeTempDir(parent));
  const roots = Object.fromEntries(['main', 'A', 'B', 'C', 'D'].map(name => [name, join(parent, name)]));
  for (const root of Object.values(roots)) await mkdir(root);
  return roots;
}
async function settings(root, data) {
  await mkdir(join(root, '.vscode'), { recursive: true });
  await writeFile(join(root, '.vscode', 'settings.json'), typeof data === 'string' ? data : JSON.stringify(data));
}
const dep = id => ({ id, path: `../${id}` });

test('VS Code JSONC settings map to analysis options with explicit DSH overrides, including empty lists', async t => {
  const { main, A } = await fixture(t);
  await settings(main, '\uFEFF{\r\n // shared workspace\r\n "paradoxcode.dependencies": [{"id":"A","path":"../A"},],\r\n "paradoxcode.vanilla.mode":"disabled",\r\n "paradoxcode.localisation.preferredLanguages":["french"],\r\n "paradoxcode.ignoreDirectories":["build"],\r\n "paradoxcode.gameDirectory":"../game",\r\n "editor.fontSize":14,\r\n}\r\n');
  const loaded = await loadWorkspace(main, normalizeConfig());
  assert.deepEqual(loaded.dependencies, [{ id: 'A', path: A }]);
  assert.equal(loaded.options.vanillaMode, 'disabled');
  assert.deepEqual(loaded.options.preferredLocalisationLanguages, ['french']);
  assert.deepEqual(loaded.options.ignoreDirectories, ['build']);
  assert.equal(loaded.options.gameDirectory, resolve(main, '../game'));
  assert.equal(loaded.options['editor.fontSize'], undefined);
  const overridden = await loadWorkspace(main, normalizeConfig({ dependencies: [], vanillaMode: 'cacheOnly', gameDirectory: '' }));
  assert.deepEqual(overridden.dependencies, []);
  assert.equal(overridden.dependenciesSource, 'plugin');
  assert.equal(overridden.options.vanillaMode, 'cacheOnly');
  assert.equal(overridden.options.gameDirectory, undefined);
  assert.deepEqual(Config.simplify({ dependencies: [] }), { dependencies: [] });
});

test('modDirectory uses the VS Code workspace as the base for dependency and cache paths', async t => {
  const { main, A } = await fixture(t);
  const mod = join(main, 'mod');
  await mkdir(mod);
  await settings(main, { 'paradoxcode.modDirectory': 'mod', 'paradoxcode.dependencies': [dep('A')], 'paradoxcode.vanillaIndexCache': '../vanilla.pdcindex' });
  const loaded = await loadWorkspace(main, normalizeConfig());
  assert.equal(loaded.root, mod);
  assert.equal(loaded.dependencies[0].path, A);
  assert.equal(loaded.options.vanillaIndexCache, resolve(main, '../vanilla.pdcindex'));
});

test('dependency inspection and chain syncing work before the language server is installed', async t => {
  const { main, A, B, C } = await fixture(t);
  await settings(main, '{\r\n  // keep this comment\r\n  "editor.fontSize": 17,\r\n  "paradoxcode.dependencies": [\r\n    // foundation note\r\n    {"id":"A","path":"../A"}, /* expansion note */ {"id":"B","path":"../B"}],\r\n}\r\n');
  for (const root of [A, B]) await settings(root, { 'paradoxcode.dependencies': [dep('C')] });
  const h = await harness({ serverPath: '/missing/server', workspace: main });
  t.after(() => h.dispose());
  const inspected = await h.call('paradoxcode_dependencies');
  assert.equal(inspected.isError, false, JSON.stringify(inspected));
  assert.equal(inspected.value.result.needsSync, true);
  assert.deepEqual(inspected.value.result.loadOrder.map(row => row.id), ['C', 'A', 'B']);
  // Analysis uses exactly the explicit list until the user invokes sync, matching VS Code.
  assert.deepEqual((await loadWorkspace(main, normalizeConfig())).dependencies.map(row => row.id), ['A', 'B']);
  const saved = await h.call('paradoxcode_dependencies', { action: 'sync', baseHash: inspected.value.result.baseHash });
  assert.equal(saved.isError, false, JSON.stringify(saved));
  const text = await readFile(join(main, '.vscode', 'settings.json'), 'utf8');
  assert.match(text, /keep this comment/);
  assert.match(text, /foundation note/);
  assert.match(text, /expansion note/);
  assert.ok(!text.replaceAll('\r\n', '').includes('\n'));
  const file = parse(text, [], { allowTrailingComma: true });
  assert.equal(file['editor.fontSize'], 17);
  assert.deepEqual(file['paradoxcode.dependencies'], [dep('C'), dep('A'), dep('B')]);
  assert.deepEqual((await loadWorkspace(main, normalizeConfig())).dependencies.map(row => row.path), [C, A, B]);
  assert.equal(saved.value.result.needsSync, false);
});

test('add, remove and set preserve shared editor settings and refuse stale inspection hashes', async t => {
  const { main } = await fixture(t);
  await settings(main, { 'editor.wordWrap': 'on', 'paradoxcode.dependencies': [] });
  const h = await harness({ serverPath: '/missing/server', workspace: main });
  t.after(() => h.dispose());
  const inspect = await h.call('paradoxcode_dependencies');
  const add = await h.call('paradoxcode_dependencies', { action: 'add', dependencies: [dep('A')], baseHash: inspect.value.result.baseHash });
  assert.equal(add.isError, false, JSON.stringify(add));
  const stale = await h.call('paradoxcode_dependencies', { action: 'set', dependencies: [], baseHash: inspect.value.result.baseHash });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /changed since inspection/);
  const remove = await h.call('paradoxcode_dependencies', { action: 'remove', id: 'a', baseHash: add.value.result.baseHash });
  assert.equal(remove.isError, false, JSON.stringify(remove));
  const set = await h.call('paradoxcode_dependencies', { action: 'set', dependencies: [dep('D')], baseHash: remove.value.result.baseHash });
  assert.equal(set.isError, false, JSON.stringify(set));
  const file = (await readSettings(main)).data;
  assert.equal(file['editor.wordWrap'], 'on');
  assert.deepEqual(file['paradoxcode.dependencies'], [dep('D')]);
});

test('a new workspace can create its shared dependency configuration without VS Code', async t => {
  const { main } = await fixture(t);
  const h = await harness({ workspace: main, serverPath: '/missing/server' });
  t.after(() => h.dispose());
  const inspected = await h.call('paradoxcode_dependencies');
  assert.equal(inspected.value.result.source, 'default');
  const saved = await h.call('paradoxcode_dependencies', { action: 'set', dependencies: [dep('A')], baseHash: inspected.value.result.baseHash });
  assert.equal(saved.isError, false, JSON.stringify(saved));
  assert.deepEqual((await readSettings(main)).data['paradoxcode.dependencies'], [dep('A')]);
});

test('analysis sessions restart for shared analysis changes and retain explicit dependency overrides', async t => {
  const { main, A, B } = await fixture(t);
  await settings(main, { 'paradoxcode.dependencies': [dep('A')], 'editor.fontSize': 14 });
  const pool = new WorkspacePool(normalizeConfig({ serverPath, autoRefresh: false, vanillaMode: 'disabled' }));
  t.after(() => pool.dispose());
  const run = () => pool.run(main, undefined, async session => ({ pid: session.connection.pid, options: session.connection.options }));
  const first = await run();
  assert.equal(first.options.dependencies[0].path, A);
  await settings(main, { 'paradoxcode.dependencies': [dep('A')], 'editor.fontSize': 20 });
  assert.equal((await run()).pid, first.pid);
  await settings(main, { 'paradoxcode.dependencies': [dep('B')] });
  const second = await run();
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.options.dependencies[0].path, B);
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
  const h = await harness({ serverPath, workspace: main, dependencies: [], autoRefresh: false, vanillaMode: 'disabled' });
  t.after(() => h.dispose());
  const orientation = await h.call('paradoxcode_workspace');
  assert.equal(orientation.value.result.configuration.dependenciesSource, 'plugin');
  assert.deepEqual(orientation.value.result.initializationOptions.dependencies, []);
  const info = await h.call('paradoxcode_dependencies');
  const saved = await h.call('paradoxcode_dependencies', { action: 'set', dependencies: [], baseHash: info.value.result.baseHash });
  assert.equal(saved.isError, true);
  assert.match(saved.content[0].text, /override/);
});

test('cycles, load-order conflicts, duplicate identities and overlapping roots block chain sync', async t => {
  const { main, A, B, C } = await fixture(t);
  await settings(A, { 'paradoxcode.dependencies': [dep('B')] });
  await settings(B, { 'paradoxcode.dependencies': [dep('A')] });
  await assert.rejects(dependencyChain(main, main, [dep('A')]), /cycle/);
  await settings(B, { 'paradoxcode.dependencies': [] });
  await assert.rejects(dependencyChain(main, main, [dep('A'), dep('B')]), /loading order conflicts/);
  await settings(A, { 'paradoxcode.dependencies': [{ id: 'B', path: '../C' }] });
  await assert.rejects(dependencyChain(main, main, [dep('A'), dep('B')]), /different directories/);
  await assert.rejects(dependencyChain(main, main, [{ id: 'self', path: '.' }]), /cycle/);
  await mkdir(join(C, 'nested'));
  await assert.rejects(loadWorkspace(main, normalizeConfig({ dependencies: [dep('C'), { id: 'nested', path: '../C/nested' }] })), /overlap/);
});

test('invalid shared settings report their file and cannot silently use stale analysis', async t => {
  const { main } = await fixture(t);
  await settings(main, '{"paradoxcode.dependencies":[],"paradoxcode.dependencies":[]}');
  await assert.rejects(readSettings(main), /duplicate setting/);
  await settings(main, '{"paradoxcode.dependencies": [');
  await assert.rejects(readSettings(main), /settings.json:1: invalid JSONC/);
  await settings(main, { 'paradoxcode.dependencies': [{ id: 'A', path: '${workspaceFolder}/A' }] });
  await assert.rejects(loadWorkspace(main, normalizeConfig()), /Unsupported variable/);
  await settings(main, { 'paradoxcode.dependencies': null });
  const h = await harness({ workspace: main, serverPath: '/missing/server' });
  t.after(() => h.dispose());
  const inspect = await h.call('paradoxcode_dependencies');
  assert.ok(inspect.value.result.issues[0].includes('dependencies must be an array'));
  const repair = await h.call('paradoxcode_dependencies', { action: 'set', dependencies: [], baseHash: inspect.value.result.baseHash });
  assert.equal(repair.isError, false, JSON.stringify(repair));
  await settings(main, '{"__proto__":{"paradoxcode.modDirectory":"../A"}}');
  assert.equal((await loadWorkspace(main, normalizeConfig())).root, main);
});

test('offline cached dependencies retain coverage limits and cannot produce a complete synced chain', async t => {
  const { main } = await fixture(t);
  await settings(main, { 'paradoxcode.dependencies': [{ id: 'offline', path: '../missing', index: '../offline.pdcindex' }] });
  const h = await harness({ workspace: main, serverPath: '/missing/server' });
  t.after(() => h.dispose());
  const inspected = await h.call('paradoxcode_dependencies');
  assert.equal(inspected.value.result.warnings.length, 1);
  const saved = await h.call('paradoxcode_dependencies', { action: 'sync', baseHash: inspected.value.result.baseHash });
  assert.equal(saved.isError, true);
  assert.match(saved.content[0].text, /incomplete chain/);
});

test('shared settings save preserves BOM and rejects symlinked write destinations', { skip: process.platform === 'win32' && 'symlink privileges vary' }, async t => {
  const { main, A } = await fixture(t);
  await settings(main, '\uFEFF{ // keep\n "editor.fontSize": 14\n}\n');
  const snapshot = await readSettings(main);
  await saveDependencies(main, snapshot, [], snapshot.hash);
  assert.ok((await readFile(snapshot.path, 'utf8')).startsWith('\uFEFF'));
  await rm(snapshot.path);
  await writeFile(join(A, 'shared.json'), '{}');
  await symlink(join(A, 'shared.json'), snapshot.path);
  const linked = await readSettings(main);
  await assert.rejects(saveDependencies(main, linked, [], linked.hash), /regular file/);
  assert.equal(await readFile(join(A, 'shared.json'), 'utf8'), '{}');
});
