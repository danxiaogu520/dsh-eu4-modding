import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { extractServer, platformArtifact } from '../lib/archive.js';
import { normalizeConfig } from '../lib/config.js';
import { parseChecksum, resolveServer } from '../lib/server.js';
import { harness, removeTempDir, tempDir } from './helpers.mjs';

const linux = platformArtifact('linux', 'x64');
const windows = platformArtifact('win32', 'x64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function tar(bytes, name = 'paradoxcode', type = '0') {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000755\0', 100);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]));
}

function zip(bytes, name = 'paradoxcode.exe', mode = 0o100755) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

/** Package a fixture payload the way the current platform's release asset is packaged. */
function pack(bytes, artifact = platformArtifact()) {
  return artifact.extension === 'zip' ? zip(bytes) : tar(bytes);
}

async function fixture(t, options = {}) {
  const root = await tempDir('dsh-download-test-');
  t.after(() => removeTempDir(root));
  return normalizeConfig({ serverCacheDirectory: root, ...options });
}

function github(archive, version = '0.5.2', options = {}) {  const artifact = options.artifact ?? linux;
  const name = `paradoxcode-v${version}-${artifact.target}.${artifact.extension}`;
  const digest = options.checksum ?? sha(archive);
  const calls = [];
  const fetch = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    calls.push(String(url));
    if (String(url).endsWith('/latest')) return Response.json({ tag_name: `v${version}`, assets: [{ name, digest: `sha256:${sha(archive)}` }, { name: `${name}.sha256` }] });
    if (String(url).endsWith(`${name}.sha256`)) return new Response(`${digest}  ${name}\n`);
    if (String(url).endsWith(name)) return new Response(archive);
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetch, calls, platform: options.platform ?? 'linux', arch: options.arch ?? 'x64' };
}

test('platform inventory and server configuration match published stable releases', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) assert.ok(platformArtifact(platform, arch).target);
  assert.throws(() => platformArtifact('win32', 'arm64'), /no published server/);
  assert.equal(normalizeConfig().serverPath, 'auto');
  assert.equal(normalizeConfig({ serverVersion: 'v0.5.2' }).serverVersion, '0.5.2');
  assert.throws(() => normalizeConfig({ serverVersion: '../0.5.2' }), /serverVersion/);
  assert.throws(() => normalizeConfig({ downloadTimeoutMs: 1500.5 }), /integer/);
});

test('tar and Windows ZIP extraction reject unsafe entries, symlinks, corruption and extra files', async () => {
  const bytes = Buffer.from('verified executable');
  assert.deepEqual(await extractServer(tar(bytes), linux), bytes);
  assert.deepEqual(await extractServer(zip(bytes), windows), bytes);
  await assert.rejects(extractServer(tar(bytes, '../paradoxcode'), linux), /regular file/);
  await assert.rejects(extractServer(tar(bytes, 'paradoxcode', '2'), linux), /regular file/);
  await assert.rejects(extractServer(zip(bytes, 'paradoxcode.exe', 0o120777), windows), /regular file/);
  await assert.rejects(extractServer(zip(bytes, '../paradoxcode.exe'), windows), /regular file/);
  await assert.rejects(extractServer(Buffer.concat([tar(bytes), tar(bytes)]), linux), /extra entries/);
  const bad = zip(bytes);
  bad[30 + 'paradoxcode.exe'.length] ^= 1;
  await assert.rejects(extractServer(bad, windows));
  const oversized = zip(bytes);
  oversized.writeUInt32LE(128 * 1024 * 1024 + 1, oversized.length - 22 - 46 - 'paradoxcode.exe'.length + 24);
  await assert.rejects(extractServer(oversized, windows), /size/);
  assert.throws(() => parseChecksum(`${'a'.repeat(64)}  other.tar.gz`, 'server.tar.gz'), /does not match/);
});

test('latest release is checksum verified, cached, upgraded on a new resolver and usable offline', async t => {
  const config = await fixture(t);
  const bytes = Buffer.from('versioned executable');
  const first = github(tar(bytes), '0.5.3');
  const installed = await resolveServer(config, undefined, first);
  assert.equal(installed.version, '0.5.3');
  assert.deepEqual(await readFile(installed.path), bytes);
  assert.equal(first.calls.length, 3);
  const again = github(tar(bytes), '0.5.3');
  assert.equal((await resolveServer(config, undefined, again)).path, installed.path);
  assert.equal(again.calls.length, 1);
  const next = github(tar(bytes), '0.5.4');
  const upgraded = await resolveServer(config, undefined, next);
  assert.equal(upgraded.version, '0.5.4');
  assert.notEqual(upgraded.path, installed.path);
  const offline = { ...next, fetch: async () => { throw new Error('offline'); } };
  const cached = await resolveServer(config, undefined, offline);
  assert.equal(cached.version, '0.5.4');
  assert.match(cached.warning, /verified cached/);
  await writeFile(upgraded.path, 'corrupted executable');
  const older = await resolveServer(config, undefined, offline);
  assert.equal(older.version, '0.5.3');
  assert.deepEqual(await readFile(older.path), bytes);
});

