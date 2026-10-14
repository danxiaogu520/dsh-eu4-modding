import { watch, type FSWatcher } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import { initializationOptions } from './config.js';
import { checkAbort, object, type Json, type JsonObject } from './json.js';
import { LspConnection } from './lsp.js';
import { resolveServer, type ServerResolution } from './server.js';
import { loadWorkspace, type SharedWorkspace } from './settings.js';

export function logicalPath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (!path.trim() || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.' || !p)) {
    throw new Error(`Expected a Mod-relative logical path without traversal: ${value}`);
  }
  return path;
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Sessions are serialized so temporary document overlays never leak to another agent. */
export class WorkspaceSession {
  readonly connection: LspConnection;
  private watcher?: FSWatcher;
  private changed = 0;
  private synced = 0;
  private roots: string[];
  private version = 0;
  watchWarning?: string;

  constructor(readonly root: string, config: Config, readonly server: ServerResolution = { path: config.serverPath, source: 'local' }, public shared?: SharedWorkspace) {
    this.roots = [root];
    this.connection = new LspConnection(server.path, root, shared?.options ?? initializationOptions(config), config.timeoutMs);
    if (config.autoRefresh) {
      try {
        this.watcher = watch(root, { recursive: true }, (_type, filename) => {
          const path = filename?.toString().replaceAll('\\', '/');
          // Directory moves and .gui/.gfx edits affect analysis too.
          if (!path || !/(^|\/)(\.git|\.vscode|node_modules|\.paradoxcode|target)(\/|$)/.test(path)) {
            this.markDirty();
          }
        });
        this.watcher.on('error', error => {
          this.watchWarning = `File watching unavailable: ${error.message}. Use paradoxcode_refresh after external edits.`;
          this.watcher?.close();
          this.watcher = undefined;
        });
      } catch (error) {
        this.watchWarning = `File watching unavailable: ${String(error)}. Use paradoxcode_refresh after external edits.`;
      }
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.connection.initialize(signal);
    if (this.server.source === 'github' && this.connection.serverInfo.version !== this.server.version) {
      throw new Error(`Downloaded ParadoxCode ${this.server.version} reported server version ${String(this.connection.serverInfo.version)}; refusing to use a mismatched release.`);
    }
    await this.loadRoots(signal);
  }

  markDirty(): void { this.changed++; }

  async refresh(signal?: AbortSignal, force = false): Promise<Json | undefined> {
    if (!force && this.changed === this.synced) return undefined;
    const epoch = this.changed;
    const result = await this.connection.request('workspace/executeCommand', { command: 'pdc/reindexWorkspace', arguments: [] }, signal);
    await this.loadRoots(signal);
    this.synced = epoch;
    return result;
  }

  request(method: string, params?: Json, signal?: AbortSignal): Promise<Json> {
    return this.connection.request(method, params, signal);
  }

  async withDocument<T>(path: string, draft: string | undefined, signal: AbortSignal | undefined, fn: (uri: string, text: string) => Promise<T>): Promise<T> {
    checkAbort(signal);
    let resolved = path.startsWith('file:') ? fileURLToPath(path) : resolve(this.root, path);
    if (draft !== undefined) {
      // Draft overlays are restricted to the calling Mod; indexed dependencies stay read-only.
      logicalPath(path);
      resolved = resolve(this.root, path);
      let existing = resolved;
      for (;;) {
        try { existing = await realpath(existing); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = resolve(existing, '..');
          if (parent === existing) throw error;
          existing = parent;
        }
      }
      if (!within(this.root, existing)) throw new Error('Draft path resolves outside the Mod root');
    } else {
      resolved = await realpath(resolved);
      if (!this.roots.some(root => within(root, resolved))) throw new Error('File is outside the indexed Mod, dependency and Vanilla roots');
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Document must be a file of at most 4 MiB');
    }
    let text: string;
    if (draft !== undefined) text = draft;
    else {
      try { text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readFile(resolved)); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new Error('Document bytes are not UTF-8. Use paradoxcode_transcode_preview to inspect encoded text; disk diagnostics analyze the original source encoding.');
      }
    }
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('Document text exceeds 4 MiB');
    checkAbort(signal);
    const uri = pathToFileURL(resolved).href;
    this.connection.notify('textDocument/didOpen', { textDocument: {
      uri, languageId: /\.ya?ml$/i.test(resolved) ? 'localisation' : 'eu4', version: ++this.version, text,
    } });
    try { return await fn(uri, text); } finally {
      if (this.connection.alive) this.connection.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  synchronization(): JsonObject {
    return { watching: !!this.watcher, ...(this.watchWarning ? { warning: this.watchWarning } : {}) };
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    await this.connection.stop();
  }

  private async loadRoots(signal?: AbortSignal): Promise<void> {
    const summary = object(await this.request('pdc/workspaceSummary', undefined, signal));
    const roots = Array.isArray(summary.roots) ? summary.roots : [];
    this.roots = [this.root];
    for (const entry of roots) {
      const path = object(entry).path;
      if (typeof path !== 'string') continue;
      try { this.roots.push(await realpath(path.startsWith('file:') ? fileURLToPath(path) : path)); } catch { /* unavailable root: server reports coverage */ }
    }
  }
}

export class WorkspacePool {
  private sessions = new Map<string, WorkspaceSession>();
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private server?: ServerResolution;
  private shutdown = new AbortController();

  constructor(private readonly config: Config) {}

  private async exclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      checkAbort(signal);
      if (this.disposed) throw new Error('ParadoxCode plugin is disposed');
      return await fn();
    } finally { release(); }
  }

