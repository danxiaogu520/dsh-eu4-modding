import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.js';
import { object, type Json, type JsonObject } from './json.js';
import { logicalPath, within, type WorkspacePool, type WorkspaceSession } from './workspace.js';
import { manageDependencies } from './dependencies.js';

interface Spec {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  run?(session: WorkspaceSession, args: JsonObject, signal: AbortSignal): Promise<Json>;
  manage?(base: string, config: Config, args: JsonObject, signal: AbortSignal): Promise<Json>;
}

const string = (description: string, required?: true) => ({ type: 'string' as const, description, ...(required ? { required } : {}) });
const integer = (description: string) => ({ type: 'integer' as const, description });
const cursor = {
  path: string('Indexed file path, file: URI, or Mod-relative path. Draft text uses a Mod-relative path.', true),
  line: integer('1-based line; required for hover, completion, definition and references.'),
  character: integer('0-based UTF-16 column, default 0. Returned LSP ranges remain 0-based.'),
};

function text(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (key !== 'text' && !value.trim())) throw new Error(`${key} must be a non-empty string`);
  return key === 'text' ? value : value.trim();
}

function number(args: JsonObject, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function position(args: JsonObject, content: string): JsonObject {
  if (args.line === undefined) throw new Error('line is required for this action');
  const line = number(args, 'line', 1, 1, 10000000) - 1;
  const character = number(args, 'character', 0, 0, 10000000);
  const lines = content.split(/\r\n|\n|\r/);
  if (line >= lines.length || character > lines[line]!.length) throw new Error('Position is outside the document (1-based line, 0-based UTF-16 column)');
  return { line, character };
}

function countDiagnostics(value: Json): JsonObject {
  const counts = { errors: 0, warnings: 0, info: 0, hints: 0, total: 0 };
  for (const entry of Array.isArray(value) ? value : []) {
    const file = object(entry);
    for (const diagnostic of Array.isArray(file.diagnostics) ? file.diagnostics : []) {
      const d = object(diagnostic);
      counts.total++;
      if (d.severity === 1) counts.errors++;
      else if (d.severity === 2) counts.warnings++;
      else if (d.severity === 3) counts.info++;
      else if (d.severity === 4) counts.hints++;
    }
  }
  return counts;
}

function diagnosticFiles(value: Json): Json {
  if (!Array.isArray(value)) throw new Error('Invalid diagnostics response');
  return value.map(entry => {
    const file = object(entry);
    return {
      ...file,
      diagnostics: (Array.isArray(file.diagnostics) ? file.diagnostics : []).map(entry => {
        const d = object(entry);
        const start = object(object(d.range ?? {}).start ?? {});
        return { ...d, line: typeof start.line === 'number' ? start.line + 1 : null };
      }),
    };
  });
}

const specs: Spec[] = [
  {
    name: 'paradoxcode_workspace',
    description: 'Orient in an EU4 Mod: indexed Mod/dependency/Vanilla roots, rule identity, revision, file counts and scan coverage. Call first. Missing Vanilla data or incomplete coverage limits what a clean diagnostic result proves.',
    parameters: {},
    async run(session, _args, signal) {
      return { ...object(await session.request('pdc/workspaceSummary', undefined, signal)), capabilities: session.connection.capabilities, synchronization: session.synchronization(), server: { ...session.server, info: session.connection.serverInfo },
        configuration: session.shared ? { settingsFile: session.shared.settings.path, dependenciesSource: session.shared.dependenciesSource, dependencies: session.shared.dependencies.map(row => ({ ...row })) } : null };
    },
  },
  {
    name: 'paradoxcode_dependencies',
    description: 'Inspect and manage the shared VS Code paradoxcode.dependencies list and its transitive chain. inspect needs no running server, returns a baseHash, load order and issues. add/set/remove/sync write only .vscode/settings.json; require that baseHash. sync expands the chain into the same explicit list used by VS Code. Preserve load priorities and review paths before changes.',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'add', 'remove', 'set', 'sync'], description: 'Default inspect; sync materializes the complete chain for both clients.' },
      dependencies: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: string('Stable dependency id', true), path: string('Absolute or workspace-relative Mod path', true), index: string('Optional persistent index path') } }, description: 'Required for add/set; low-to-high priority order. set [] clears dependencies.' },
      id: string('Dependency id to remove'),
      baseHash: string('Settings SHA-256 from a recent inspect; required for all save actions'),
    },
    manage: manageDependencies,
  },
  {
    name: 'paradoxcode_rules',
    description: 'Search embedded EU4 rules by context, key and/or allowed scope before writing triggers/effects. At least one filter is required. Returns accepted shapes, scope constraints and documentation; limit 1–50.',
    parameters: { context: string('Rule context such as trigger, effect or type:event'), key: string('Rule key substring'), scope: string('Allowed scope substring such as country or province'), limit: integer('1–50, default 20') },
    async run(session, args, signal) {
      const filters = Object.fromEntries(['context', 'key', 'scope'].flatMap(key => text(args, key) ? [[key, text(args, key)!]] : []));
      if (!Object.keys(filters).length) throw new Error('Supply at least one of context, key or scope');
      return session.request('pdc/ruleSearch', { ...filters, limit: number(args, 'limit', 20, 1, 50) }, signal);
    },
  },
  {
    name: 'paradoxcode_search',
    description: 'Find existing script definitions (events, missions, decisions, tags, scripted triggers/effects) across indexed roots. Query is a name substring of at least two characters. For localisation use paradoxcode_localisation.',
    parameters: { query: string('Symbol name substring, at least two characters', true), limit: integer('1–100, default 20') },
    async run(session, args, signal) {
      const query = text(args, 'query', true)!;
      if ([...query].length < 2) throw new Error('query must contain at least two characters');
      return session.request('pdc/symbolSearch', { query, limit: number(args, 'limit', 20, 1, 100) }, signal);
    },
  },
  {
    name: 'paradoxcode_symbol_references',
    description: 'Find a script definition and its uses by exact name before editing, removing or renaming it. Supply kind to disambiguate. Preserve matched/reason/candidates, total and truncation when assessing impact.',
    parameters: { name: string('Exact event id, scripted effect name, tag, etc.', true), kind: string('Optional symbol kind, such as event or scripted_effect'), limit: integer('1–100, default 50') },
    async run(session, args, signal) {
      return session.request('pdc/symbolReferences', { name: text(args, 'name', true)!, ...(text(args, 'kind') ? { kind: text(args, 'kind')! } : {}), limit: number(args, 'limit', 50, 1, 100) }, signal);
    },
  },
  {
    name: 'paradoxcode_localisation',
    description: 'Search indexed localisation by exact key, key prefix/substring, or displayed text. Use exact for known event titles and prefix for a key family. Returns winning definitions, language and values; previews may be bounded by the server.',
    parameters: { key: string('Localisation key or prefix'), keyMatch: { type: 'string', enum: ['exact', 'prefix', 'substring'], description: 'Default exact' }, text: string('Displayed-value substring'), limit: integer('1–50, default 20') },
    async run(session, args, signal) {
      const key = text(args, 'key');
      const value = text(args, 'text');
      if (!key && !value?.trim()) throw new Error('Supply key or non-empty text');
      return session.request('pdc/localisationSearch', { ...(key ? { key } : {}), ...(value ? { text: value } : {}), keyMatch: text(args, 'keyMatch') ?? 'exact', limit: number(args, 'limit', 20, 1, 50) }, signal);
    },
  },
  {
    name: 'paradoxcode_diagnostics',
    description: 'Validate indexed project files on disk after edits. Includes script and localisation by default, excludes dependency/Vanilla diagnostics. Page using nextOffset until complete; counts describe the returned page only. Diagnostic ranges are LSP 0-based with convenience line 1-based.',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, description: 'Optional non-empty list of Mod-relative paths; omit for the whole Mod' },
      parser: { type: 'string', enum: ['script', 'localisation'], description: 'Optional zone filter; omit for both' },
      offset: integer('Zero-based file offset, default 0'), limit: integer('Files per page, 1–128, default 16'),
    },
    async run(session, args, signal) {
      let files: string[] | undefined;
      if (args.files !== undefined) {
        if (!Array.isArray(args.files) || !args.files.length || args.files.length > 4096) throw new Error('files must contain 1–4096 logical paths');
        files = args.files.map(path => {
          if (typeof path !== 'string') throw new Error('files must contain strings');
          return logicalPath(path);
        });
      }
      const result = object(await session.request('pdc/workspaceDiagnostics', {
        ...(files ? { files } : {}), ...(text(args, 'parser') ? { parser: text(args, 'parser')! } : {}),
        offset: number(args, 'offset', 0, 0, 10000000), limit: number(args, 'limit', 16, 1, 128),
      }, signal));
      return { ...result, items: diagnosticFiles(result.items ?? []), pageCounts: countDiagnostics(result.items ?? []) };
    },
  },
  {
    name: 'paradoxcode_validate_text',
    description: 'Validate 1–16 draft script/localisation files without writing or changing the workspace. Each file is checked independently against the indexed workspace, so new definitions in another draft are not jointly visible. After writing related files, run disk diagnostics. Maximum total text is 16 MiB.',
    parameters: { files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: string('Mod-relative logical path, e.g. events/test.txt', true), text: string('Full draft contents', true) } } } },
    async run(session, args, signal) {
      if (!Array.isArray(args.files) || !args.files.length || args.files.length > 16) throw new Error('Pass 1–16 draft files');
      let bytes = 0;
      const paths = new Set<string>();
      const files = args.files.map(entry => {
        const file = object(entry, 'draft file');
        const path = logicalPath(text(file, 'path', true)!);
        if (paths.has(path)) throw new Error(`Duplicate draft path: ${path}`);
        paths.add(path);
        const content = text(file, 'text', true)!;
        bytes += Buffer.byteLength(content, 'utf8');
        return { path, text: content };
      });
      if (bytes > 16 * 1024 * 1024) throw new Error('Draft text exceeds the 16 MiB total limit');
      const result = await session.request('pdc/textDiagnostics', { files }, signal);
      return { files: diagnosticFiles(result), counts: countDiagnostics(result), basis: 'Each draft checked independently against the indexed workspace; files were not written' };
    },
  },
  {
    name: 'paradoxcode_document',
    description: 'Inspect an EU4 document: hover explains rules/scopes, completion suggests valid keys/values, definition/references find locations, symbols lists document structure. Optional text analyzes a temporary draft at a Mod-relative path. Input line is 1-based and character is 0-based UTF-16; returned LSP positions are 0-based.',
    parameters: { ...cursor, action: { type: 'string', enum: ['hover', 'completion', 'definition', 'references', 'symbols'], required: true }, text: string('Optional full draft text; never written'), limit: integer('Completion/reference result limit 1–100, default 50') },
    async run(session, args, signal) {
      const action = text(args, 'action', true)!;
      const methods: Record<string, string> = { hover: 'textDocument/hover', completion: 'textDocument/completion', definition: 'textDocument/definition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol' };
      return session.withDocument(text(args, 'path', true)!, text(args, 'text'), signal, async (uri, content) => {
        const params: JsonObject = { textDocument: { uri }, ...(action !== 'symbols' ? { position: position(args, content) } : {}), ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) };
        const result = await session.request(methods[action]!, params, signal);
        const limit = number(args, 'limit', 50, 1, 100);
        if (action === 'completion') {
          const items = Array.isArray(result) ? result : (result && object(result).items);
          if (!Array.isArray(items)) return result;
          return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit, isIncomplete: !Array.isArray(result) && result !== null ? object(result).isIncomplete ?? false : false };
        }
        if (action === 'references' && Array.isArray(result)) return { locations: result.slice(0, limit), total: result.length, truncated: result.length > limit };
        return result;
      });
    },
  },
  {
    name: 'paradoxcode_rename_preview',
    description: 'Prepare a conflict-aware symbol rename and return the proposed LSP WorkspaceEdit without applying it. Includes file hashes and Mod/dependency writability for review. Verify hashes before applying edits with DSH file tools, then refresh and diagnose. Refusals/conflicts are propagated as errors.',
    parameters: { ...cursor, newName: string('New symbol name', true) },
    async run(session, args, signal) {
      return session.withDocument(text(args, 'path', true)!, undefined, signal, async (uri, content) => {
        const params = { textDocument: { uri }, position: position(args, content) };
        const prepared = await session.request('textDocument/prepareRename', params, signal);
        if (prepared === null) throw new Error('This symbol cannot be renamed');
        const edit = await session.request('textDocument/rename', { ...params, newName: text(args, 'newName', true)! }, signal);
        return { applied: false, prepared, edit, files: await editFiles(edit, session.root) };
      });
    },
  },
  {
    name: 'paradoxcode_format_preview',
    description: 'Return conservative ParadoxCode formatting edits and formatted text for a disk file or temporary draft. Never writes files. Verify baseHash before applying a disk preview. LSP edit ranges remain 0-based.',
    parameters: { path: string('Indexed file or Mod-relative draft path', true), text: string('Optional full draft contents'), tabSize: integer('Indent width, 1–8, default 4'), insertSpaces: { type: 'boolean', description: 'Default false (tabs)' } },
    async run(session, args, signal) {
      return session.withDocument(text(args, 'path', true)!, text(args, 'text'), signal, async (uri, content) => {
        const edits = await session.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: number(args, 'tabSize', 4, 1, 8), insertSpaces: args.insertSpaces ?? false } }, signal);
        return { applied: false, uri, baseHash: hash(content), edits, text: applyTextEdits(content, edits) };
      });
    },
  },
  {
    name: 'paradoxcode_mission_preview',
    description: 'Analyze mission tree geometry, prerequisite edges and layout issues from draft mission text. Returns semantic preview data for agent review; textures/UI rendering remain editor features. Never writes files.',
    parameters: { path: string('Mod-relative mission path, e.g. missions/my_tree.txt', true), text: string('Complete mission file contents', true) },
    async run(session, args, signal) {
      const content = text(args, 'text', true)!;
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Mission text exceeds 4 MiB');
      return session.request('pdc/missionPreview', { path: logicalPath(text(args, 'path', true)!), text: content }, signal);
    },
  },
  {
    name: 'paradoxcode_transcode_preview',
    description: 'Preview EU4 Chinese localisation/script encoding or decoding using ParadoxCode profiles. Never writes bytes. Decode accepts bytesHex or a Mod-relative disk file; encode requires readable text. Returns encoded bytes as hex and preserves refusal/damage metadata. Check eligible/refused/broken/damagedAt before applying any conversion.',
    parameters: { path: string('Mod-relative target path deciding the encoding profile', true), action: { type: 'string', enum: ['decode', 'encode'], required: true }, text: string('Readable UTF-8 text to encode'), bytesHex: string('Optional even-length hexadecimal source bytes to decode'), quotedOnly: { type: 'boolean', description: 'Decode only quoted escape triples; default false' }, preserveEscaped: { type: 'boolean', description: 'Preserve existing quoted escapes while encoding; default false' } },
    async run(session, args, signal) {
      const path = resolve(session.root, logicalPath(text(args, 'path', true)!));
      const action = text(args, 'action', true)!;
      let bytes: Buffer;
      if (action === 'encode') {
        if (args.bytesHex !== undefined || args.quotedOnly !== undefined) throw new Error('encode accepts text and preserveEscaped, not bytesHex or quotedOnly');
        bytes = Buffer.from(text(args, 'text', true)!, 'utf8');
      } else {
        if (args.text !== undefined || args.preserveEscaped !== undefined) throw new Error('decode accepts bytesHex and quotedOnly, not text or preserveEscaped');
        const hex = text(args, 'bytesHex');
        if (hex !== undefined) {
          if (!/^(?:[a-f\d]{2})*$/i.test(hex) || hex.length > 32 * 1024 * 1024) throw new Error('bytesHex must be even-length hexadecimal of at most 16 MiB');
          bytes = Buffer.from(hex, 'hex');
        } else {
          const disk = await realpath(path);
          if (!within(session.root, disk)) throw new Error('Transcode disk file is outside the Mod root');
          const info = await stat(disk);
          if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Transcode source must be a file of at most 16 MiB');
          bytes = await readFile(disk);
        }
      }
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Transcode input exceeds 16 MiB');
      const result = object(await session.request(action === 'encode' ? 'pdc/transcodeEncode' : 'pdc/transcodeDecode', {
        path, bytes: bytes.toString('hex'), ...(action === 'encode' ? { preserveEscaped: args.preserveEscaped ?? false } : { quotedOnly: args.quotedOnly ?? false }),
      }, signal));
      if (action === 'decode' && typeof result.bytes === 'string') {
        try { result.text = new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(result.bytes, 'hex')); } catch { /* retain exact bytes and backend damage metadata */ }
      }
      return { ...result, applied: false };
    },
  },
  {
    name: 'paradoxcode_refresh',
    description: 'Rescan the Mod/dependency workspace after external edits or when file watching is unavailable. Waits for committed indexing before returning the new revision and scan result. Does not edit Mod files.',
    parameters: {},
    async run(session, _args, signal) { return await session.refresh(signal, true) ?? null; },
  },
];

