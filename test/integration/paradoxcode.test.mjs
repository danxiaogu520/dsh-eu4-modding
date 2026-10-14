import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { harness } from '../helpers.mjs';

const serverPath = process.env.PARADOXCODE_TEST_SERVER;
const effect = 'dsh_demo_effect = { add_prestige = 5 }\n';
const event = `namespace = dsh_demo
country_event = {
    id = dsh_demo.1
    title = dsh_demo.1.t
    desc = dsh_demo.1.d
    is_triggered_only = yes
    option = {
        name = dsh_demo.1.a
        dsh_demo_effect = yes
    }
}
`;
const localisation = '\uFEFFl_english:\n dsh_demo.1.t:0 "Demo title"\n dsh_demo.1.d:0 "Demo description"\n dsh_demo.1.a:0 "Demo option"\n';

test('real ParadoxCode: related drafts resolve together and leave no definitions or bytes behind', { skip: !serverPath, timeout: 360000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-joint-'));
  await mkdir(join(root, 'localisation'), { recursive: true });
  const original = '\uFEFFl_english:\n joint_old:0 "Old"\n';
  await writeFile(join(root, 'localisation/joint_l_english.yml'), original);
  const h = await harness({ serverPath, workspace: root, vanillaMode: 'disabled', autoRefresh: false });
  t.after(async () => { await h.dispose(); await rm(root, { recursive: true, force: true }); });
  const source = 'namespace = joint\ncountry_event = { id = joint.1 title = joint.t desc = joint.d is_triggered_only = yes option = { name = joint.a joint_effect = yes } }';
  const files = [
    { path: 'events/joint.txt', text: source },
    { path: 'common/scripted_effects/joint.txt', text: 'joint_effect = { add_prestige = 1 }\n' },
    { path: 'localisation/joint_l_english.yml', text: '\uFEFFl_english:\n joint.t:0 "Title"\n joint.d:0 "Description"\n joint.a:0 "Option"\n' },
  ];
  const result = await h.call('paradoxcode_validate_text', { files });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.result.counts.errors, 0, JSON.stringify(result.value.result));
  const missing = await h.call('paradoxcode_validate_text', { files: [files[0], files[1], { ...files[2], text: '\uFEFFl_english:\n joint.t:0 "Title"\n joint.a:0 "Option"\n' }] });
  assert.equal(missing.isError, false, JSON.stringify(missing));
  assert.ok(missing.value.result.files[0].diagnostics.some(d => d.code === 'UnknownLocalisationKey' && d.message.includes('joint.d')));
  const after = await h.call('paradoxcode_localisation', { key: 'joint.t' });
  assert.equal(after.value.result.hits.length, 0);
  const symbols = await h.call('paradoxcode_search', { query: 'joint_effect' });
  assert.equal(symbols.value.result.symbols.length, 0);
  assert.equal(await readFile(join(root, 'localisation/joint_l_english.yml'), 'utf8'), original);
});