  async configure<T>(workspace: string, signal: AbortSignal | undefined, fn: (base: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.exclusive(signal, async () => {
      const base = await realpath(workspace);
      if (!(await stat(base)).isDirectory()) throw new Error('workspace must be a directory');
      const active = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
      checkAbort(active);
      return fn(base, active);
    });
  }

  async run<T>(workspace: string, signal: AbortSignal | undefined, fn: (session: WorkspaceSession) => Promise<T>): Promise<T> {
    return this.exclusive(signal, async () => {
      const root = await realpath(workspace);
      if (!(await stat(root)).isDirectory()) throw new Error('workspace must be a directory');
      if (this.disposed) throw new Error('ParadoxCode plugin is disposed');
      const active = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
      const shared = await loadWorkspace(root, this.config, active);
      let session = this.sessions.get(root);
      if (session && (!session.connection.alive || session.shared?.fingerprint !== shared.fingerprint)) {
        await session.stop();
        this.sessions.delete(root);
        session = undefined;
      }
      if (!session) {
        this.server ??= await resolveServer(this.config, active);
        checkAbort(active);
        while (this.sessions.size >= this.config.maxWorkspaces) {
          const oldest = this.sessions.entries().next().value!;
          this.sessions.delete(oldest[0]);
          await oldest[1].stop();
        }
        checkAbort(active);
        session = new WorkspaceSession(shared.root, this.config, this.server, shared);
        this.sessions.set(root, session);
        try { await session.initialize(active); } catch (error) {
          this.sessions.delete(root);
          await session.stop();
          throw error;
        }
      }
      session.shared = shared;
      this.sessions.delete(root);
      this.sessions.set(root, session);
      await session.refresh(signal);
      return await fn(session);
    });
  }

  markDirty(): void {
    if (this.config.autoRefresh) for (const session of this.sessions.values()) session.markDirty();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort();
    // Stop active requests immediately, then let queued operations observe disposed.
    await Promise.all([...this.sessions.values()].map(session => session.stop()));
    await this.tail;
    await Promise.all([...this.sessions.values()].map(session => session.stop()));
    this.sessions.clear();
  }
}