export const toolNames = specs.map(spec => spec.name);

export function makeTools(config: Config, pool: WorkspacePool, getWorkspace: (args: JsonObject, exec: ToolRunContext) => string | Promise<string>): ToolDefinition[] {
  return specs.map(spec => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: { ...spec.parameters, workspace: string('Optional Mod root directory; defaults to plugin config or the calling DSH session cwd') },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string', required: true }, result: { type: 'json', required: true } } },
      render(_args, value) {
        const output = JSON.stringify(value, null, 2);
        return [{ type: 'text', text: output.length <= config.maxOutputChars ? output : `Native display truncated (${output.length} characters, budget ${config.maxOutputChars}). Narrow filters/page results, or use PTC to inspect the complete canonical JSON. This prefix is not the complete result:\n${output.slice(0, config.maxOutputChars)}` }];
      },
    },
    async execute(args, exec) {
      const input = args as JsonObject;
      // defineTool's implicit parameter object is open; reject typoed fields explicitly.
      for (const key of Object.keys(input)) {
        if (key !== 'workspace' && !Object.hasOwn(spec.parameters, key)) throw new Error(`Unknown parameter: ${key}`);
      }
      const workspace = await getWorkspace(input, exec);
      if (spec.manage) return pool.configure(workspace, exec.signal, async (base, active) => ({ workspace: base, result: await spec.manage!(base, config, input, active) }));
      return pool.run(workspace, exec.signal, async session => ({ workspace: session.root, result: await spec.run!(session, input, exec.signal) }));
    },
  }));
}