test('servers older than 0.5.3 are refused instead of silently degrading', async t => {
  const config = await fixture(t, { serverVersion: 'latest' });
  const legacy = github(tar(Buffer.from('legacy server')), '0.5.2');
  await assert.rejects(resolveServer(config, undefined, legacy), /0\.5\.2/);
  // A verified 0.5.2 cache must not satisfy a latest resolution either.
  const pinned = normalizeConfig({ ...config, serverVersion: '0.5.2' });
  await assert.rejects(resolveServer(pinned, undefined, legacy));
  const bootstrap = await resolveServer(config, undefined, { ...github(tar(Buffer.from('bootstrap')), '0.5.3'), fetch: async url => { throw new Error(`offline ${url}`); } }).catch(error => error);
  assert.ok(bootstrap instanceof Error, 'offline resolution still fails without a cache');
});

test('fixed versions use the verified cache without GitHub and explicit executables bypass downloads', async t => {
  const config = await fixture(t, { serverVersion: '0.5.3' });
  const mock = github(tar(Buffer.from('pinned')), '0.5.3');
  const first = await resolveServer(config, undefined, mock);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(await resolveServer(config, undefined, { ...mock, fetch: async () => { throw new Error('must not fetch'); } }), first);
  assert.deepEqual(await resolveServer(normalizeConfig({ serverPath: 'paradoxcode' }), undefined, { fetch: async () => { throw new Error('must not fetch'); } }), { source: 'local', path: 'paradoxcode' });
  const win = github(zip(Buffer.from('windows')), '0.5.3', { artifact: windows, platform: 'win32' });
  const result = await resolveServer(config, undefined, win);
  assert.ok(result.path.endsWith('paradoxcode.exe'));
});

test('latest can use a verified fixed-version cache without a latest pointer', async t => {
  const config = await fixture(t, { serverVersion: '0.5.3' });
  const mock = github(tar(Buffer.from('fixed cache')), '0.5.3');
  const pinned = await resolveServer(config, undefined, mock);
  const latest = await resolveServer({ ...config, serverVersion: 'latest' }, undefined, { ...mock, fetch: async () => new Response(null, { status: 403 }) });
  assert.equal(latest.path, pinned.path);
  assert.match(latest.warning, /verified cached/);
});

test('API rate limits permit cold downloads through release redirects and bootstrap fallback', async t => {
  for (const useRedirect of [true, false]) {
    const config = await fixture(t);
    const archive = tar(Buffer.from('cold verified server'));
    const mock = github(archive, '0.5.3');
    const fetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'api.github.com') return new Response(null, { status: 403 });
      if (parsed.pathname.endsWith('/latest')) return new Response(null, useRedirect ? { status: 302, headers: { location: '/danxiaogu520/ParadoxCode/releases/tag/v0.5.3' } } : { status: 403 });
      return mock.fetch(url, init);
    };
    const server = await resolveServer(config, undefined, { ...mock, fetch });
    assert.equal(server.version, '0.5.3');
    assert.deepEqual(await readFile(server.path), Buffer.from('cold verified server'));
    assert.match(server.warning, useRedirect ? /web redirect/ : /bootstrap version/);
  }
});

test('GitHub authentication stays on the API host across resource redirects', async t => {
  const config = await fixture(t);
  const archive = tar(Buffer.from('auth boundary'));
  const mock = github(archive, '0.5.3');
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
  const fetch = async (url, init) => {
    if (new URL(url).hostname === 'api.github.com') assert.equal(init.headers.Authorization, 'Bearer test-token');
    else assert.equal(init.headers.Authorization, undefined);
    return mock.fetch(url, init);
  };
  await resolveServer(config, undefined, { ...mock, fetch });
});

