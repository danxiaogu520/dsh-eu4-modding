import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, SyntaxKind, type ParseError } from 'jsonc-parser';
import { configOverrides, initializationOptions, normalizeConfig, type Config, type Dependency } from './config.js';
import { checkAbort, object, type Json, type JsonObject } from './json.js';

const MAX_SETTINGS_BYTES = 1024 * 1024;
export const settingsHash = (text: string) => createHash('sha256').update(text).digest('hex');

export interface SettingsFile { path: string; text: string; data: JsonObject; exists: boolean; hash: string }
export interface SharedWorkspace {
  base: string;
  root: string;
  settings: SettingsFile;
  options: JsonObject;
  dependencies: Dependency[];
  dependenciesSource: 'plugin' | 'vscode' | 'default';
  fingerprint: string;
}

export async function readSettings(root: string): Promise<SettingsFile> {
  const path = join(root, '.vscode', 'settings.json');
  let text = '';
  let exists = false;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) throw new Error(`${path}: settings must be a file of at most 1 MiB`);
    const bytes = await readFile(path);
    if (bytes.length > MAX_SETTINGS_BYTES) throw new Error(`${path}: settings exceed 1 MiB`);
    text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const body = text.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const tree = parseTree(body, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length) {
    const error = errors[0]!;
    const line = body.slice(0, error.offset).split('\n').length;
    throw new Error(`${path}:${line}: invalid JSONC (${printParseErrorCode(error.error)})`);
  }
  // getNodeValue builds null-prototype objects; a native JSON roundtrip preserves data keys safely.
  const data = tree ? object(JSON.parse(JSON.stringify(getNodeValue(tree))) as Json, path) : {};
  const seen = new Set<string>();
  for (const property of tree?.children ?? []) {
    const key = property.children?.[0]?.value as string;
    if (key?.startsWith('paradoxcode.') && seen.has(key)) throw new Error(`${path}: duplicate setting ${key}`);
    seen.add(key);
  }
  return { path, text, data, exists, hash: settingsHash(text) };
}

export function dependencyList(value: Json | unknown, label: string): Dependency[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${label}: dependencies must be an array of at most 128 entries`);
  const ids = new Set<string>();
  return value.map((entry: Json) => {
    const row = object(entry, label);
    if (!Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'path') || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.id) || typeof row.path !== 'string' || !row.path.trim()) {
      throw new Error(`${label}: each dependency needs a valid id and a non-empty path`);
    }
    if (Object.keys(row).some(key => !['id', 'path', 'index'].includes(key))) throw new Error(`${label}: unsupported dependency field`);
    if (ids.has(row.id.toLowerCase())) throw new Error(`${label}: duplicate dependency id ${row.id}`);
    ids.add(row.id.toLowerCase());
    if (row.index !== undefined && typeof row.index !== 'string') throw new Error(`${label}: index must be a string`);
    const index = typeof row.index === 'string' ? row.index.trim() : '';
    return { id: row.id, path: row.path.trim(), ...(index ? { index } : {}) };
  });
}

export function configuredPath(base: string, value: string): string {
  if (/\$\{/.test(value)) throw new Error(`Unsupported variable in path ${value}; use a literal absolute or workspace-relative path, as in ParadoxCode's VS Code settings`);
  return resolve(base, value);
}

export async function resolveDependencies(base: string, rows: Dependency[]): Promise<Dependency[]> {
  const result: Dependency[] = [];
  for (const row of rows) {
    const path = configuredPath(base, row.path);
    let canonical = path;
    try {
      if (!(await stat(path)).isDirectory()) throw new Error(`Dependency ${row.id} is not a directory: ${path}`);
      canonical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !row.index) throw error;
      // ParadoxCode permits offline source directories when an index is available.
    }
    result.push({ id: row.id, path: canonical, ...(row.index ? { index: configuredPath(base, row.index) } : {}) });
  }
  return result;
}

export function validateRoots(root: string, rows: Dependency[]): void {
  const roots = [root, ...rows.map(row => row.path)];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const a = relative(roots[i]!, roots[j]!);
    const b = relative(roots[j]!, roots[i]!);
    const inside = (value: string) => value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
    if (inside(a) || inside(b)) throw new Error(`Source roots must not overlap: ${roots[i]} and ${roots[j]}`);
  }
}

const mapped = [
  ['gameDirectory', 'gameDirectory'], ['vanillaIndexCache', 'vanillaIndexCache'],
  ['vanilla.mode', 'vanillaMode'], ['localisation.preferredLanguages', 'preferredLocalisationLanguages'],
] as const;
const extra = [
  ['backgroundReindexIntervalMinutes', 'backgroundReindexIntervalMinutes'], ['backgroundReindexIdleSeconds', 'backgroundReindexIdleSeconds'],
  ['ignoreFilePatterns', 'ignoreFilePatterns'], ['ignoreDirectories', 'ignoreDirectories'], ['diagnosticIgnoreCodes', 'ignoredErrorCodes'],
  ['diagnostics.severityOverrides', 'diagnosticSeverityOverrides'], ['localisation.transparentScriptGlobs', 'transparentScriptGlobs'],
  ['completion.sourceLayers', 'completionSourceLayers'], ['performance.profile', 'performanceProfile'], ['workspaceWideDiagnostics', 'workspaceWideDiagnostics'],
] as const;

