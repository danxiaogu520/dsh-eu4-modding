import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.js';
import { extractServer, MAX_ARCHIVE_BYTES, MAX_EXECUTABLE_BYTES, platformArtifact, type ServerArtifact } from './archive.js';
import { checkAbort } from './json.js';

const REPOSITORY = 'danxiaogu520/ParadoxCode';
const RELEASES = `https://github.com/${REPOSITORY}/releases/download`;
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[a-f0-9]{64}$/;
export const BOOTSTRAP_VERSION = '0.5.2';

function versionParts(version: string): number[] { return version.split('.').map(Number); }
function compareVersions(a: string, b: string): number {
  const aa = versionParts(a), bb = versionParts(b);
  return aa[0]! - bb[0]! || aa[1]! - bb[1]! || aa[2]! - bb[2]!;
}
function compatible(version: string): boolean { return VERSION.test(version) && compareVersions(version, BOOTSTRAP_VERSION) >= 0; }

export interface ServerResolution {
  path: string;
  source: 'local' | 'github';
  version?: string;
  target?: string;
  warning?: string;
}

interface Receipt {
  version: string;
  target: string;
  archiveSha256: string;
  executableSha256: string;
}

interface ResolverOptions {
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

class DownloadError extends Error {
  constructor(message: string, readonly unavailable = false) { super(message); }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function defaultCacheDirectory(): string {
  const home = homedir();
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    : process.platform === 'darwin' ? join(home, 'Library', 'Caches')
    : process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : join(home, '.cache');
  return join(base, 'dsh-eu4-modding', 'paradoxcode');
}

function downloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !['github.com', 'api.github.com'].includes(url.hostname) && !url.hostname.endsWith('.githubusercontent.com')) {
    throw new DownloadError('ParadoxCode downloads must use HTTPS on GitHub');
  }
  return url;
}

