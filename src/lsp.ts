import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { abortError, checkAbort, object, type Json, type JsonObject } from './json.js';

const MAX_FRAME = 64 * 1024 * 1024;
const MAX_HEADER = 8192;

/**
 * JavaScript entry points are launched through this runtime. On Windows a .mjs/.cjs file is not
 * executable at all, so spawning it directly fails with EFTYPE; native executables are unaffected.
 */
function isScript(file: string): boolean { return /\.(?:c|m)?js$/i.test(file); }

export class LspError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: Json) {
    super(`ParadoxCode LSP (${code}): ${message}`);
    this.name = 'LspError';
  }
}

interface Pending {
  resolve(value: Json): void;
  reject(error: Error): void;
}

/** One external server. No MCP, editor extension, or shell is involved. */
export class LspConnection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private frameLength: number | undefined;
  private failure?: Error;
  private stderr = '';
  private closed: Promise<void>;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private stopping?: Promise<void>;
  private exited = false;
  capabilities: JsonObject = {};
  serverInfo: JsonObject = {};

  constructor(
    serverPath: string,
    readonly workspace: string,
    readonly options: JsonObject,
    private readonly timeoutMs: number,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // The child may fail before initialization begins.
    void this.ready.catch(() => {});
    const script = isScript(serverPath);
    const command = script ? process.execPath : serverPath;
    this.child = spawn(command, script ? [serverPath] : [], { cwd: workspace, stdio: 'pipe', windowsHide: true, shell: false });
    this.closed = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.exited = true;
        this.fail(new Error(`ParadoxCode exited (${signal ?? code}). ${this.stderr}`));
        resolve();
      });
    });
    this.child.on('error', error => {
      this.fail(new Error(`Cannot launch ParadoxCode at ${serverPath}: ${error.message}. Configure serverPath with a standalone paradoxcode executable${script ? ' or make sure this Node runtime can execute the script' : ''}.`));
    });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16384);
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.receive(chunk); } catch (error) { this.fail(asError(error)); }
    });
  }

  get alive(): boolean { return !this.failure && !this.exited && !this.stopping; }
  get pid(): number | undefined { return this.child.pid; }

  async initialize(signal?: AbortSignal): Promise<void> {
    try {
      const response = object(await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'dsh-eu4-modding', version: '0.1.2' },
        workspaceFolders: [{ uri: pathToFileURL(this.workspace).href, name: basename(this.workspace) }],
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { didChangeWatchedFiles: { dynamicRegistration: false } },
          textDocument: {
            completion: { completionItem: { snippetSupport: false } },
            rename: { prepareSupport: true },
          },
        },
        initializationOptions: this.options,
      }, signal));
      this.capabilities = object(response.capabilities ?? {});
      this.serverInfo = object(response.serverInfo ?? {});
      this.notify('initialized', {});
      await this.waitReady(signal);
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  notify(method: string, params?: Json): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async request(method: string, params?: Json, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Json> {
    checkAbort(signal);
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled: Error | undefined;
    const cancel = (error: Error) => {
      if (cancelled) return;
      cancelled = error;
      try { this.notify('$/cancelRequest', { id }); } catch { /* already closed */ }
      clearTimeout(timer);
      // Drain the cancelled response before allowing another caller to use the snapshot.
      // A backend that ignores cancellation is still reclaimed within a bounded grace period.
      timer = setTimeout(() => this.fail(error), Math.min(1000, timeoutMs));
    };
    const onAbort = () => cancel(abortError());
    try {
      return await new Promise<Json>((resolve, reject) => {
        this.pending.set(id, {
          resolve: value => cancelled ? reject(cancelled) : resolve(value),
          reject: error => reject(cancelled ?? error),
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          const error = new Error(`ParadoxCode ${method} timed out after ${timeoutMs} ms. ${this.stderr}`);
          if (method === 'initialize' || method === 'shutdown') this.fail(error);
          else cancel(error);
        }, timeoutMs);
        try {
          checkAbort(signal);
          this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
        } catch (error) { reject(asError(error)); }
      });
    } catch (error) {
      if (!(error instanceof LspError) && (!cancelled || this.failure)) await this.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.pending.delete(id);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.failure && !this.exited) {
        try {
          await this.request('shutdown', undefined, undefined, 2000);
          this.notify('exit');
          this.child.stdin.end();
          await Promise.race([this.closed, delay(500)]);
        } catch { /* fall through to bounded process termination */ }
      }
      await this.terminate();
    })();
    return this.stopping;
  }

  private async waitReady(signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    const onAbort = () => this.fail(abortError());
    const timer = setTimeout(() => this.fail(new Error(`ParadoxCode did not send pdc/ready within ${this.timeoutMs} ms. Check server compatibility and indexing logs. ${this.stderr}`)), this.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      checkAbort(signal);
      await this.ready;
      checkAbort(signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private send(value: JsonObject): void {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length > MAX_FRAME) throw new Error('LSP payload exceeds 64 MiB');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.frameLength === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER) throw new Error('Oversized LSP header');
          return;
        }
        if (end > MAX_HEADER) throw new Error('Oversized LSP header');
        const lengths = this.buffer.subarray(0, end).toString('ascii').split('\r\n')
          .filter(line => /^content-length:/i.test(line));
        const raw = lengths[0]?.split(':')[1]?.trim();
        if (lengths.length !== 1 || !raw || !/^\d+$/.test(raw)) throw new Error('Invalid LSP Content-Length');
        this.frameLength = Number(raw);
        if (!Number.isSafeInteger(this.frameLength) || this.frameLength > MAX_FRAME) throw new Error('Oversized LSP frame');
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.frameLength) return;
      const message = object(JSON.parse(this.buffer.subarray(0, this.frameLength).toString('utf8')) as Json, 'LSP message');
      this.buffer = this.buffer.subarray(this.frameLength);
      this.frameLength = undefined;
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonObject): void {
    if (message.jsonrpc !== '2.0') throw new Error('Invalid LSP JSON-RPC version');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        let result: Json;
        switch (message.method) {
          case 'workspace/configuration': {
            const items = object(message.params ?? {}).items;
            result = Array.isArray(items) ? items.map(item => {
              const section = object(item).section;
              return !section || section === 'paradoxcode' ? this.options : null;
            }) : [];
            break;
          }
          case 'workspace/workspaceFolders':
            result = [{ uri: pathToFileURL(this.workspace).href, name: basename(this.workspace) }];
            break;
          case 'window/workDoneProgress/create':
          case 'client/registerCapability':
          case 'client/unregisterCapability':
            result = null;
            break;
          default:
            this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method not supported; DSH owns file edits' } });
            return;
        }
        this.send({ jsonrpc: '2.0', id: message.id, result });
      } else if (message.method === 'pdc/ready') {
        this.readyResolve();
      }
      return;
    }
    if (typeof message.id !== 'number') throw new Error('Invalid LSP response id');
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const error = object(message.error, 'LSP error');
      pending.reject(new LspError(Number(error.code), String(error.message), error.data));
    } else if ('result' in message) {
      pending.resolve(message.result!);
    } else {
      pending.reject(new Error('LSP response has neither result nor error'));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.exited) this.child.kill();
  }

  private async terminate(): Promise<void> {
    this.fail(new Error('ParadoxCode connection closed'));
    if (this.exited) return;
    this.child.kill();
    const force = setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL'); }, 1000);
    try { await this.closed; } finally { clearTimeout(force); }
  }
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
