import { randomUUID } from 'node:crypto';
import { object, type Json, type JsonObject } from './json.js';

interface StoredResult { kind: string; value: Json; input: JsonObject; text: string; epoch: number; bytes: number }

/** Immutable, bounded result snapshots. Tokens are local to one workspace session. */
export class ResultStore {
  private entries = new Map<string, StoredResult>();
  private bytes = 0;
  private epoch = 0;
  invalidate(): void { this.epoch++; this.entries.clear(); this.bytes = 0; }
  save(kind: string, value: Json, input: JsonObject = {}): string {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(input));
    if (bytes > 64 * 1024 * 1024) throw new Error('Result exceeds the 64 MiB snapshot limit; narrow the query');
    while (this.entries.size >= 12 || this.bytes + bytes > 64 * 1024 * 1024) {
      const first = this.entries.entries().next().value!;
      this.entries.delete(first[0]); this.bytes -= first[1].bytes;
    }
    const token = randomUUID();
    this.entries.set(token, { kind, value, input, text, epoch: this.epoch, bytes }); this.bytes += bytes;
    return token;
  }
  get(token: string, kind?: string): StoredResult {
    const record = this.entries.get(token);
    if (!record || record.epoch !== this.epoch) throw new Error('Result snapshot expired or the workspace changed. Restart the query.');
    if (kind && record.kind !== kind) throw new Error('Snapshot belongs to another tool');
    this.entries.delete(token); this.entries.set(token, record);
    return record;
  }
}

export function counts(diagnostics: Json[]): JsonObject {
  const result = { errors: 0, warnings: 0, info: 0, hints: 0, total: diagnostics.length };
  for (const entry of diagnostics) {
    const severity = object(entry).severity;
    if (severity === 1) result.errors++; else if (severity === 2) result.warnings++;
    else if (severity === 3) result.info++; else if (severity === 4) result.hints++;
  }
  return result;
}

function codeList(value: Json | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()) || value.length > 256) throw new Error(`${name} must contain at most 256 non-empty diagnostic codes`);
  return (value as string[]).map(code => code.trim());
}

export function diagnosticPage(raw: Json, args: JsonObject, offset: number, limit: number): JsonObject {
  const files = Array.isArray(raw) ? raw : object(raw).items;
  if (!Array.isArray(files)) throw new Error('Invalid diagnostics response');
  const include = codeList(args.codes, 'codes'), exclude = codeList(args.excludeCodes, 'excludeCodes');
  const severities: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };
  const severity = args.severity === undefined ? undefined : severities[String(args.severity)];
  if (args.severity !== undefined && !severity) throw new Error('severity must be error, warning, info or hint');
  for (const key of ['startLine', 'endLine']) if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || Number(args[key]) < 1)) throw new Error(`${key} must be a positive 1-based line`);
  if (Number(args.startLine ?? 1) > Number(args.endLine ?? Number.MAX_SAFE_INTEGER)) throw new Error('startLine must not exceed endLine');
  let matched = 0;
  const all: Json[] = [], filtered: Json[] = [], returned: Json[] = [];
  const items = files.map(entry => {
    const file = object(entry);
    if (!Array.isArray(file.diagnostics)) throw new Error('Diagnostics response is missing a file diagnostics array');
    const diagnostics: JsonObject[] = file.diagnostics.map(entry => {
      const d = object(entry), start = object(object(d.range ?? {}).start ?? {});
      return { ...d, line: typeof start.line === 'number' ? start.line + 1 : null };
    });
    const matching = diagnostics.filter(d => {
      if (severity && d.severity !== severity) return false;
      if (include && !include.includes(String(d.code))) return false;
      if (exclude?.includes(String(d.code))) return false;
      const range = object(d.range ?? {}), end = object(range.end ?? {}), start = object(range.start ?? {});
      const endLine = typeof end.line === 'number' ? end.line + 1 - (end.character === 0 && typeof start.line === 'number' && end.line > start.line ? 1 : 0) : d.line;
      return (args.startLine === undefined || typeof endLine === 'number' && endLine >= Number(args.startLine))
        && (args.endLine === undefined || typeof d.line === 'number' && d.line <= Number(args.endLine));
    });
    const selected = matching.filter(() => { const index = matched++; return args.summaryOnly !== true && index >= offset && index < offset + limit; });
    for (const d of diagnostics) all.push(d);
    for (const d of matching) filtered.push(d);
    for (const d of selected) returned.push(d);
    return { ...file, counts: counts(diagnostics), filteredCounts: counts(matching), returnedCounts: counts(selected), diagnosticsComplete: selected.length === matching.length, diagnostics: selected };
  });
  if (offset > matched) throw new Error('diagnosticOffset exceeds the matching diagnostic count');
  return { ...(Array.isArray(raw) ? {} : object(raw)), items, counts: counts(all), filteredCounts: counts(filtered), pageCounts: counts(returned), diagnosticOffset: offset,
    nextDiagnosticOffset: args.summaryOnly === true || offset + returned.length >= matched ? null : offset + returned.length,
    diagnosticsComplete: args.summaryOnly !== true && offset === 0 && returned.length === matched };
}

export function assertSnapshotInput(input: JsonObject, args: JsonObject, additionalIgnored: string[] = []): void {
  for (const key of Object.keys(args)) {
    if (['snapshot', 'workspace', 'diagnosticOffset', 'diagnosticLimit', 'summaryOnly', ...additionalIgnored].includes(key)) continue;
    if (JSON.stringify(args[key]) !== JSON.stringify(input[key])) throw new Error(`Snapshot query changed (${key}); restart without snapshot`);
  }
}

/** Front-load small summaries and always keep an explicit route to the complete JSON. */
export function nativeSummary(value: JsonObject, budget: number): string {
  const result = value.result !== null && !Array.isArray(value.result) && typeof value.result === 'object' ? object(value.result) : {};
  const summary: JsonObject = { workspace: value.workspace!, displayTruncated: true, notice: 'Native display truncated; the complete canonical JSON is retained.', retrieval: value.retrieval ?? null };
  const data: JsonObject = {};
  for (const key of ['counts', 'countsScope', 'filteredCounts', 'pageCounts', 'total', 'revision', 'snapshot', 'nextOffset', 'nextDiagnosticOffset', 'matched', 'reason', 'truncated', 'diagnosticsComplete', 'limitations']) {
    if (result[key] !== undefined) data[key] = result[key]!;
  }
  summary.result = data;
  const files = result.items ?? result.files;
  if (result.counts !== undefined && Array.isArray(files)) data.files = files.map(entry => {
    const file = object(entry);
    return { path: file.path ?? null, counts: file.counts ?? null, filteredCounts: file.filteredCounts ?? null, returnedCounts: file.returnedCounts ?? null, diagnosticsComplete: file.diagnosticsComplete ?? false };
  });
  let rendered = JSON.stringify(summary);
  if (Array.isArray(data.files)) while (rendered.length > budget && data.files.length) {
    data.files.pop(); data.fileSummariesOmitted = Number(data.fileSummariesOmitted ?? 0) + 1;
    rendered = JSON.stringify(summary);
  }
  if (rendered.length > budget) { delete data.limitations; delete data.reason; rendered = JSON.stringify(summary); }
  if (rendered.length > budget) { summary.result = { summaryAvailableInCanonicalResult: true }; rendered = JSON.stringify(summary); }
  if (rendered.length > budget) { delete summary.workspace; rendered = JSON.stringify(summary); }
  if (rendered.length > budget) throw new Error('Native output budget cannot hold the result retrieval envelope');
  return rendered;
}