async function fetchBytes(url: string, maximum: number, signal: AbortSignal, fetcher: typeof globalThis.fetch, redirects = 0): Promise<Buffer> {
  checkAbort(signal);
  if (redirects > 5) throw new DownloadError('Too many GitHub download redirects');
  const parsed = downloadUrl(url);
  let response: Response;
  try {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    response = await fetcher(parsed, { signal, redirect: 'manual', headers: { 'User-Agent': 'dsh-eu4-modding', Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', ...(parsed.hostname === 'api.github.com' && token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch (error) {
    checkAbort(signal);
    throw new DownloadError(`Cannot download ${parsed.pathname}: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    await response.body?.cancel();
    return fetchBytes(new URL(response.headers.get('location')!, parsed).href, maximum, signal, fetcher, redirects + 1);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadError(`GitHub download failed with HTTP ${response.status} (${parsed.pathname})`, response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500);
  }
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new DownloadError(`GitHub download exceeds the ${maximum}-byte limit`);
  }
  if (!response.body) throw new DownloadError('GitHub returned an empty download');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new DownloadError(`GitHub download exceeds the ${maximum}-byte limit`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    checkAbort(signal);
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(`GitHub download interrupted: ${String(error)}`, true);
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function parseChecksum(sidecar: string, archive: string): string {
  const rows = sidecar.trim().split(/\r?\n/);
  if (rows.length !== 1) throw new Error('Invalid GitHub SHA-256 sidecar');
  const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(rows[0]!);
  if (!match || match[2] !== archive) throw new Error(`GitHub SHA-256 sidecar does not match ${archive}`);
  return match[1]!.toLowerCase();
}

async function cachedServer(root: string, version: string, artifact: ServerArtifact, expectedArchiveSha256?: string): Promise<ServerResolution | undefined> {
  if (!VERSION.test(version)) return undefined;
  const directory = join(root, `${version}-${artifact.target}`);
  const path = join(directory, artifact.binary);
  try {
    const receiptPath = join(directory, 'receipt.json');
    const [receiptStat, binaryStat] = await Promise.all([lstat(receiptPath), lstat(path)]);
    if (!receiptStat.isFile() || receiptStat.size > 4096 || !binaryStat.isFile() || !binaryStat.size || binaryStat.size > MAX_EXECUTABLE_BYTES) return undefined;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
    if (receipt.version !== version || receipt.target !== artifact.target || !DIGEST.test(receipt.archiveSha256) || !DIGEST.test(receipt.executableSha256)
      || expectedArchiveSha256 && receipt.archiveSha256 !== expectedArchiveSha256) return undefined;
    if (sha256(await readFile(path)) !== receipt.executableSha256) return undefined;
    if (process.platform !== 'win32') await chmod(path, 0o755);
    return { path, source: 'github', version, target: artifact.target };
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function cachedLatest(root: string, artifact: ServerArtifact): Promise<ServerResolution | undefined> {
  try {
    const pointer = join(root, `latest-${artifact.target}.json`);
    const info = await lstat(pointer);
    if (!info.isFile() || info.size > 4096) return undefined;
    const value = JSON.parse(await readFile(pointer, 'utf8')) as { version: string };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { version } = value;
    if (typeof version !== 'string') return undefined;
    return cachedServer(root, version, artifact);
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function cachedFallback(root: string, artifact: ServerArtifact): Promise<ServerResolution | undefined> {
  let rows;
  try { rows = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const versions = rows.filter(row => row.isDirectory() && row.name.endsWith(`-${artifact.target}`))
    .map(row => row.name.slice(0, -artifact.target.length - 1)).filter(compatible).sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const cached = await cachedServer(root, version, artifact);
    if (cached) return cached;
  }
  return undefined;
}

async function webLatest(signal: AbortSignal, fetcher: typeof globalThis.fetch): Promise<string> {
  let url = `https://github.com/${REPOSITORY}/releases/latest`;
  for (let redirects = 0; redirects < 6; redirects++) {
    checkAbort(signal);
    const parsed = downloadUrl(url);
    if (parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(`/${REPOSITORY}/releases/`)) throw new DownloadError('Invalid GitHub latest release redirect');
    let response: Response;
    try { response = await fetcher(parsed, { signal, redirect: 'manual', headers: { 'User-Agent': 'dsh-eu4-modding' } }); }
    catch { checkAbort(signal); throw new DownloadError('Cannot discover the release through GitHub web redirects', true); }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, parsed).href;
      const target = downloadUrl(url);
      const match = new RegExp(`^/${REPOSITORY}/releases/tag/v?(\\d+\\.\\d+\\.\\d+)$`).exec(target.pathname);
      if (target.hostname === 'github.com' && match && compatible(match[1]!)) return match[1]!;
      continue;
    }
    if (!response.ok) throw new DownloadError(`GitHub release discovery failed with HTTP ${response.status}`, response.status === 403 || response.status === 429 || response.status >= 500);
    throw new DownloadError('GitHub did not return a stable release redirect', true);
  }
  throw new DownloadError('Too many GitHub latest release redirects');
}

async function install(root: string, version: string, artifact: ServerArtifact, archive: Buffer, archiveSha256: string, signal: AbortSignal): Promise<ServerResolution> {
  if (sha256(archive) !== archiveSha256) throw new Error('ParadoxCode archive SHA-256 mismatch; downloaded bytes will not be executed');
  // Another profile may have completed this immutable release while we were downloading.
  const existing = await cachedServer(root, version, artifact, archiveSha256);
  checkAbort(signal);
  if (existing) return existing;
  const bytes = await extractServer(archive, artifact);
  checkAbort(signal);
  const directory = join(root, `${version}-${artifact.target}`);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.install-'));
  try {
    const path = join(staging, artifact.binary);
    await writeFile(path, bytes, { mode: 0o755, flag: 'wx' });
    const receipt: Receipt = { version, target: artifact.target, archiveSha256, executableSha256: sha256(bytes) };
    await writeFile(join(staging, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
    checkAbort(signal);
    // Publish complete files atomically. Concurrent profiles install the same immutable bytes.
    await rename(path, join(directory, artifact.binary));
    await rename(join(staging, 'receipt.json'), join(directory, 'receipt.json'));
    return { path: join(directory, artifact.binary), source: 'github', version, target: artifact.target };
  } catch (error) {
    // Windows can deny replacing an executable already started by a concurrent profile.
    if (['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      const concurrent = await cachedServer(root, version, artifact, archiveSha256);
      if (concurrent) return concurrent;
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Resolve once per plugin lifetime. Fixed versions can start entirely offline from a verified cache. */
export async function resolveServer(config: Config, signal?: AbortSignal, options: ResolverOptions = {}): Promise<ServerResolution> {
  checkAbort(signal);
  if (config.serverPath !== 'auto') return { path: config.serverPath, source: 'local' };
  const artifact = platformArtifact(options.platform, options.arch);
  const root = config.serverCacheDirectory || defaultCacheDirectory();
  const fetcher = options.fetch ?? globalThis.fetch;
  const deadline = AbortSignal.timeout(config.downloadTimeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const latest = config.serverVersion === 'latest';
  try {
    let version = config.serverVersion;
    let apiDigest: string | undefined;
    if (latest) {
      const bytes = await fetchBytes(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 1024 * 1024, active, fetcher);
      const release = JSON.parse(bytes.toString('utf8')) as { tag_name: string; prerelease?: boolean; draft?: boolean; assets: { name: string; digest?: string }[] };
      if (!release || typeof release !== 'object' || typeof release.tag_name !== 'string' || release.prerelease || release.draft || !Array.isArray(release.assets)
        || release.assets.some(entry => !entry || typeof entry !== 'object' || typeof entry.name !== 'string')) throw new Error('GitHub returned an invalid stable release');
      version = release.tag_name.replace(/^v/, '');
      if (!VERSION.test(version)) throw new Error('GitHub returned an unsupported release version');
      const name = `paradoxcode-v${version}-${artifact.target}.${artifact.extension}`;
      const asset = release.assets.find(entry => entry.name === name);
      if (!asset || !release.assets.some(entry => entry.name === `${name}.sha256`)) throw new Error(`ParadoxCode ${version} has no archive/checksum for ${artifact.target}. Configure serverPath with a local executable.`);
      if (asset.digest !== undefined && asset.digest !== null) {
        if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Invalid GitHub asset digest');
        apiDigest = asset.digest.slice(7);
      }
    }
    const cached = await cachedServer(root, version, artifact, apiDigest);
    let resolved = cached;
    if (!resolved) {
      const archiveName = `paradoxcode-v${version}-${artifact.target}.${artifact.extension}`;
      const url = `${RELEASES}/v${version}/${archiveName}`;
      const checksum = parseChecksum((await fetchBytes(`${url}.sha256`, 1024, active, fetcher)).toString('utf8'), archiveName);
      if (apiDigest && checksum !== apiDigest) throw new Error('GitHub release digest and SHA-256 sidecar disagree');
      resolved = await install(root, version, artifact, await fetchBytes(url, MAX_ARCHIVE_BYTES, active, fetcher), checksum, active);
    }
    checkAbort(active);
    if (latest) {
      const staging = await mkdtemp(join(root, '.latest-'));
      try {
        await writeFile(join(staging, 'pointer.json'), JSON.stringify({ version }));
        await rename(join(staging, 'pointer.json'), join(root, `latest-${artifact.target}.json`));
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return resolved;
  } catch (error) {
    checkAbort(signal);
    const timedOut = deadline.aborted;
    const unavailable = error instanceof DownloadError && error.unavailable;
    const deadlineFailure = timedOut && (unavailable || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
    // An elapsed deadline must never turn an integrity/protocol failure into a downgrade.
    if (latest && (deadlineFailure || unavailable)) {
      const pointer = await cachedLatest(root, artifact);
      const cached = pointer && compatible(pointer.version!) ? pointer : await cachedFallback(root, artifact);
      if (cached) return { ...cached, warning: `Could not check/download the latest release; using verified cached ParadoxCode ${cached.version}. ${timedOut ? 'Download timed out.' : String(error)}` };
      if (!timedOut) {
        let version: string;
        let discovery = 'GitHub web redirect';
        try { version = await webLatest(active, fetcher); }
        catch (fallbackError) {
          checkAbort(signal);
          if (deadline.aborted && fallbackError instanceof Error && ['AbortError', 'TimeoutError'].includes(fallbackError.name)) throw new Error(`ParadoxCode download timed out after ${config.downloadTimeoutMs} ms. Retry or configure serverPath with a local executable.`);
          if (!(fallbackError instanceof DownloadError && fallbackError.unavailable)) throw fallbackError;
          version = BOOTSTRAP_VERSION;
          discovery = 'bundled bootstrap version';
        }
        try {
          const fallback = await resolveServer({ ...config, serverVersion: version }, active, options);
          return { ...fallback, warning: `GitHub API unavailable; using verified ParadoxCode ${version} from ${discovery}. Latest status is unconfirmed. ${String(error)}` };
        } catch (fallbackError) {
          checkAbort(signal);
          if (deadline.aborted) throw new Error(`ParadoxCode download timed out after ${config.downloadTimeoutMs} ms. Retry or configure serverPath with a local executable.`);
          throw fallbackError;
        }
      }
    }
    if (deadlineFailure) throw new Error(`ParadoxCode download timed out after ${config.downloadTimeoutMs} ms. Retry or configure serverPath with a local executable.`);
    throw error;
  }
}
