#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const mode = basename(process.cwd());
if (mode.startsWith('pid-')) writeFileSync('server.pid', String(process.pid));
let buffer = Buffer.alloc(0);
let notifications = [];
let initializationOptions = {};
const openDocuments = new Map();
const hanging = new Set();
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  // Fragment every header and Unicode body to exercise stream framing.
  process.stdout.write(frame.subarray(0, 7));
  process.stdout.write(frame.subarray(7, frame.length - 2));
  process.stdout.write(frame.subarray(frame.length - 2));
}
const hex = value => Buffer.from(value).toString('hex');
// A fake legacy codec: `pdc-legacy-*` prefixes a byte pair that cannot appear in valid UTF-8, so the
// plugin must publish those bytes itself instead of going through the UTF-8-only DSH writer.
const LEGACY_PREFIX = 'b0a1';
const decodeInput = bytesHex => {
  const bytes = message => Buffer.from(message, 'hex');
  const stripped = mode.startsWith('pdc-legacy') && bytesHex.startsWith(LEGACY_PREFIX) ? bytes(bytesHex).subarray(2) : bytes(bytesHex);
  try { new TextDecoder('utf8', { fatal: true }).decode(stripped); return stripped; }
  catch { return Buffer.from('解码后的中文 key = value\n', 'utf8'); }
};
function handle(message) {
  if (message.method === 'exit') return process.exit(0);
  if (message.id === undefined) {
    notifications.push(message);
    if (message.method === 'textDocument/didOpen') openDocuments.set(message.params.textDocument.uri, message.params.textDocument.text);
    if (message.method === 'textDocument/didClose') openDocuments.delete(message.params.textDocument.uri);
    if (message.method === '$/cancelRequest' && mode === 'cooperative' && hanging.delete(message.params.id)) send({ jsonrpc: '2.0', id: message.params.id, error: { code: -32800, message: 'cancelled' } });
    if (message.method === 'initialized') send({ jsonrpc: '2.0', method: 'pdc/ready', params: {} });
    return;
  }
  if (message.method === 'initialize') {
    initializationOptions = message.params?.initializationOptions ?? {};
    if (mode === 'invalid-frame') return process.stdout.write('Content-Length: -1\r\n\r\n');
    if (mode === 'no-ready') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      return;
    }
    send({ jsonrpc: '2.0', id: 'client-request', method: 'window/workDoneProgress/create', params: { token: 1 } });
    const capabilities = { hoverProvider: true };
    // `pdc-old-*` stands in for a server older than the supported 0.5.3.
    if (!mode.startsWith('pdc-old')) {
      capabilities.experimental = { pdcQueryPagination: true, pdcHiddenEventOptions: true, pdcScanDetails: true, pdcWholeFileTranscode: true };
    }
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities, serverInfo: { name: 'pdc-fixture', version: '0.5.3' } } });
  } else if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'test/hang') {
    hanging.add(message.id);
    // Remain alive until timeout/cancellation.
  } else if (message.method === 'test/error') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32801, message: 'snapshot changed', data: { retry: true } } });
  } else if (message.method === 'pdc/workspaceSummary') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      revision: 1,
      roots: [{ id: 0, kind: 'project', path: process.cwd(), writable: true }],
      fileCounts: { script: 4, localisation: 1, total: 5 }, fileCountsScope: 'all indexed roots',
      scan: { scope: 'live roots; installed caches excluded', discoveredFiles: 5, indexedFiles: 5, excludedFiles: 0, excludedEntries: [], omittedExclusions: 0 },
      symbols: { definitions: { event: 3, mission: 1 }, references: { event: 12 } },
      initializationOptions,
    } });
  } else if (message.method === 'pdc/ruleSearch') {
    send({ jsonrpc: '2.0', id: message.id, result: { revision: 7, rules: [{ key: 'war', context: 'trigger' }], requestedOffset: message.params.offset ?? null, requestedRevision: message.params.revision ?? null, truncated: false } });
  } else if (message.method === 'pdc/localisationSearch') {
    const hits = [{ key: 'EDG_KTP_example', language: 'english', value: 'v'.repeat(500), file: 'localisation/replace/example_l_english.yml' }];
    const truncated = mode.startsWith('pdc-bounded');
    send({ jsonrpc: '2.0', id: message.id, result: { revision: 7, hits, truncated, ...(truncated ? { nextOffset: 5 } : {}) } });
  } else if (message.method === 'pdc/symbolSearch' && mode.startsWith('pdc-bounded')) {
    send({ jsonrpc: '2.0', id: message.id, result: { revision: 7, hits: [{ name: 'EDG_KTP_example', kind: 'event' }], requestedOffset: message.params.offset ?? null, requestedRevision: message.params.revision ?? null, truncated: true, nextOffset: 5 } });
  } else if (message.method === 'pdc/workspaceDiagnostics') {
    const items = (message.params.files ?? ['events/large.txt']).map(path => ({ path, diagnostics: path.includes('large') ? Array.from({ length: 300 }, (_, n) => ({ code: n % 2 ? 'InvalidValue' : 'UnknownKey', severity: n % 2 ? 2 : 1, message: `diagnostic ${n} ${'中文 😀'.repeat(25)}`, range: { start: { line: n, character: 0 }, end: { line: n, character: 1 } } })) : [] }));
    send({ jsonrpc: '2.0', id: message.id, result: { revision: 1, items, total: items.length, nextOffset: null } });
  } else if (message.method === 'pdc/textDiagnostics') {
    send({ jsonrpc: '2.0', id: message.id, result: message.params.files.map(file => ({ path: file.path, diagnostics: [], openCount: openDocuments.size })) });
  } else if (message.method === 'pdc/transcodeDecode') {
    if (mode.startsWith('pdc-damaged')) return send({ jsonrpc: '2.0', id: message.id, result: { eligible: true, profile: 'localisation', form: 'damaged', error: 'invalid-utf8', refused: 'invalidUtf8' } });
    if (mode.startsWith('pdc-refuse')) return send({ jsonrpc: '2.0', id: message.id, result: { eligible: true, profile: 'localisation', form: 'damaged', bytes: message.params.bytes, broken: 1, damagedAt: 3, offsets: [3], refused: 'brokenEscape' } });
    const decoded = decodeInput(message.params.bytes);
    send({ jsonrpc: '2.0', id: message.id, result: {
      eligible: true, profile: 'localisation',
      form: mode.startsWith('pdc-legacy') ? 'whole' : 'plain',
      bytes: hex(decoded), broken: 0, needsEncoding: false,
    } });
  } else if (message.method === 'pdc/transcodeEncode') {
    if (mode.startsWith('pdc-refuse')) return send({ jsonrpc: '2.0', id: message.id, result: { refused: 'unencodable', points: [{ codePoint: 128512, byteIndex: 0 }] } });
    const source = Buffer.from(message.params.bytes, 'hex');
    // Idempotent by construction: already-prefixed bytes are returned unchanged, like a faithful codec.
    const encoded = mode.startsWith('pdc-legacy') && !message.params.bytes.startsWith(LEGACY_PREFIX)
      ? Buffer.concat([Buffer.from(LEGACY_PREFIX, 'hex'), source])
      : source;
    send({ jsonrpc: '2.0', id: message.id, result: { bytes: encoded.toString('hex') } });
  } else if (message.method === 'test/overlays') {
    send({ jsonrpc: '2.0', id: message.id, result: { count: openDocuments.size } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, result: { method: message.method, params: message.params ?? null, notifications, value: '中文 😀' } });
    notifications = [];
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method) handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
