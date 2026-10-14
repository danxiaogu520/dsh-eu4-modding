import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { inheritedDefaults, type Config } from './config.js';
import { object, type Json, type JsonObject } from './json.js';
import { logicalPath, within, type WorkspacePool, type WorkspaceSession } from './workspace.js';
import { manageDependencies } from './dependencies.js';
import { ResultStore, assertSnapshotInput, diagnosticPage, nativeSummary } from './results.js';

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

const diagnosticParameters: ParameterSchemaSpec = {
  severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'], description: 'Return only this severity; unfiltered counts remain available' },
  codes: { type: 'array', items: { type: 'string' }, description: 'Include these diagnostic codes' },
  excludeCodes: { type: 'array', items: { type: 'string' }, description: 'Exclude these diagnostic codes from this view' },
  startLine: integer('First 1-based source line, inclusive'), endLine: integer('Last 1-based source line, inclusive'),
  diagnosticOffset: integer('Diagnostic offset within this file page/batch, default 0'), diagnosticLimit: integer('Diagnostics per page, 1–500, default 50'),
  snapshot: string('Snapshot returned by the first page; required to continue diagnostics without reanalysis'),
  summaryOnly: { type: 'boolean', description: 'Return counts without diagnostic details' },
};

function diagnosticsSnapshot(session: WorkspaceSession, kind: string, args: JsonObject, raw?: Json): JsonObject {
  kind = `${kind}:${session.shared?.fingerprint ?? ''}`;
  const offset = number(args, 'diagnosticOffset', 0, 0, 10000000);
  const limit = number(args, 'diagnosticLimit', 50, 1, 500);
  const supplied = text(args, 'snapshot');
  if (offset && !supplied) throw new Error('Continue with snapshot and nextDiagnosticOffset from the first page');
  let token: string, input: JsonObject, value: Json;
  if (supplied) {
    const record = session.results.get(supplied, kind);
    assertSnapshotInput(record.input, args);
    token = supplied; input = record.input; value = record.value;
  } else {
    if (raw === undefined) throw new Error('A first diagnostic page requires files or a workspace query');
    value = raw; input = { ...args }; token = session.results.save(kind, value, input);
  }
  return { ...diagnosticPage(value, { ...input, ...args }, offset, limit), snapshot: token, countsScope: kind.startsWith('disk:') ? 'returned file page before diagnostic slicing' : 'joint draft batch' };
}

async function queryPage(session: WorkspaceSession, method: string, args: JsonObject, params: JsonObject, signal: AbortSignal): Promise<Json> {
  const offset = number(args, 'offset', 0, 0, 10000000);
  const revision = args.revision;
  const experimental = session.connection.capabilities.experimental;
  const supported = experimental && typeof experimental === 'object' && !Array.isArray(experimental) && experimental.pdcQueryPagination === true;
  if (offset && !supported) throw new Error('This server does not support legacy query pagination. Use paradoxcode_query with revision/snapshot, or install the supplied ParadoxCode patch.');
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new Error('revision must be a non-negative integer');
  if (offset && revision === undefined) throw new Error('Continuations require the revision returned by the first page');
  const result = object(await session.request(method, { ...params, ...(supported ? { offset, ...(revision !== undefined ? { revision } : {}) } : {}) }, signal));
  return { ...result, continuationSupported: !!supported, ...(!supported && result.truncated === true ? { continuation: 'Use paradoxcode_query to continue with the server search snapshot' } : {}) };
}

const queryParameters = { offset: integer('Result offset, default 0; continuations require a server advertising query pagination'), revision: integer('Revision returned by the first page; required when offset > 0') };

function readStoredResult(store: ResultStore, args: JsonObject, budget: number): Json {
  const token = text(args, 'token', true)!;
  const record = store.get(token);
  const offset = number(args, 'offset', 0, 0, record.text.length);
  const limit = number(args, 'limit', Math.max(128, budget - 512), 1, Math.max(128, budget - 512));
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(record.text[offset]!)) throw new Error('offset splits a Unicode surrogate pair; use nextOffset');
  let end = Math.min(record.text.length, offset + limit);
  if (end < record.text.length && /[\uD800-\uDBFF]/.test(record.text[end - 1]!)) end--;
  if (end === offset && end < record.text.length) throw new Error('limit is too small for the next Unicode character');
  return { token, offset, totalChars: record.text.length, nextOffset: end < record.text.length ? end : null, complete: end === record.text.length, chunk: record.text.slice(offset, end) };
}