test('real ParadoxCode: server search pages and document references can be exhausted without loss', { skip: !serverPath || serverPath === 'auto', timeout: 360000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-pages-'));
  for (const path of ['common/scripted_effects', 'events', 'common/custom_gui']) await mkdir(join(root, path), { recursive: true });
  const definitions = Array.from({ length: 60 }, (_, n) => `pagination_probe_effect_${n} = { add_prestige = 1 }`).join('\n');
  await writeFile(join(root, 'common/scripted_effects/pages.txt'), definitions);
  await writeFile(join(root, 'common/custom_gui/empty.txt'), '');
  await writeFile(join(root, 'events/outside_profile.md'), 'Notes');
  await writeFile(join(root, 'events/caller.txt'), `country_event = { id = pagination_probe.1 hidden = yes immediate = { ${'pagination_probe_effect_0 = yes '.repeat(121)} } }`);
  const h = await harness({ serverPath, workspace: root, vanillaMode: 'disabled', autoRefresh: false });
  t.after(async () => { await h.dispose(); await rm(root, { recursive: true, force: true }); });
  const orientation = await h.call('paradoxcode_workspace');
  assert.equal(orientation.isError, false, JSON.stringify(orientation));
  const names = [];
  let continuation = {};
  for (;;) {
    const response = await h.call('paradoxcode_query', { tab: 'definitions', query: 'pagination_probe_effect', status: 'active', ...continuation });
    assert.equal(response.isError, false, JSON.stringify(response));
    const page = response.value.result;
    names.push(...page.groups.flatMap(group => group.versions.map(version => version.name)));
    if (page.nextOffset === null) break;
    continuation = { offset: page.nextOffset, revision: page.revision, snapshot: page.snapshot };
  }
  assert.equal(names.length, 60);
  assert.equal(new Set(names).size, 60);
  const cursor = { action: 'references', path: 'common/scripted_effects/pages.txt', line: 1, character: 2, limit: 17 };
  let response = await h.call('paradoxcode_document', cursor);
  assert.equal(response.isError, false, JSON.stringify(response));
  const expected = response.value.result.total;
  assert.equal(expected, 122);
  const references = [];
  for (;;) {
    const page = response.value.result;
    references.push(...page.locations);
    if (page.nextOffset === null) break;
    response = await h.call('paradoxcode_document', { ...cursor, snapshot: page.snapshot, offset: page.nextOffset });
    assert.equal(response.isError, false, JSON.stringify(response));
  }
  assert.equal(references.length, expected);
  assert.equal(new Set(references.map(ref => JSON.stringify(ref))).size, expected);
  if (orientation.value.result.capabilities.experimental?.pdcQueryPagination) {
    const hits = [];
    let next = {};
    for (;;) {
      const response = await h.call('paradoxcode_search', { query: 'pagination_probe_effect', limit: 17, ...next });
      assert.equal(response.isError, false, JSON.stringify(response));
      const page = response.value.result;
      hits.push(...page.symbols);
      if (page.nextOffset === null) break;
      next = { offset: page.nextOffset, revision: page.revision };
    }
    assert.equal(hits.length, 60);
    const disk = await h.call('paradoxcode_diagnostics', { files: ['events/caller.txt'] });
    assert.equal(disk.value.result.items[0].diagnostics.some(d => d.code === 'Cardinality' && d.message.includes('option')), false);
    assert.ok(orientation.value.result.scan.excludedEntries.some(entry => entry.path.endsWith('events/outside_profile.md')));
  }
});

