import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as plugin from '../lib/index.js';

const scratchDirs = new Set();
// Windows cannot delete a directory that is still the working directory of a live child process,
// so always retry leftovers once every test hook has disposed its language servers.
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a killed process may still hold it */ }
  }
});

/**
 * Create a scratch directory. tmpdir() may be a Windows 8.3 short path (ADMINI~1) while every
 * consumer realpaths it, so resolve the base first and keep comparisons stable on Windows too.
 */
export async function tempDir(prefix) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  scratchDirs.add(dir);
  return dir;
}

/**
 * Best-effort removal that never throws. After-hooks run in registration order, so a removal hook
 * that throws would skip the later dispose hooks and leave a language server (and the test run) alive.
 */
export async function removeTempDir(path) {
  scratchDirs.delete(path);
  try { await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { scratchDirs.add(path); }
}

export async function harness(config = {}, services = {}) {
  const ctx = new Context();
  // Test doubles for host services the plugin talks to through ctx.get (fs, sandboxPolicy).
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value);
  const promptFork = ctx.plugin(SystemPrompt, {});
  const toolsFork = ctx.plugin(Tools, { mode: 'native' });
  const pluginFork = ctx.plugin(plugin, config);
  await Promise.all([promptFork, toolsFork, pluginFork]);
  return {
    ctx, pluginFork,
    call(name, args = {}, signal = new AbortController().signal, agent) {
      return ctx.tools.execute({ name, arguments: args, callId: `test-${Math.random()}`, signal, ...(agent ? { agent } : {}) });
    },
    async dispose() { await ctx.fiber.dispose(); },
  };
}

/**
 * Minimal `ctx.fs` double: enough of the DSH provider contract for the writer's UTF-8 path, with
 * the same version guard the real backend enforces.
 */
export function fakeFs() {
  const versions = new Map();
  const stamp = async path => {
    try { const info = await stat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`; }
    catch { return undefined; }
  };
  return {
    calls: { write: 0 },
    async resolve(path, opts = {}) {
      const targetKey = resolve(opts.cwd ?? process.cwd(), path);
      return { targetKey, displayPath: path };
    },
    async stat(target) {
      const version = await stamp(target.targetKey);
      if (version === undefined) return undefined;
      return { version, type: 'file', size: (await stat(target.targetKey)).size };
    },
    async writeText(target, content, expected) {
      this.calls.write++;
      const current = await stamp(target.targetKey);
      if (expected?.kind === 'replaceIfVersion') {
        if (current === undefined) throw new Error('fs: file no longer exists');
        if (current !== expected.version) throw new Error('fs: file changed since it was read');
      } else if (expected?.kind === 'createIfAbsent' && current !== undefined) throw new Error('fs: file already exists');
      await writeFile(target.targetKey, content, 'utf8');
      return { operation: current === undefined ? 'create' : 'update' };
    },
  };
}