export function hash(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }

async function editFiles(value: Json, root: string): Promise<Json> {
  if (value === null) return [];
  const edit = object(value);
  const uris = new Set<string>(Object.keys(object(edit.changes ?? {})));
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      const doc = object(change);
      if ('kind' in doc) throw new Error('Rename returned unsupported file creation/removal operations');
      const uri = object(doc.textDocument ?? {}).uri;
      if (typeof uri === 'string') uris.add(uri);
    }
  }
  return Promise.all([...uris].map(async uri => {
    const path = await realpath(fileURLToPath(uri));
    return { uri, path, writable: within(root, path), sha256: hash(await readFile(path)) };
  }));
}

export function applyTextEdits(content: string, value: Json): string {
  if (value === null) return content;
  if (!Array.isArray(value)) throw new Error('Invalid formatting edits');
  const starts = [0];
  for (const match of content.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length);
  const offset = (pos: Json): number => {
    const p = object(pos);
    if (typeof p.line !== 'number' || typeof p.character !== 'number' || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0 || starts[p.line] === undefined) throw new Error('Invalid edit position');
    const start = starts[p.line]!;
    const lineEnd = (starts[p.line + 1] ?? content.length);
    const line = content.slice(start, lineEnd).replace(/(\r\n|\n|\r)$/, '');
    if (p.character > line.length) throw new Error('Edit column exceeds line length');
    return start + p.character;
  };
  const edits = value.map(value => {
    const edit = object(value);
    const range = object(edit.range ?? {});
    if (typeof edit.newText !== 'string') throw new Error('Invalid replacement text');
    return { start: offset(range.start!), end: offset(range.end!), text: edit.newText };
  }).sort((a, b) => b.start - a.start || b.end - a.end);
  let previous = content.length;
  for (const edit of edits) {
    if (edit.end < edit.start || edit.end > previous) throw new Error('Overlapping or reversed formatting edits');
    content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    previous = edit.start;
  }
  return content;
}