test('real ParadoxCode: full agentic query, draft, edit, refresh and review workflow', { skip: !serverPath && 'Set PARADOXCODE_TEST_SERVER to auto or a standalone paradoxcode binary', timeout: serverPath === 'auto' ? 660000 : 360000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-pdc-'));
  for (const dir of ['common/scripted_effects', 'events', 'localisation', 'missions']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'common/scripted_effects/demo.txt'), effect);
  await writeFile(join(root, 'events/demo.txt'), event);
  await writeFile(join(root, 'localisation/demo_l_english.yml'), localisation);
  // Isolate protocol assertions from incomplete reference closure in a full Vanilla index.
  const h = await harness({ ...(serverPath === 'auto' ? {} : { serverPath }), vanillaMode: 'disabled',
    ...(process.env.PARADOXCODE_TEST_CACHE ? { serverCacheDirectory: process.env.PARADOXCODE_TEST_CACHE } : {}),
    ...(process.env.PARADOXCODE_TEST_VERSION ? { serverVersion: process.env.PARADOXCODE_TEST_VERSION } : {}),
  });
  t.after(async () => { await h.dispose(); await rm(root, { recursive: true, force: true }); });
  const agent = { session: { header: { cwd: join(root, 'events') } } };
  async function call(name, args = {}) {
    const result = await h.call(name, args, undefined, agent);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    return result.value.result;
  }

  const summary = await call('paradoxcode_workspace');
  t.diagnostic(`ParadoxCode ${summary.server.info.version} (${summary.server.source})`);
  assert.equal(summary.gameId, 'eu4');
  assert.ok(summary.server.info.version);
  if (process.env.PARADOXCODE_TEST_VERSION && process.env.PARADOXCODE_TEST_VERSION !== 'latest') {
    assert.equal(summary.server.info.version, process.env.PARADOXCODE_TEST_VERSION.replace(/^v/, ''));
  }
  assert.ok(summary.fileCounts.script >= 2);
  assert.ok(summary.roots.some(entry => entry.writable && entry.path === root));
  const rules = await call('paradoxcode_rules', { context: 'effect', key: 'add_prestige' });
  assert.ok(rules.rules.some(rule => rule.key === 'add_prestige'));
  const symbols = await call('paradoxcode_search', { query: 'dsh_demo_effect' });
  assert.ok(symbols.symbols.some(symbol => symbol.name === 'dsh_demo_effect'));
  const references = await call('paradoxcode_symbol_references', { name: 'dsh_demo_effect', kind: 'scripted_effect' });
  assert.equal(references.matched, true);
  assert.ok(references.references.length > 0);
  const loc = await call('paradoxcode_localisation', { key: 'dsh_demo.1.t' });
  assert.equal(loc.hits[0].value, 'Demo title');
  const family = await call('paradoxcode_localisation', { key: 'dsh_demo.1.', keyMatch: 'prefix' });
  assert.equal(family.hits.length, 3);

  const before = await readFile(join(root, 'events/demo.txt'), 'utf8');
  const draft = await call('paradoxcode_validate_text', { files: [{ path: 'events/demo.txt', text: event.replace('dsh_demo_effect = yes', 'add_prestige = definitely_invalid') }] });
  assert.ok(draft.counts.errors > 0);
  assert.ok(draft.files[0].diagnostics.some(d => d.code === 'InvalidValue'));
  assert.equal(await readFile(join(root, 'events/demo.txt'), 'utf8'), before);
  const locDraft = await call('paradoxcode_validate_text', { files: [{ path: 'localisation/draft_l_english.yml', text: 'l_english:\n draft:0 "Hello"\n' }] });
  assert.ok(Array.isArray(locDraft.files[0].diagnostics));
  const disk = await call('paradoxcode_diagnostics', { files: ['events/demo.txt', 'localisation/demo_l_english.yml'] });
  assert.equal(disk.items.length, 2);
  assert.equal(disk.pageCounts.errors, 0);

  const hover = await call('paradoxcode_document', { action: 'hover', path: 'common/scripted_effects/demo.txt', line: 1, character: effect.indexOf('add_prestige') + 2 });
  assert.ok(hover?.contents);
  const uses = await call('paradoxcode_document', { action: 'references', path: 'common/scripted_effects/demo.txt', line: 1, character: 2 });
  assert.ok(uses.total > 0);
  const definition = await call('paradoxcode_document', { action: 'definition', path: 'events/demo.txt', line: 9, character: 10 });
  assert.ok(Array.isArray(definition) ? definition.length : definition);
  const completion = await call('paradoxcode_document', { action: 'completion', path: 'common/scripted_effects/new.txt', text: 'new_effect = { add_ }', line: 1, character: 19 });
  assert.ok(completion.items.length > 0);
  await call('paradoxcode_document', { action: 'symbols', path: 'common/scripted_effects/demo.txt', text: 'temporary_overlay_effect = { add_prestige = 2 }\n' });
  // Closing an overlay must restore the original indexed symbol.
  const preserved = await call('paradoxcode_search', { query: 'dsh_demo_effect' });
  assert.ok(preserved.symbols.some(symbol => symbol.name === 'dsh_demo_effect'));
  assert.equal((await call('paradoxcode_search', { query: 'temporary_overlay_effect' })).symbols.some(x => x.name === 'temporary_overlay_effect'), false);

  const renamed = await call('paradoxcode_rename_preview', { path: 'common/scripted_effects/demo.txt', line: 1, character: 2, newName: 'dsh_renamed_effect' });
  assert.equal(renamed.applied, false);
  assert.equal(renamed.files.length, 2);
  assert.ok(renamed.files.every(file => file.writable && file.sha256.length === 64));
  assert.equal(await readFile(join(root, 'common/scripted_effects/demo.txt'), 'utf8'), effect);
  const formatted = await call('paradoxcode_format_preview', { path: 'common/scripted_effects/draft.txt', text: 'draft_effect={add_prestige=5}' });
  assert.equal(formatted.applied, false);
  assert.ok(formatted.text.includes('add_prestige'));

  const mission = await call('paradoxcode_mission_preview', { path: 'missions/demo.txt', text: 'demo_tree = { slot = 1 a1 = { position = 1 icon = mission_alpha } a2 = { position = 2 required_missions = { a1 } } }' });
  assert.ok(mission);
  const encoded = await call('paradoxcode_transcode_preview', { action: 'encode', path: 'localisation/chinese_l_english.yml', text: 'l_english:\n key:0 "中文"\n' });
  assert.equal(encoded.applied, false);
  assert.ok(encoded.bytes && !encoded.refused, JSON.stringify(encoded));
  const decoded = await call('paradoxcode_transcode_preview', { action: 'decode', path: 'localisation/chinese_l_english.yml', bytesHex: encoded.bytes });
  assert.ok(decoded.text.includes('中文'));
  // 0.5.2 manual transcoding preserves comments and existing escape triples.
  const readable = 'l_english:\n # 中文 comment\n key:0 "中文"\n';
  const quoted = await call('paradoxcode_transcode_preview', { action: 'encode', path: 'localisation/chinese_l_english.yml', text: readable, preserveEscaped: true });
  assert.ok(quoted.bytes && !quoted.refused, JSON.stringify(quoted));
  const partial = Buffer.from(quoted.bytes, 'hex').toString('utf8');
  assert.ok(partial.includes('# 中文 comment'));
  assert.ok(!partial.includes('key:0 "中文"'));
  const preservedEscapes = await call('paradoxcode_transcode_preview', { action: 'encode', path: 'localisation/chinese_l_english.yml', text: partial, preserveEscaped: true });
  assert.equal(preservedEscapes.bytes, quoted.bytes);
  const decodedQuoted = await call('paradoxcode_transcode_preview', { action: 'decode', path: 'localisation/chinese_l_english.yml', bytesHex: quoted.bytes, quotedOnly: true });
  assert.equal(decodedQuoted.text, readable);

  // Explicit refresh covers shell/outside-editor edits and discovers new files.
  await writeFile(join(root, 'common/scripted_effects/added.txt'), 'dsh_added_effect = { add_prestige = 1 }\n');
  await call('paradoxcode_refresh');
  assert.ok((await call('paradoxcode_search', { query: 'dsh_added_effect' })).symbols.some(x => x.name === 'dsh_added_effect'));
  // A watcher observes subsequent changes without a manual refresh.
  await writeFile(join(root, 'common/scripted_effects/added.txt'), 'dsh_updated_effect = { add_prestige = 1 }\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok((await call('paradoxcode_search', { query: 'dsh_updated_effect' })).symbols.some(x => x.name === 'dsh_updated_effect'));
  assert.equal((await call('paradoxcode_search', { query: 'dsh_added_effect' })).symbols.some(x => x.name === 'dsh_added_effect'), false);
  // A whole-Mod result must expose page continuation rather than imply all files are clean.
  const page = await call('paradoxcode_diagnostics', { limit: 1 });
  assert.ok(page.nextOffset > 0);
});

