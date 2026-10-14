import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeConfig } from '../lib/config.js';
import { WorkspacePool } from '../lib/workspace.js';

const server = resolve('test/fixtures/server.mjs');
await chmod(server, 0o755);

async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pool-test-'));
  const pool = new WorkspacePool(normalizeConfig({ serverPath: server, vanillaMode: 'disabled', autoRefresh: false, ...config }));
  t.after(async () => { await pool.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, pool };
}

test('bounded workspace pool evicts idle processes and cancellation permits clean restart', async t => {
  const { root, pool } = await fixture(t, { maxWorkspaces: 1 });
  const second = join(root, 'second');
  await mkdir(second);
  const firstPid = await pool.run(root, undefined, async session => session.connection.pid);
  const secondPid = await pool.run(second, undefined, async session => session.connection.pid);
  assert.throws(() => process.kill(firstPid, 0), /ESRCH/);
  const controller = new AbortController();
  const running = pool.run(second, controller.signal, async session => {
    const request = session.request('test/hang', {}, controller.signal);
    controller.abort();
    return request;
  });
  await assert.rejects(running, { name: 'AbortError' });
  assert.throws(() => process.kill(secondPid, 0), /ESRCH/);
  const replacementPid = await pool.run(second, undefined, async session => session.connection.pid);
  assert.notEqual(replacementPid, secondPid);
  await pool.dispose();
  assert.throws(() => process.kill(replacementPid, 0), /ESRCH/);
  await assert.rejects(pool.run(root, undefined, async () => null), /disposed/);
});

test('concurrent callers cannot observe another caller’s temporary document overlay', async t => {
  const { root, pool } = await fixture(t);
  const seen = [];
  await Promise.all(['first', 'second'].map(text => pool.run(root, undefined, async session => {
    await session.withDocument('events/draft.txt', text, undefined, async () => {
      seen.push(`${text}:open`);
      await new Promise(resolve => setTimeout(resolve, 20));
      seen.push(`${text}:close`);
    });
  })));
  assert.deepEqual(seen, ['first:open', 'first:close', 'second:open', 'second:close']);
});

test('draft document symlinks cannot escape the Mod root', async t => {
  const { root, pool } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-draft-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'events'), 'dir');
  await assert.rejects(pool.run(root, undefined, async session => session.withDocument('events/draft.txt', 'x', undefined, async () => null)), /outside the Mod/);
});

test('non-UTF-8 disk documents are refused instead of creating a lossy overlay', async t => {
  const { root, pool } = await fixture(t);
  await mkdir(join(root, 'events'));
  await writeFile(join(root, 'events/encoded.txt'), Buffer.from([0xff, 0xfe, 0x01]));
  await assert.rejects(pool.run(root, undefined, async session => session.withDocument('events/encoded.txt', undefined, undefined, async () => null)), /not UTF-8/);
});

test('dirty file paths refresh their owning workspace and preserve unrelated sessions', async t => {
  const { root, pool } = await fixture(t, { autoRefresh: true, maxWorkspaces: 3 });
  const a = join(root, 'alpha'), b = join(root, 'beta');
  await mkdir(join(a, 'events'), { recursive: true });
  await mkdir(b);
  const changed = join(a, 'events/test.txt');
  await writeFile(changed, 'namespace = test');
  for (const workspace of [a, b]) await pool.run(workspace, undefined, s => s.request('test/echo'));
  pool.markDirty(changed);
  const other = await pool.run(b, undefined, s => s.request('test/echo'));
  assert.equal(other.notifications.some(n => n.method === 'workspace/didChangeWatchedFiles'), false);
  const owner = await pool.run(a, undefined, s => s.request('test/echo'));
  assert.equal(owner.notifications.some(n => n.method === 'workspace/didChangeWatchedFiles'), true);
  assert.equal(owner.notifications.some(n => n.method === 'workspace/executeCommand'), false);
});

test('a cancelled unresponsive workspace cannot terminate another cached server', async t => {
  const { root, pool } = await fixture(t, { maxWorkspaces: 2 });
  const other = join(root, 'other');
  await mkdir(other);
  const pid = await pool.run(other, undefined, async s => s.connection.pid);
  await pool.run(root, undefined, async () => null);
  const controller = new AbortController();
  await assert.rejects(pool.run(root, controller.signal, async s => {
    const pending = s.request('test/hang', {}, controller.signal);
    controller.abort();
    return pending;
  }), { name: 'AbortError' });
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(await pool.run(other, undefined, async s => s.connection.pid), pid);
});
