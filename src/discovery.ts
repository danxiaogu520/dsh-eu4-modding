import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkAbort } from './json.js';
import { readSettings } from './settings.js';

const CATEGORIES = new Set(['common', 'events', 'missions', 'decisions', 'history', 'localisation', 'map', 'gfx', 'interface']);
const COMMON_CATEGORIES = new Set(['scripted_effects', 'scripted_triggers', 'country_tags', 'countries', 'event_modifiers', 'on_actions', 'ideas', 'religions']);

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

async function isModRoot(path: string): Promise<boolean> {
  const files = await entries(path);
  if (files.some(file => file.isFile() && file.name === 'descriptor.mod')) return true;
  const directories = files.filter(file => file.isDirectory()).map(file => file.name);
  if (directories.includes('.vscode') && Object.keys((await readSettings(path)).data).some(key => key.startsWith('paradoxcode.'))) return true;
  if (directories.filter(name => CATEGORIES.has(name)).length >= 2) return true;
  if (directories.includes('common') && (await entries(join(path, 'common'))).some(file => file.isDirectory() && COMMON_CATEGORIES.has(file.name))) return true;
  for (const name of ['events', 'missions', 'decisions', 'localisation']) {
    if (!directories.includes(name)) continue;
    const files = await entries(join(path, name));
    if (files.some(file => file.isFile() && (name === 'localisation' ? /_l_[a-z]+\.ya?ml$/i : /\.txt$/i).test(file.name))) return true;
  }
  return false;
}

/** Prefer the current Mod or its nearest ancestor; inspect only immediate children of a container. */
export async function discoverModRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const current = await realpath(cwd);
  if (!(await stat(current)).isDirectory()) throw new Error('workspace must be a directory');
  for (let candidate = current;; candidate = dirname(candidate)) {
    checkAbort(signal);
    if (await isModRoot(candidate)) return candidate;
    if (dirname(candidate) === candidate) break;
  }
  const children = (await entries(current)).filter(file => file.isDirectory() && !file.name.startsWith('.') && !['node_modules', 'target'].includes(file.name));
  // Large unrelated folders should not trigger a broad filesystem search.
  if (children.length > 64) throw new Error(`Automatic Mod discovery stopped: ${current} contains ${children.length} child directories (limit 64). Select the Mod explicitly with workspace.`);
  const candidates: string[] = [];
  for (const child of children) {
    checkAbort(signal);
    const path = join(current, child.name);
    if (await isModRoot(path)) candidates.push(path);
  }
  if (candidates.length > 1) throw new Error(`Multiple EU4 Mods found. Choose a Mod with the tool's workspace parameter: ${candidates.join(', ')}`);
  // Keep empty/new Mod directories usable before any files have been created.
  return candidates[0] ?? current;
}