test('real ParadoxCode: installed defaults detect the Mod and discover game data without configuration', { skip: !serverPath && 'Set PARADOXCODE_TEST_SERVER to auto or a standalone paradoxcode binary', timeout: 660000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-defaults-'));
  await mkdir(join(root, 'common', 'scripted_effects'), { recursive: true });
  await writeFile(join(root, 'descriptor.mod'), 'name="Default installation test"\n');
  await writeFile(join(root, 'common', 'scripted_effects', 'example.txt'), effect);
  const h = await harness({ ...(serverPath === 'auto' ? {} : { serverPath }),
    // Isolate the download cache for the test; product options use installation defaults.
    ...(process.env.PARADOXCODE_TEST_CACHE ? { serverCacheDirectory: process.env.PARADOXCODE_TEST_CACHE } : {}),
  });
  t.after(async () => { await h.dispose(); await rm(root, { recursive: true, force: true }); });
  const agent = { session: { header: { cwd: join(root, 'common', 'scripted_effects') } } };
  const orientation = await h.call('paradoxcode_workspace', {}, undefined, agent);
  assert.equal(orientation.isError, false, JSON.stringify(orientation));
  assert.equal(orientation.value.workspace, root);
  const summary = orientation.value.result;
  assert.ok(summary.server.info.version);
  assert.ok(summary.roots.some(entry => entry.kind === 'project' && entry.path === root));
  t.diagnostic(`Default startup: ParadoxCode ${summary.server.info.version}; Vanilla root loaded: ${summary.roots.some(entry => entry.kind === 'vanilla')}`);
  const search = await h.call('paradoxcode_search', { query: 'dsh_demo_effect' }, undefined, agent);
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.ok(search.value.result.symbols.some(symbol => symbol.name === 'dsh_demo_effect'));
  const validation = await h.call('paradoxcode_validate_text', { files: [{ path: 'common/scripted_effects/draft.txt', text: 'draft_effect = { add_prestige = definitely_invalid }\n' }] }, undefined, agent);
  assert.equal(validation.isError, false, JSON.stringify(validation));
  assert.ok(validation.value.result.files[0].diagnostics.some(item => item.code === 'InvalidValue'));
});

