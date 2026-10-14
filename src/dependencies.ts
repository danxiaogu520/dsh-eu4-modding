import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { configOverrides, type Config, type Dependency } from './config.js';
import { checkAbort, type Json, type JsonObject } from './json.js';
import { configuredPath, dependencyList, readSettings, resolveDependencies, saveDependencies, validateRoots } from './settings.js';

interface Chain { dependencies: Dependency[]; edges: { dependent: string; dependency: string }[]; warnings: string[] }

/** Expand dependencies without changing the relative priorities declared by any participating Mod. */
export async function dependencyChain(base: string, root: string, direct: Dependency[], signal?: AbortSignal): Promise<Chain> {
  const nodes = new Map<string, Dependency>();
  const ids = new Map<string, string>();
  const after = new Map<string, Set<string>>();
  const visiting = new Set<string>([root]);
  const visited = new Set<string>();
  const edges: Chain['edges'] = [];
  const warnings: string[] = [];
  const precedes = (low: string, high: string) => {
    if (!after.has(low)) after.set(low, new Set());
    after.get(low)!.add(high);
  };
  async function visit(directory: string, owner: string, rows: Dependency[], depth: number): Promise<void> {
    checkAbort(signal);
    if (depth > 32) throw new Error('Dependency chain exceeds 32 levels');
    const resolved = await resolveDependencies(directory, rows);
    for (const row of resolved) {
      const id = row.id.toLowerCase();
      if (ids.has(id) && ids.get(id) !== row.path) throw new Error(`Dependency id ${row.id} refers to different directories`);
      const known = nodes.get(row.path);
      if (known && (known.id.toLowerCase() !== id || known.index !== row.index)) throw new Error(`Conflicting id/index settings for dependency ${row.path}`);
      ids.set(id, row.path);
      nodes.set(row.path, known ?? row);
      if (nodes.size > 128) throw new Error('Dependency chain exceeds 128 Mods');
      edges.push({ dependent: owner === root ? '@project' : nodes.get(owner)!.id, dependency: row.id });
      if (owner !== root) precedes(row.path, owner);
    }
    for (let i = 1; i < resolved.length; i++) precedes(resolved[i - 1]!.path, resolved[i]!.path);
    for (const row of resolved) {
      if (visiting.has(row.path)) throw new Error(`Dependency cycle involving ${row.id} (${row.path})`);
      if (visited.has(row.path)) continue;
      visiting.add(row.path);
      let available = true;
      try { await stat(row.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        available = false;
      }
      if (available) {
        const settings = await readSettings(row.path);
        const nested = Object.hasOwn(settings.data, 'paradoxcode.dependencies') ? dependencyList(settings.data['paradoxcode.dependencies'], settings.path) : [];
        await visit(row.path, row.path, nested, depth + 1);
      } else warnings.push(`Cached dependency ${row.id} is offline; its transitive settings could not be inspected`);
      visiting.delete(row.path);
      visited.add(row.path);
    }
  }
  await visit(base, root, direct, 0);
  const incoming = new Map([...nodes.keys()].map(path => [path, 0]));
  for (const targets of after.values()) for (const target of targets) incoming.set(target, incoming.get(target)! + 1);
  const dependencies: Dependency[] = [];
  while (incoming.size) {
    const next = [...incoming].find(([, count]) => count === 0)?.[0];
    if (!next) throw new Error('Dependency loading order conflicts with the dependency chain; adjust the low-to-high priority lists before syncing');
    dependencies.push(nodes.get(next)!);
    incoming.delete(next);
    for (const target of after.get(next) ?? []) incoming.set(target, incoming.get(target)! - 1);
  }
  validateRoots(root, dependencies);
  return { dependencies, edges, warnings };
}

export async function manageDependencies(base: string, config: Config, args: JsonObject, signal: AbortSignal): Promise<Json> {
  const action = args.action ?? 'inspect';
  if (!['inspect', 'set', 'add', 'remove', 'sync'].includes(String(action))) throw new Error('Invalid dependency action');
  const snapshot = await readSettings(base);
  const modDirectory = snapshot.data['paradoxcode.modDirectory'];
  if (modDirectory !== undefined && typeof modDirectory !== 'string') throw new Error('paradoxcode.modDirectory must be a string');
  const root = modDirectory ? await realpath(configuredPath(base, modDirectory)) : base;
  const overridden = configOverrides(config).has('dependencies');
  const raw = overridden ? config.dependencies : Object.hasOwn(snapshot.data, 'paradoxcode.dependencies') ? snapshot.data['paradoxcode.dependencies'] : [];
  const source = overridden ? 'plugin' : Object.hasOwn(snapshot.data, 'paradoxcode.dependencies') ? 'vscode' : 'default';
  if (action === 'inspect') {
    if (args.dependencies !== undefined || args.id !== undefined || args.baseHash !== undefined) throw new Error('inspect accepts only workspace and action');
    try {
      const rows = dependencyList(raw, snapshot.path);
      const chain = await dependencyChain(overridden ? root : base, root, rows, signal);
      return { settingsFile: snapshot.path, baseHash: snapshot.hash, source, directDependencies: rows.map(row => ({ ...row })),
        loadOrder: chain.dependencies.map(row => ({ ...row })), edges: chain.edges, warnings: chain.warnings,
        needsSync: JSON.stringify(await resolveDependencies(overridden ? root : base, rows)) !== JSON.stringify(chain.dependencies) };
    } catch (error) {
      checkAbort(signal);
      return { settingsFile: snapshot.path, baseHash: snapshot.hash, source, directDependencies: raw as Json, issues: [error instanceof Error ? error.message : String(error)] };
    }
  }
  if (overridden) throw new Error('DSH dependencies override the shared settings. Remove that plugin override before managing VS Code dependencies.');
  if (typeof args.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.baseHash)) throw new Error('baseHash from a recent dependency inspection is required for saving');
  if (snapshot.hash !== args.baseHash) throw new Error('Shared settings changed since inspection; inspect dependencies again before saving');
  let rows: Dependency[];
  if (action === 'set') {
    if (args.id !== undefined) throw new Error('set accepts dependencies, not id');
    rows = dependencyList(args.dependencies, 'dependencies');
  } else {
    rows = dependencyList(raw, snapshot.path);
    if (action === 'add') {
      if (args.id !== undefined) throw new Error('add accepts dependencies, not id');
      const additions = dependencyList(args.dependencies, 'dependencies');
      if (!additions.length) throw new Error('add needs at least one dependency');
      rows = dependencyList([...rows, ...additions], 'dependencies');
    } else if (action === 'remove') {
      if (args.dependencies !== undefined || typeof args.id !== 'string') throw new Error('remove requires id and does not accept dependencies');
      if (!rows.some(row => row.id.toLowerCase() === (args.id as string).toLowerCase())) throw new Error(`Dependency ${args.id} is not in the shared list`);
      rows = rows.filter(row => row.id.toLowerCase() !== (args.id as string).toLowerCase());
    } else if (args.dependencies !== undefined || args.id !== undefined) throw new Error('sync accepts only workspace, action and baseHash');
  }
  const chain = await dependencyChain(base, root, rows, signal);
  if (action === 'sync') {
    if (chain.warnings.length) throw new Error(`Cannot sync an incomplete chain: ${chain.warnings.join('; ')}`);
    const portable = (path: string) => { const value = relative(base, path); return isAbsolute(value) ? path : value.replaceAll('\\', '/') || '.'; };
    rows = chain.dependencies.map(row => ({ id: row.id, path: portable(row.path), ...(row.index ? { index: portable(row.index) } : {}) }));
  }
  const saved = await saveDependencies(base, snapshot, rows, args.baseHash, signal);
  return { saved: true, settingsFile: saved.path, baseHash: saved.hash, directDependencies: rows.map(row => ({ ...row })),
    loadOrder: chain.dependencies.map(row => ({ ...row })), warnings: chain.warnings,
    needsSync: JSON.stringify(await resolveDependencies(base, rows)) !== JSON.stringify(chain.dependencies) };
}
