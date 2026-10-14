import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { toolNames } from '../lib/tools.js';

test('DSH bundle and profile override compose with the official patch engine and load by package name', async t => {
  /** @type {import('@deepseek-ai/dsh-package-manifest').DshPackageManifest} */
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const bundleUrl = new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url);
  assert.equal(fileURLToPath(import.meta.resolve('dsh-eu4-modding/cordis.patch.yml')), fileURLToPath(bundleUrl));
  const bundle = load(await readFile(bundleUrl, 'utf8'), { schema: entryListSchema });
  const override = load(await readFile(new URL('../examples/cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema });
  const warnings = [];
  const rows = applyEntryPatches([], structuredClone([...bundle, ...override]), message => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'eu4-modding');
  assert.equal(rows[0].config.serverPath, 'auto');
  assert.equal(rows[0].config.serverVersion, 'latest');
  assert.equal(rows[0].config.workspace, '');
  assert.equal(rows[0].config.vanillaMode, undefined);
  // In a profile this package lives in node_modules. Simulate that install;
  // plain Cordis' fallback importer resolves from its own package location.
  const selfLink = new URL('../node_modules/dsh-eu4-modding', import.meta.url);
  await symlink(fileURLToPath(new URL('..', import.meta.url)), selfLink, 'junction');
  t.after(() => rm(selfLink, { force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await Promise.all([
    ctx.plugin(Loader, { baseUrl: import.meta.url }),
    ctx.plugin(SystemPrompt, {}),
    ctx.plugin(Tools, { mode: 'native' }),
  ]);
  // Load the package's own layer with config: {}, as an end user does on install.
  const defaultRows = applyEntryPatches([], bundle, message => warnings.push(message));
  assert.deepEqual(defaultRows[0].config, {});
  await ctx.loader.create(defaultRows[0]);
  await ctx.loader.await();
  assert.ok(ctx.loader.resolve('eu4-modding').fiber, ctx.logger.buffer.flatMap(message => message.args.map(arg => arg?.message ?? String(arg))).join('\n'));
  const assembly = await ctx.systemPrompt.assemble();
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [...toolNames].sort());
  assert.ok(assembly.sections.some(section => section.name === 'eu4-modding:workflow'));
  await ctx.loader.remove('eu4-modding');
  await ctx.loader.await();
  assert.equal((await ctx.systemPrompt.assemble()).tools.length, 0);
});