test('real ParadoxCode: shared VS Code settings load and synchronize a transitive dependency chain', { skip: !serverPath && 'Set PARADOXCODE_TEST_SERVER to auto or a standalone paradoxcode binary', timeout: 660000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-real-dependencies-'));
  const roots = Object.fromEntries(['main', 'A', 'B', 'C'].map(name => [name, join(parent, name)]));
  for (const [name, root] of Object.entries(roots)) {
    await mkdir(join(root, 'common', 'scripted_effects'), { recursive: true });
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, 'descriptor.mod'), `name="${name}"\n`);
    await writeFile(join(root, 'common', 'scripted_effects', 'effects.txt'), `from_${name.toLowerCase()}_effect = { add_prestige = 1 }\n${name === 'main' ? '' : 'shared_dependency_effect = { add_prestige = 2 }\n'}`);
  }
  const deps = ['A', 'B'].map(id => ({ id, path: `../${id}` }));
  const settingsPath = join(roots.main, '.vscode', 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ 'paradoxcode.dependencies': deps, 'paradoxcode.vanilla.mode': 'disabled', 'editor.fontSize': 16 }));
  for (const name of ['A', 'B']) await writeFile(join(roots[name], '.vscode', 'settings.json'), JSON.stringify({ 'paradoxcode.dependencies': [{ id: 'C', path: '../C' }] }));
  const h = await harness({ ...(serverPath === 'auto' ? {} : { serverPath }),
    ...(process.env.PARADOXCODE_TEST_CACHE ? { serverCacheDirectory: process.env.PARADOXCODE_TEST_CACHE } : {}),
  });
  t.after(async () => { await h.dispose(); await rm(parent, { recursive: true, force: true }); });
  const agent = { session: { header: { cwd: roots.main } } };
  async function call(name, args = {}) {
    const result = await h.call(name, args, undefined, agent);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    return result.value.result;
  }
  assert.equal((await call('paradoxcode_search', { query: 'from_c_effect' })).symbols.some(symbol => symbol.name === 'from_c_effect'), false);
  const before = await call('paradoxcode_dependencies');
  assert.deepEqual(before.loadOrder.map(row => row.id), ['C', 'A', 'B']);
  await call('paradoxcode_dependencies', { action: 'sync', baseHash: before.baseHash });
  const shared = parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(shared['paradoxcode.dependencies'].map(row => row.id), ['C', 'A', 'B']);
  assert.equal(shared['editor.fontSize'], 16);
  const orientation = await call('paradoxcode_workspace');
  assert.equal(orientation.configuration.dependenciesSource, 'vscode');
  assert.equal(orientation.roots.filter(root => root.kind === 'dependency').length, 3);
  assert.ok(orientation.roots.filter(root => root.kind === 'dependency').every(root => !root.writable));
  assert.ok((await call('paradoxcode_search', { query: 'from_c_effect' })).symbols.some(symbol => symbol.name === 'from_c_effect'));
  const draft = await call('paradoxcode_validate_text', { files: [{ path: 'common/scripted_effects/draft.txt', text: 'new_effect = { from_c_effect = yes }\n' }] });
  assert.equal(draft.counts.errors, 0, JSON.stringify(draft));
  const winner = await call('paradoxcode_symbol_references', { name: 'shared_dependency_effect', kind: 'scripted_effect' });
  assert.ok(winner.symbol.definition.uri.includes('/B/common/'), JSON.stringify(winner));
  // A VS Code save to the shared file is picked up automatically by the next query.
  shared['paradoxcode.dependencies'] = shared['paradoxcode.dependencies'].filter(row => row.id !== 'B');
  await writeFile(settingsPath, JSON.stringify(shared));
  const next = await call('paradoxcode_symbol_references', { name: 'shared_dependency_effect', kind: 'scripted_effect' });
  assert.ok(next.symbol.definition.uri.includes('/A/common/'), JSON.stringify(next));
  t.diagnostic('Shared chain C -> A -> B verified; external configuration edit changed the winner from B to A');
});
