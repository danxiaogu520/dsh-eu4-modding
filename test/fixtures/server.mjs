#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const mode = basename(process.cwd());
if (mode.startsWith('pid-')) writeFileSync('server.pid', String(process.pid));
let buffer = Buffer.alloc(0);
let notifications = [];
let initializationOptions = {};
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  // Fragment every header and Unicode body to exercise stream framing.
  process.stdout.write(frame.subarray(0, 7));
  process.stdout.write(frame.subarray(7, frame.length - 2));
  process.stdout.write(frame.subarray(frame.length - 2));
}
function handle(message) {
  if (message.method === 'exit') return process.exit(0);
  if (message.id === undefined) {
    notifications.push(message);
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
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: 'pdc-fixture', version: '0.5.2' } } });
  } else if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'test/hang') {
    // Remain alive until timeout/cancellation.
  } else if (message.method === 'test/error') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32801, message: 'snapshot changed', data: { retry: true } } });
  } else if (message.method === 'pdc/workspaceSummary') {
    send({ jsonrpc: '2.0', id: message.id, result: { revision: 1, roots: [{ path: process.cwd(), writable: true }], initializationOptions } });
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