test('concurrent downloads share a complete cache and corrupt receipts are repaired', async t => {
  const config = await fixture(t, { serverVersion: '0.5.3' });
  const mock = github(tar(Buffer.from('concurrent')), '0.5.3');
  const results = await Promise.all([resolveServer(config, undefined, mock), resolveServer(config, undefined, mock)]);
  assert.equal(results[0].path, results[1].path);
  const directory = join(config.serverCacheDirectory, `0.5.3-${linux.target}`);
  assert.deepEqual((await readdir(directory)).sort(), ['paradoxcode', 'receipt.json']);
  await writeFile(join(directory, 'receipt.json'), 'null');
  await resolveServer(config, undefined, mock);
  assert.equal(JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')).version, '0.5.3');
});

test('bad checksums cannot install a server or fall back to an older release', async t => {
  const config = await fixture(t, { serverVersion: '0.5.3' });
  const archive = tar(Buffer.from('unchecked'));
  const bad = github(archive, '0.5.3', { checksum: '0'.repeat(64) });
  await assert.rejects(resolveServer(config, undefined, bad), /SHA-256 mismatch/);
  assert.deepEqual(await readdir(config.serverCacheDirectory), []);
  const valid = github(archive, '0.5.3');
  await resolveServer({ ...config, serverVersion: 'latest' }, undefined, valid);
  await assert.rejects(resolveServer({ ...config, serverVersion: 'latest' }, undefined, github(archive, '0.5.4', { checksum: '0'.repeat(64) })), /disagree/);
});

test('GitHub redirects, streaming size bounds, cancellation and download deadlines are enforced', async t => {
  const config = await fixture(t);
  await assert.rejects(resolveServer(config, undefined, { ...github(tar(Buffer.from('x'))), fetch: async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/server' } }) }), /HTTPS on GitHub/);
  await assert.rejects(resolveServer(config, undefined, { ...github(tar(Buffer.from('x'))), fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); c.close(); } })) }), /byte limit/);
  const stalled = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const controller = new AbortController();
  const cancelled = resolveServer(config, controller.signal, { ...github(tar(Buffer.from('x'))), fetch: stalled });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, { name: 'AbortError' });
  // AbortSignal.timeout is unref'ed; keep the test alive until its deadline fires.
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(resolveServer({ ...config, downloadTimeoutMs: 1000 }, undefined, { ...github(tar(Buffer.from('x'))), fetch: stalled }), /timed out/); }
  finally { clearInterval(keepAlive); }
  assert.deepEqual(await readdir(config.serverCacheDirectory), []);
});

test('default plugin installs lazily and reuses its server resolution across workspaces', { skip: process.platform === 'win32' && 'the downloaded mock server is a JavaScript fixture while Windows release assets are PE binaries' }, async t => {
  const config = await fixture(t, { vanillaMode: 'disabled', autoRefresh: false });
  const script = await readFile(new URL('./fixtures/server.mjs', import.meta.url));
  const mock = github(pack(script), '0.5.3', { platform: process.platform, arch: process.arch, artifact: platformArtifact() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const h = await harness({ ...config, workspace: config.serverCacheDirectory });
  t.after(() => h.dispose());
  assert.equal(mock.calls.length, 0);
  const result = await h.call('paradoxcode_workspace');
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.result.server.version, '0.5.3');
  assert.equal(mock.calls.length, 3);
  const second = await h.call('paradoxcode_workspace', { workspace: join(config.serverCacheDirectory, '0.5.3-' + platformArtifact().target) });
  assert.equal(second.isError, false, JSON.stringify(second));
  assert.equal(mock.calls.length, 3);
});

test('plugin disposal cancels an in-flight automatic download', { timeout: 3000 }, async t => {
  const config = await fixture(t, { vanillaMode: 'disabled', autoRefresh: false });
  const originalFetch = globalThis.fetch;
  let downloading;
  const started = new Promise(resolve => { downloading = resolve; });
  globalThis.fetch = async (_url, { signal }) => {
    downloading();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const h = await harness({ ...config, workspace: config.serverCacheDirectory });
  t.after(() => h.dispose());
  const pending = h.call('paradoxcode_workspace');
  await started;
  await h.dispose();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled/);
  assert.deepEqual(await readdir(config.serverCacheDirectory), []);
});

test('plugin refuses a downloaded executable that advertises a different LSP version', { skip: process.platform === 'win32' && 'the downloaded mock server is a JavaScript fixture while Windows release assets are PE binaries' }, async t => {
  const config = await fixture(t, { vanillaMode: 'disabled', autoRefresh: false });
  const script = await readFile(new URL('./fixtures/server.mjs', import.meta.url));
  // The release resolves as 0.5.4 while the fixture reports 0.5.3: the mismatch must be refused.
  const mock = github(pack(script), '0.5.4', { artifact: platformArtifact() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const h = await harness({ ...config, workspace: config.serverCacheDirectory });
  t.after(() => h.dispose());
  const result = await h.call('paradoxcode_workspace');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reported server version 0.5.3/);
});

test('installation needs no user configuration: download, Mod detection and game discovery are default', { skip: process.platform === 'win32' && 'the downloaded mock server is a JavaScript fixture while Windows release assets are PE binaries' }, async t => {
  const config = await fixture(t);
  const mod = join(config.serverCacheDirectory, 'example-mod');
  await mkdir(join(mod, 'events'), { recursive: true });
  await writeFile(join(mod, 'descriptor.mod'), 'name="Example"\n');
  const script = await readFile(new URL('./fixtures/server.mjs', import.meta.url));
  const mock = github(pack(script), '0.5.3', { artifact: platformArtifact() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // Only isolate the cache location for the test; all product settings use their defaults.
  const h = await harness({ serverCacheDirectory: config.serverCacheDirectory });
  t.after(() => h.dispose());
  const result = await h.call('paradoxcode_workspace', {}, undefined, { session: { header: { cwd: join(mod, 'events') } } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.workspace, mod);
  assert.equal(result.value.result.server.version, '0.5.3');
  assert.equal(result.value.result.initializationOptions.vanillaMode, 'auto');
  assert.equal(mock.calls.length, 3);
});
