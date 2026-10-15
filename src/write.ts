import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { object, type JsonObject } from './json.js';
import { logicalPath, within, type WorkspaceSession } from './workspace.js';

/** Subset of the DSH `fs` service this writer uses; absent means the plugin must fall back to bytes. */
export interface FsService {
  resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey: unknown; displayPath: string }>;
  stat(target: unknown, signal?: AbortSignal): Promise<{ version: unknown; type: string; size: number } | undefined>;
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Subset of the DSH `sandboxPolicy` service: the per-call file-effect fence. */
export interface SandboxPolicyView { mode: string; workspaceRoot: string }

/** Host bridges resolved once per call, so the writer never imports DSH internals. */
export interface WriteBridges {
  policy(exec: unknown): SandboxPolicyView | undefined;
  fs(): FsService | undefined;
}

const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const BACKUP_ROOT = '_maintenance';

function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Whether a buffer is already plain UTF-8 text, matching how decodeFile treats it. */
function isUtf8(bytes: Buffer): boolean {
  try { new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); return true; }
  catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** Canonicalize the deepest existing ancestor, so a not-yet-created file can still be fenced. */
async function canonicalAncestor(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try { return await realpath(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function comparable(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }

function under(root: string, path: string): boolean {
  const rel = relative(comparable(root), comparable(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Mirror the DSH sandbox policy without importing its packages: `read-only` denies every mutation
 * and `workspace-write` allows the policy workspace root. Unlike DSH's generic `writableRoots`, the
 * platform temp area is NOT accepted — a Mod source file never lives there, and accepting it would
 * make the fence meaningless.
 */
async function assertPolicyAllows(policy: SandboxPolicyView | undefined, target: string): Promise<void> {
  if (!policy) throw new Error('Cannot read the session file policy (sandboxPolicy service unavailable); refusing to write. Use the DSH file tools or run without a sandbox policy.');
  if (policy.mode === 'danger-full-access') return;
  if (policy.mode !== 'workspace-write') throw new Error(`Writing is denied under "${policy.mode}" mode.`);
  const canonical = await canonicalAncestor(target);
  try {
    if (under(await realpath(policy.workspaceRoot), canonical)) return;
  } catch { /* the policy root does not exist: fall through to the denial */ }
  throw new Error(`Writing is denied under "workspace-write" mode: ${target} is outside the policy workspace root ${policy.workspaceRoot}.`);
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Small review summary instead of echoing whole files back to the model. */
function summarizeDiff(before: string, after: string): JsonObject {
  const beforeLines = before.split(/\r\n|\n|\r/);
  const afterLines = after.split(/\r\n|\n|\r/);
  let index = 0;
  while (index < beforeLines.length && index < afterLines.length && beforeLines[index] === afterLines[index]) index++;
  return {
    beforeLines: beforeLines.length, afterLines: afterLines.length,
    firstChangeLine: index + 1,
    beforeLine: index < beforeLines.length ? beforeLines[index]! : null,
    afterLine: index < afterLines.length ? afterLines[index]! : null,
  };
}

/** Publish raw bytes atomically; DSH's own writer cannot carry non-UTF-8 bytes. */
async function publishBytes(target: string, bytes: Buffer, mode: number | undefined, signal: AbortSignal): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.pcwrite.tmp`);
  const handle = await open(temporary, 'wx', mode ?? 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  if (mode !== undefined) await chmod(temporary, mode).catch(() => { /* best effort */ });
  try {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw signal.reason;
      try { await rename(temporary, target); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        // Windows refuses to replace a file another process holds open; retry, then report.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= 5) throw error;
        await delay(120 * (attempt + 1));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw new Error(`Cannot publish ${target}: the file is locked by another process (${code}). Close the game or editor holding it and retry.`);
    throw error;
  }
}

export interface WriteResult { applied: boolean; value: JsonObject }

/**
 * Write one Mod file, encoding it through ParadoxCode's whole-file transcode profile when the
 * target is not plain UTF-8. ParadoxCode 0.5.3+ is required: conversion is all-or-nothing, so a
 * damaged or unencodable input refuses the write instead of producing partial bytes.
 */
export async function writeSourceFile(
  session: WorkspaceSession,
  args: JsonObject,
  exec: unknown,
  bridges: WriteBridges,
  signal: AbortSignal,
): Promise<WriteResult> {
  const logical = logicalPath(typeof args.path === 'string' ? args.path : '');
  if (typeof args.text !== 'string') throw new Error('text must be a string (pass "" to write an empty file)');
  const content = args.text;
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('text exceeds the 16 MiB write limit');
  const apply = args.apply === true;
  const expected = typeof args.expectedSha256 === 'string' ? args.expectedSha256.trim().toLowerCase() : undefined;
  if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('expectedSha256 must be a 64-character hexadecimal SHA-256');
  const target = resolve(session.root, logical);
  // The Mod root is the only writable root; dependencies and Vanilla stay read-only.
  if (!within(session.root, await canonicalAncestor(target))) throw new Error('Write target resolves outside the Mod root');
  await assertPolicyAllows(bridges.policy(exec), target);

  const present = await exists(target);
  if (present && expected === undefined) throw new Error('expectedSha256 is required to overwrite an existing file: read it with paradoxcode_read first, then pass its sha256');
  if (!present && expected !== undefined) throw new Error('expectedSha256 was supplied but the file does not exist; drop it to create a new file');

  let original: { bytes: Buffer; text: string; sha256: string; form: string | null; profile: string | null } | null = null;
  if (present) {
    const file = await session.decodeFile(target, signal);
    if (file.lossy) throw new Error(`Refusing to write ${logical}: the current bytes cannot be decoded faithfully (${JSON.stringify(file.damage)}). Fix or restore the file first.`);
    const form = typeof file.damage?.form === 'string' ? file.damage.form : null;
    if (form === 'mixed') throw new Error(`Refusing to write ${logical}: the file mixes encoded and readable runs, so a whole-file rewrite would change unrelated content.`);
    if (file.sha256 !== expected) throw new Error(`Refusing to write ${logical}: current SHA-256 ${file.sha256} does not match expectedSha256 ${expected} (the file changed since it was read).`);
    original = { bytes: file.bytes, text: file.text, sha256: file.sha256, form, profile: typeof file.damage?.profile === 'string' ? file.damage.profile : null };
  }

  // Representation follows the file: an existing UTF-8 file stays UTF-8 (symmetric with
  // paradoxcode_read, which only transcodes bytes that are not valid UTF-8), while a file whose
  // bytes are not UTF-8 keeps its encoded form. New files are plain UTF-8 unless requested.
  const readable = original === null || isUtf8(original.bytes);
  const encode = args.encode === true || !readable;

  let encoded: Buffer;
  let profile: string | null = original?.profile ?? null;
  let form = readable && args.encode !== true ? 'utf-8' : 'encoded';
  let idempotent: boolean | null = null;
  if (!encode) {
    encoded = Buffer.from(content, 'utf8');
  } else {
    // Encode the whole file. 0.5.3 answers {bytes} on success and {refused,...} without bytes otherwise.
    const encodedResult = object(await session.request('pdc/transcodeEncode', { path: target, bytes: Buffer.from(content, 'utf8').toString('hex') }, signal));
    if (typeof encodedResult.refused === 'string') {
      throw new Error(`ParadoxCode refused to encode ${logical} (${encodedResult.refused}): nothing was written. Check the text for unencodable characters.`);
    }
    if (typeof encodedResult.bytes !== 'string' || !/^(?:[a-f\d]{2})*$/i.test(encodedResult.bytes)) throw new Error('ParadoxCode returned an invalid transcode encode result');
    encoded = Buffer.from(encodedResult.bytes, 'hex');
    // Forward check: decoding the exact bytes we are about to publish must return the requested text.
    const roundTrip = object(await session.request('pdc/transcodeDecode', { path: target, bytes: encoded.toString('hex') }, signal));
    if (roundTrip.refused !== undefined || roundTrip.form === 'damaged') throw new Error(`Refusing to write ${logical}: the encoded bytes do not decode cleanly (${JSON.stringify(roundTrip)}).`);
    if (typeof roundTrip.bytes !== 'string' || Buffer.from(roundTrip.bytes, 'hex').toString('utf8') !== content) {
      throw new Error(`Refusing to write ${logical}: decoding the encoded bytes does not reproduce the requested text.`);
    }
    profile = typeof roundTrip.profile === 'string' ? roundTrip.profile : profile;
    form = typeof roundTrip.form === 'string' ? roundTrip.form : 'encoded';
    // Idempotence check: a file that is already encoded must re-encode to the same bytes.
    if (original && !readable) {
      const reencoded = object(await session.request('pdc/transcodeEncode', { path: target, bytes: original.bytes.toString('hex') }, signal));
      idempotent = typeof reencoded.bytes === 'string' && reencoded.bytes === original.bytes.toString('hex');
      if (!idempotent) throw new Error(`Refusing to write ${logical}: re-encoding the current file does not reproduce it byte-for-byte, so a rewrite could lose content.`);
    }
  }
  if (encoded.length > MAX_WRITE_BYTES) throw new Error('encoded output exceeds the 16 MiB write limit');

  const afterSha256 = sha256(encoded);
  const summary: JsonObject = {
    applied: false, path: logical, root: 'mod', writable: true,
    beforeSha256: original?.sha256 ?? null, afterSha256, bytes: encoded.length,
    encoding: { profile, form, encoded: encode },
    checks: { decodeMatches: true, idempotent },
    preview: summarizeDiff(original?.text ?? '', content),
  };
  if (!apply) return { applied: false, value: summary };

  // Back up the original bytes: this directory is not a git repository, so that is the rollback.
  let backup: string | null = null;
  if (original) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    backup = join(BACKUP_ROOT, `paradoxcode_write_${stamp}`, 'before', logical);
    const backupPath = join(session.root, backup);
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, original.bytes);
  }

  // Prefer DSH's own writer whenever the bytes are plain UTF-8: it keeps the sandbox fence, the
  // version guard and the platform's atomic publication. Legacy bytes need our own publisher.
  const fs = bridges.fs();
  const utf8RoundTrip = encoded.toString('utf8') === content;
  let mode: string;
  if (fs && utf8RoundTrip) {    const handle = await fs.resolve(logical, { cwd: session.root });
    const info = await fs.stat(handle, signal);
    const guard = original ? { kind: 'replaceIfVersion', version: info?.version } : { kind: 'createIfAbsent' };
    if (original && info === undefined) throw new Error('Refusing to write: the file disappeared since it was read');
    await fs.writeText(handle, content, guard, signal);
    mode = 'fs';
  } else {
    // Re-check existence immediately before an unfenced publish to narrow the create race.
    if (!original && await exists(target)) throw new Error(`Refusing to write ${logical}: the file appeared after it was checked`);
    const info = original ? await stat(target) : undefined;
    await publishBytes(target, encoded, info?.mode, signal);
    mode = 'bytes';
  }

  const written = await readFile(target);
  if (sha256(written) !== afterSha256) throw new Error(`Write verification failed for ${logical}: on-disk SHA-256 does not match the encoded bytes`);
  session.markDirty(target);
  return { applied: true, value: { ...summary, applied: true, mode, backup, preview: null } };
}
