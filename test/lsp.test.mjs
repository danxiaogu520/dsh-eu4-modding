import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LspConnection, LspError } from '../lib/lsp.js';
import { removeTempDir, tempDir } from './helpers.mjs';

const server = resolve('test/fixtures/server.mjs');
await chmod(server, 0o755);

async function fixture(t, mode, timeout = 1500) {
  const parent = await tempDir('dsh-lsp-test-');
  const root = join(parent, mode);
  await mkdir(root);
  const connection = new LspConnection(server, root, { vanillaMode: 'disabled' }, timeout);
  t.after(async () => { await connection.stop(); await removeTempDir(parent); });
  return connection;
}

test('fragmented Unicode frames, client requests and readiness handshake', async t => {
  const client = await fixture(t, 'normal');
  await client.initialize();
  const result = await client.request('test/echo', { value: '😀 中文' });
  assert.equal(result.value, '中文 😀');
  assert.deepEqual(result.params, { value: '😀 中文' });
  assert.equal(client.capabilities.hoverProvider, true);
  const pid = client.pid;
  await client.stop();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('LSP semantic errors preserve codes and leave the server usable', async t => {
  const client = await fixture(t, 'normal');
  await client.initialize();
  await assert.rejects(client.request('test/error'), error => error instanceof LspError && error.code === -32801 && error.data.retry);
  assert.equal((await client.request('test/echo')).value, '中文 😀');
});

test('cancellation waits for child termination and rejects the active request', async t => {
  const client = await fixture(t, 'normal');
  await client.initialize();
  const controller = new AbortController();
  const pending = client.request('test/hang', {}, controller.signal);
  const pid = client.pid;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('timeout terminates an unresponsive server', async t => {
  const client = await fixture(t, 'normal', 150);
  await client.initialize();
  const pid = client.pid;
  await assert.rejects(client.request('test/hang'), /timed out/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('malformed transport and a missing backend fail with actionable errors', async t => {
  const client = await fixture(t, 'invalid-frame');
  await assert.rejects(client.initialize(), /Invalid LSP Content-Length/);
  const missing = new LspConnection('/missing/paradoxcode', process.cwd(), {}, 200);
  await assert.rejects(missing.initialize(), /Configure serverPath/);
  await missing.stop();
});

test('pre-cancelled initialization does not leave a child alive', async t => {
  const client = await fixture(t, 'normal');
  const pid = client.pid;
  await assert.rejects(client.initialize(AbortSignal.abort()), { name: 'AbortError' });
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('cooperative cancellation drains the response and preserves the indexed process', async t => {
  const client = await fixture(t, 'cooperative');
  await client.initialize();
  const pid = client.pid;
  const controller = new AbortController();
  const pending = client.request('test/hang', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(client.alive, true);
  assert.equal(client.pid, pid);
  assert.equal((await client.request('test/echo')).value, '中文 😀');
});