export async function loadWorkspace(base: string, config: Config, signal?: AbortSignal): Promise<SharedWorkspace> {
  checkAbort(signal);
  const settings = await readSettings(base);
  const overrides = configOverrides(config);
  const values: Partial<Config> = { ...config };
  for (const [key, field] of mapped) {
    const value = settings.data[`paradoxcode.${key}`];
    if (!overrides.has(field) && Object.hasOwn(settings.data, `paradoxcode.${key}`)) Object.assign(values, { [field]: value });
  }
  const effective = normalizeConfig(values);
  const modDirectory = settings.data['paradoxcode.modDirectory'];
  if (modDirectory !== undefined && typeof modDirectory !== 'string') throw new Error(`${settings.path}: modDirectory must be a string`);
  const root = modDirectory ? await realpath(configuredPath(base, modDirectory)) : base;
  if (!(await stat(root)).isDirectory()) throw new Error('modDirectory must point to a directory');
  const shared = Object.hasOwn(settings.data, 'paradoxcode.dependencies');
  const dependenciesSource = overrides.has('dependencies') ? 'plugin' : shared ? 'vscode' : 'default';
  const raw = dependenciesSource === 'vscode' ? settings.data['paradoxcode.dependencies'] : config.dependencies;
  const dependencies = await resolveDependencies(dependenciesSource === 'plugin' ? root : base, dependencyList(raw, settings.path));
  validateRoots(root, dependencies);
  effective.dependencies = dependencies;
  // Shared paths are based on the VS Code workspace, even when modDirectory selects a child.
  for (const field of ['gameDirectory', 'vanillaIndexCache'] as const) {
    if (effective[field]) effective[field] = configuredPath(overrides.has(field) ? root : base, effective[field]);
  }
  const options = initializationOptions(effective);
  for (const [key, field] of extra) if (Object.hasOwn(settings.data, `paradoxcode.${key}`)) options[field] = settings.data[`paradoxcode.${key}`]!;
  checkAbort(signal);
  return { base, root, settings, options, dependencies, dependenciesSource, fingerprint: settingsHash(JSON.stringify({ root, options })) };
}

/** Only this setting is edited; unrelated editor settings, comments and line endings survive. */
export async function saveDependencies(root: string, snapshot: SettingsFile, rows: Dependency[], expectedHash: string, signal?: AbortSignal): Promise<SettingsFile> {
  checkAbort(signal);
  if (snapshot.hash !== expectedHash) throw new Error('Shared settings changed since inspection; inspect dependencies again before saving');
  const directory = join(root, '.vscode');
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('Refusing to write shared settings through a symlinked .vscode directory');
  let mode = 0o644;
  try {
    const info = await lstat(snapshot.path);
    if (!info.isFile()) throw new Error('Shared settings must be a regular file for editing');
    mode = info.mode & 0o777;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bom = snapshot.text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const original = snapshot.text.slice(bom.length);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
  let formatted = applyEdits(original || '{}', modify(original || '{}', ['paradoxcode.dependencies'], rows, {
    formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 4 : indent.length, eol },
  }));
  const oldTree = parseTree(original);
  const oldArray = oldTree ? findNodeAtLocation(oldTree, ['paradoxcode.dependencies']) : undefined;
  const comments: string[] = [];
  if (oldArray) {
    const body = original.slice(oldArray.offset, oldArray.offset + oldArray.length);
    const scanner = createScanner(body);
    for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
      if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) comments.push(body.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  if (comments.length) {
    const newTree = parseTree(formatted);
    const array = newTree ? findNodeAtLocation(newTree, ['paradoxcode.dependencies']) : undefined;
    if (!array) throw new Error('Could not preserve dependency comments; no changes were applied');
    const notes = comments.map(comment => `${indent}${indent}${comment}`).join(eol);
    const insertion = array.offset + 1;
    // Retain dependency notes at the array head when replacing/reordering its entries.
    formatted = formatted.slice(0, insertion) + eol + notes + eol + (rows.length ? '' : indent) + formatted.slice(insertion);
  }
  const text = bom + formatted + (formatted.endsWith('\n') ? '' : eol);
  if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) throw new Error('Updated shared settings would exceed 1 MiB; no changes were applied');
  const staging = join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, text, { flag: 'wx', mode });
    checkAbort(signal);
    if ((await readSettings(root)).hash !== snapshot.hash) throw new Error('Shared settings changed during saving; no changes were applied');
    await rename(staging, snapshot.path);
  } finally { await rm(staging, { force: true }); }
  return readSettings(root);
}