const specs: Spec[] = [
  {
    name: 'paradoxcode_result',
    description: 'Read the complete canonical JSON of a previous oversized result in bounded text chunks. Use its retrieval token, then nextOffset until complete. No reanalysis. Tokens are workspace-local and expire after edits, refresh, eviction or restart. Offsets are UTF-16 character positions.',
    parameters: { token: string('Result retrieval token', true), offset: integer('Character offset, default 0'), limit: integer('Characters per chunk; bounded by the native display budget') },
    async run(session, args) { return readStoredResult(session.results, args, session.outputBudget); },
  },
  {
    name: 'paradoxcode_query',
    description: 'Paged ParadoxCode 0.5.2+ search for rules, definitions, localisation and text, including active/overridden versions. context returns root ids and available filters. Search continuations require offset, revision and snapshot. references uses a definition id/name/kind/revision from search. Preserve groups, matchCount and limitations; a bounded group is not exhaustive.',
    parameters: {
      action: { type: 'string', enum: ['context', 'search', 'references'], description: 'Default search' },
      tab: { type: 'string', enum: ['rules', 'definitions', 'localisation', 'text'], description: 'Search tab, required for search' },
      query: string('Non-empty search text'), context: string('Exact rule context'), scope: string('Exact allowed scope'), kind: string('Definition kind'), language: string('Localisation language'),
      roots: { type: 'array', items: { type: 'integer' }, description: 'Source root ids from context' },
      searchKeys: { type: 'boolean', description: 'Search localisation keys instead of values' }, caseSensitive: { type: 'boolean', description: 'Case-sensitive full-text search' },
      status: { type: 'string', enum: ['all', 'active', 'overridden'], description: 'Default all; filtering does not promote overridden definitions' },
      include: { type: 'array', items: { type: 'string' }, description: 'Included source globs' }, exclude: { type: 'array', items: { type: 'string' }, description: 'Excluded source globs' },
      offset: integer('Server group offset, default 0'), revision: integer('Workspace revision from the first page'), snapshot: string('Opaque server snapshot from the first page'),
      id: string('Definition identity for references'), name: string('Exact definition name for references'),
    },
    async run(session, args, signal) {
      const action = text(args, 'action') ?? 'search';
      if (action === 'context') return session.request('pdc/editorSearchContext', undefined, signal);
      const offset = number(args, 'offset', 0, 0, 10000000);
      if (offset && (args.revision === undefined || args.snapshot === undefined)) throw new Error('Continue using offset, revision and snapshot from the first page');
      if (args.revision !== undefined) number(args, 'revision', 0, 0, Number.MAX_SAFE_INTEGER);
      const params: JsonObject = { offset };
      const fields = action === 'references' ? ['id', 'name', 'kind', 'revision', 'snapshot', 'roots'] : ['tab', 'query', 'roots', 'language', 'searchKeys', 'kind', 'context', 'scope', 'caseSensitive', 'include', 'exclude', 'status', 'revision', 'snapshot'];
      for (const key of fields) if (args[key] !== undefined) params[key] = args[key]!;
      if (action === 'references') {
        for (const key of ['id', 'name', 'kind', 'revision']) if (params[key] === undefined) throw new Error(`${key} is required for references`);
      } else if (params.tab === undefined || typeof params.query !== 'string' || !params.query.trim()) throw new Error('search requires tab and a non-empty query');
      return session.request(action === 'references' ? 'pdc/editorSearchReferences' : 'pdc/editorSearch', params, signal);
    },
  },
  {
    name: 'paradoxcode_workspace',
    description: 'Orient in an EU4 Mod: indexed Mod/dependency/Vanilla roots, rule identity, revision, file counts and scan coverage. Call first. Missing Vanilla data or incomplete coverage limits what a clean diagnostic result proves.',
    parameters: {},
    async run(session, _args, signal) {
      const summary = object(await session.request('pdc/workspaceSummary', undefined, signal));
      const roots = (Array.isArray(summary.roots) ? summary.roots : []).map(entry => {
        const root = object(entry);
        const dependency = session.shared?.dependencies.find(dep => dep.path === root.path);
        return { ...root, sourceRootId: root.id ?? null, id: dependency?.id ?? (root.kind === 'vanilla' ? 'vanilla' : root.writable ? 'mod' : null) };
      });
      return { ...summary, roots, fileCountsScope: 'All indexed Mod, dependency and Vanilla roots', scanScope: 'Live source roots scanned during the last refresh; installed dependency/Vanilla index caches are excluded', capabilities: session.connection.capabilities, synchronization: session.synchronization(), server: { ...session.server, info: session.connection.serverInfo },
        configuration: session.shared ? { settingsFile: session.shared.settings.path, dependenciesSource: session.shared.dependenciesSource, dependencies: session.shared.dependencies.map(row => ({ ...row })), inheritedDefaults, inheritance: 'Omitted settings inherit VS Code; defaults apply only when neither client supplies a value', effective: session.shared.options } : null };
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
    parameters: { ...queryParameters, context: string('Rule context such as trigger, effect or event_body'), key: string('Rule key substring'), scope: string('Allowed scope substring such as country or province'), limit: integer('1–50, default 20') },
    async run(session, args, signal) {
      const filters = Object.fromEntries(['context', 'key', 'scope'].flatMap(key => text(args, key) ? [[key, text(args, key)!]] : []));
      if (!Object.keys(filters).length) throw new Error('Supply at least one of context, key or scope');
      return queryPage(session, 'pdc/ruleSearch', args, { ...filters, limit: number(args, 'limit', 20, 1, 50) }, signal);
    },
  },
  {
    name: 'paradoxcode_search',
    description: 'Find existing script definitions (events, missions, decisions, tags, scripted triggers/effects) across indexed roots. Query is a name substring of at least two characters. For localisation use paradoxcode_localisation.',
    parameters: { ...queryParameters, query: string('Symbol name substring, at least two characters', true), limit: integer('1–100, default 20') },
    async run(session, args, signal) {
      const query = text(args, 'query', true)!;
      if ([...query].length < 2) throw new Error('query must contain at least two characters');
      return queryPage(session, 'pdc/symbolSearch', args, { query, limit: number(args, 'limit', 20, 1, 100) }, signal);
    },
  },
  {
    name: 'paradoxcode_symbol_references',
    description: 'Find a script definition and its uses by exact name before editing, removing or renaming it. Supply kind to disambiguate. Preserve matched/reason/candidates, total and truncation when assessing impact.',
    parameters: { ...queryParameters, name: string('Exact event id, scripted effect name, tag, etc.', true), kind: string('Optional symbol kind, such as event or scripted_effect'), limit: integer('1–100, default 50') },
    async run(session, args, signal) {
      return queryPage(session, 'pdc/symbolReferences', args, { name: text(args, 'name', true)!, ...(text(args, 'kind') ? { kind: text(args, 'kind')! } : {}), limit: number(args, 'limit', 50, 1, 100) }, signal);
    },
  },
  {
    name: 'paradoxcode_localisation',
    description: 'Search indexed localisation by exact key, key prefix/substring, or displayed text. Use exact for known event titles and prefix for a key family. Returns winning definitions, language and values; previews may be bounded by the server.',
    parameters: { ...queryParameters, key: string('Localisation key or prefix'), keyMatch: { type: 'string', enum: ['exact', 'prefix', 'substring'], description: 'Default exact' }, text: string('Displayed-value substring'), limit: integer('1–50, default 20') },
    async run(session, args, signal) {
      const key = text(args, 'key');
      const value = text(args, 'text');
      if (!key && !value?.trim()) throw new Error('Supply key or non-empty text');
      return queryPage(session, 'pdc/localisationSearch', args, { ...(key ? { key } : {}), ...(value ? { text: value } : {}), keyMatch: text(args, 'keyMatch') ?? 'exact', limit: number(args, 'limit', 20, 1, 50) }, signal);
    },
  },
  {
    name: 'paradoxcode_diagnostics',
    description: 'Validate changed Mod files on disk; select files first. Filter by severity/code/line. File pages use nextOffset; diagnostics inside each file page use snapshot and nextDiagnosticOffset. Per-file counts distinguish clean files from omitted details. Ranges are LSP 0-based, line is 1-based.',
    parameters: {
      ...diagnosticParameters,
      files: { type: 'array', items: { type: 'string' }, description: 'Optional non-empty list of Mod-relative paths; omit for the whole Mod' },
      parser: { type: 'string', enum: ['script', 'localisation'], description: 'Optional zone filter; omit for both' },
      offset: integer('Zero-based file offset, default 0'), limit: integer('Files per page, 1–128, default 16'),
    },
    async run(session, args, signal) {
      if (args.snapshot !== undefined) return diagnosticsSnapshot(session, 'disk', args);
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
      return diagnosticsSnapshot(session, 'disk', args, result);
    },
  },
  {
    name: 'paradoxcode_validate_text',
    description: 'Jointly validate 1–16 draft script/localisation files against one temporary overlay batch. New cross-file definitions are visible; originals are restored before returning. Never writes files. At most 4 MiB per file and 16 MiB total. Includes per-file counts, filters and diagnostic pagination.',
    parameters: { ...diagnosticParameters, files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: string('Mod-relative logical path, e.g. events/test.txt', true), text: string('Full draft contents', true) } } } },
    async run(session, args, signal) {
      if (args.snapshot !== undefined) {
        const page = diagnosticsSnapshot(session, 'draft', args);
        const { items, ...summary } = page;
        return { ...summary, files: items!, basis: 'Joint draft overlay batch; original workspace restored; files were not written' };
      }
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
      const result = await session.withDrafts(files, signal, () => session.request('pdc/textDiagnostics', { files }, signal));
      const page = diagnosticsSnapshot(session, 'draft', args, result);
      const { items, ...summary } = page;
      return { ...summary, files: items!, basis: 'Joint draft overlay batch; original workspace restored; files were not written' };
    },
  },
  {
    name: 'paradoxcode_document',
    description: 'Inspect an EU4 document: hover explains rules/scopes, completion suggests valid keys/values, definition/references find locations, symbols lists document structure. Optional text analyzes a temporary draft at a Mod-relative path. Input line is 1-based and character is 0-based UTF-16; returned LSP positions are 0-based.',
    parameters: { ...cursor, action: { type: 'string', enum: ['hover', 'completion', 'definition', 'references', 'symbols'], required: true }, text: string('Optional full draft text; never written'), limit: integer('Completion/reference result limit 1–100, default 50'), offset: integer('Completion/reference offset, default 0'), snapshot: string('Snapshot from the first completion/reference page') },
    async run(session, args, signal) {
      const action = text(args, 'action', true)!;
      const limit = number(args, 'limit', 50, 1, 100), offset = number(args, 'offset', 0, 0, 10000000);
      const supplied = text(args, 'snapshot');
      const page = (result: Json, token: string): Json => {
        const items = action === 'references' ? result : Array.isArray(result) ? result : result && object(result).items;
        if (!Array.isArray(items)) return result;
        if (offset > items.length) throw new Error('offset exceeds the result count');
        return { [action === 'references' ? 'locations' : 'items']: items.slice(offset, offset + limit), total: items.length,
          snapshot: token, nextOffset: offset + limit < items.length ? offset + limit : null, truncated: offset + limit < items.length,
          ...(action === 'completion' ? { isIncomplete: !Array.isArray(result) && result !== null ? object(result).isIncomplete ?? false : false } : {}) };
      };
      if (supplied) {
        if (!['completion', 'references'].includes(action)) throw new Error('snapshot is only supported for completion/references');
        const record = session.results.get(supplied, `document:${session.shared?.fingerprint ?? ''}`);
        assertSnapshotInput(record.input, args, ['offset', 'limit']);
        return page(record.value, supplied);
      }
      if (offset) throw new Error('Continue with snapshot and nextOffset from the first page');
      const methods: Record<string, string> = { hover: 'textDocument/hover', completion: 'textDocument/completion', definition: 'textDocument/definition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol' };
      return session.withDocument(text(args, 'path', true)!, text(args, 'text'), signal, async (uri, content) => {
        const params: JsonObject = { textDocument: { uri }, ...(action !== 'symbols' ? { position: position(args, content) } : {}), ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) };
        const result = await session.request(methods[action]!, params, signal);
        if (action === 'completion' || action === 'references') return page(result, session.results.save(`document:${session.shared?.fingerprint ?? ''}`, result, args));
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
      schema: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string', required: true }, result: { type: 'json', required: true }, retrieval: { type: 'json' } } },
      render(_args, value) {
        const wrapped = value as JsonObject;
        if (spec.name === 'paradoxcode_result') {
          const result = object(wrapped.result!);
          const { chunk, ...header } = result;
          return [{ type: 'text', text: `${JSON.stringify(header)}\n${String(chunk)}` }];
        }
        const output = JSON.stringify(value);
        return [{ type: 'text', text: output.length <= config.maxOutputChars ? output : nativeSummary(wrapped, config.maxOutputChars) }];
      },
    },
    async execute(args, exec) {
      const input = args as JsonObject;
      // defineTool's implicit parameter object is open; reject typoed fields explicitly.
      for (const key of Object.keys(input)) {
        if (key !== 'workspace' && !Object.hasOwn(spec.parameters, key)) throw new Error(`Unknown parameter: ${key}`);
      }
      const workspace = await getWorkspace(input, exec);
      if (spec.name === 'paradoxcode_result') return pool.configure(workspace, exec.signal, async base => ({ workspace: base, result: readStoredResult(pool.resultsFor(base), input, config.maxOutputChars) }));
      if (spec.manage) return pool.configure(workspace, exec.signal, async (base, active) => {
        const value: { workspace: string; result: Json; retrieval?: Json } = { workspace: base, result: await spec.manage!(base, config, input, active) };
        if (JSON.stringify(value).length > config.maxOutputChars) value.retrieval = { tool: 'paradoxcode_result', token: pool.resultsFor(base).save('output', value), offset: 0 };
        return value;
      });
      return pool.run(workspace, exec.signal, async session => {
        const value: { workspace: string; result: Json; retrieval?: Json } = { workspace: session.root, result: await spec.run!(session, input, exec.signal) };
        if (spec.name !== 'paradoxcode_result' && JSON.stringify(value).length > config.maxOutputChars) {
          value.retrieval = { tool: 'paradoxcode_result', token: session.results.save('output', value), offset: 0 };
        }
        return value;
      });
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
