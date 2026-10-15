import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverModRoot } from '../lib/discovery.js';
import { harness, removeTempDir, tempDir } from './helpers.mjs';

async function fixture(t) {
  const root = await tempDir('dsh-discovery-test-');
  t.after(() => removeTempDir(root));
  return root;
}

test('large containers explain the discovery limit and accept an explicit Mod selection', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 65 }, (_, n) => mkdir(join(root, `folder-${n}`))));
  await assert.rejects(discoverModRoot(root), /65 child directories.*workspace/);
});

test('session directories inside a Mod resolve to its nearest root', async t => {
  const root = await fixture(t);
  const child = join(root, 'common', 'scripted_effects');
  await mkdir(child, { recursive: true });
  await writeFile(join(root, 'descriptor.mod'), 'name="Example"\n');
  assert.equal(await discoverModRoot(child), root);
  const nested = join(root, 'nested-mod');
  await mkdir(join(nested, 'events'), { recursive: true });
  await writeFile(join(nested, 'descriptor.mod'), 'name="Nested"\n');
  assert.equal(await discoverModRoot(join(nested, 'events')), nested);
});

test('script and localisation layouts identify Mods without a descriptor', async t => {
  const parent = await fixture(t);
  const scripts = join(parent, 'scripts');
  await mkdir(join(scripts, 'common', 'scripted_effects'), { recursive: true });
  assert.equal(await discoverModRoot(join(scripts, 'common')), scripts);
  const loc = join(parent, 'localisation-mod');
  await mkdir(join(loc, 'localisation'), { recursive: true });
  await writeFile(join(loc, 'localisation', 'example_l_english.yml'), 'l_english:\n');
  assert.equal(await discoverModRoot(join(loc, 'localisation')), loc);
});

test('a container selects its only Mod and reports choices if several Mods are present', async t => {
  const parent = await fixture(t);
  const first = join(parent, 'first');
  await mkdir(first);
  await writeFile(join(first, 'descriptor.mod'), 'name="First"\n');
  assert.equal(await discoverModRoot(parent), first);
  const second = join(parent, 'second');
  await mkdir(second);
  await writeFile(join(second, 'descriptor.mod'), 'name="Second"\n');
  await assert.rejects(discoverModRoot(parent), error => /Multiple EU4 Mods/.test(error.message) && error.message.includes(first) && error.message.includes(second));
});

test('empty new Mods and unrelated folders stay at the selected directory', async t => {
  const root = await fixture(t);
  assert.equal(await discoverModRoot(root), root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'events'));
  await writeFile(join(root, 'events', 'index.ts'), 'export {}');
  assert.equal(await discoverModRoot(join(root, 'src')), join(root, 'src'));
  await assert.rejects(discoverModRoot(root, AbortSignal.abort()), { name: 'AbortError' });
});

test('directory symlinks use the real Mod root', { skip: process.platform === 'win32' && 'symlink privileges vary on Windows' }, async t => {
  const parent = await fixture(t);
  const root = join(parent, 'mod');
  await mkdir(join(root, 'events'), { recursive: true });
  await writeFile(join(root, 'descriptor.mod'), 'name="Mod"\n');
  await symlink(root, join(parent, 'linked-mod'), 'dir');
  assert.equal(await discoverModRoot(join(parent, 'linked-mod', 'events')), root);
});

test('plugin detects session roots while explicit tool and profile paths retain precedence', async t => {
  const parent = await fixture(t);
  const root = join(parent, 'mod');
  const child = join(root, 'events');
  await mkdir(child, { recursive: true });
  await writeFile(join(root, 'descriptor.mod'), 'name="Mod"\n');
  const serverPath = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
  const h = await harness({ serverPath, vanillaMode: 'disabled', autoRefresh: false });
  t.after(() => h.dispose());
  const agent = { session: { header: { cwd: child } } };
  const detected = await h.call('paradoxcode_workspace', {}, undefined, agent);
  assert.equal(detected.isError, false, JSON.stringify(detected));
  assert.equal(detected.value.workspace, root);
  const explicit = await h.call('paradoxcode_workspace', { workspace: '.' }, undefined, agent);
  assert.equal(explicit.value.workspace, child);
  const configured = await harness({ serverPath, workspace: child, vanillaMode: 'disabled', autoRefresh: false });
  t.after(() => configured.dispose());
  const profile = await configured.call('paradoxcode_workspace', {}, undefined, agent);
  assert.equal(profile.value.workspace, child);
});
