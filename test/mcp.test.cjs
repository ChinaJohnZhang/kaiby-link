'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setImmediate: immediate } = require('node:timers/promises');
const { serve } = require('../bin/kaiby-link-mcp.cjs');

async function fixture(options = {}) {
  const input = new PassThrough(), output = new PassThrough(), messages = [], contexts = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk; let n;
    while ((n = buffer.indexOf('\n')) !== -1) { messages.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1); }
  });
  const fake = { running: false, stops: 0, async select() {}, async start() { this.running = true; }, async stop() { this.running = false; this.stops++; }, ...options.fake };
  const server = await serve({ input, output, channel: { auth() {} }, createConnection: value => { contexts.push(value); return {}; }, createLink: () => fake });
  const send = value => input.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const call = (id, args = { threadId: 'fixed-thread' }, metadata) => send({ id, method: 'tools/call', params: { name: 'start_kaiby_link', arguments: args, ...(metadata ? { _meta: metadata } : {}) } });
  const initialize = () => send({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  return { server, input, output, messages, contexts, fake, send, call, initialize };
}

test('the MCP catalog offers only the fixed UUID startup tool and requires initialize', async () => {
  const f = await fixture();
  f.call('early'); await immediate();
  assert.equal(f.messages[0].error.code, -32600); assert.equal(f.contexts.length, 0);
  f.initialize(); f.send({ id: 'catalog', method: 'tools/list' }); await immediate();
  const tools = f.messages.find(row => row.id === 'catalog').result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['start_kaiby_link']);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['threadId']);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  await f.server.close();
});

test('only executor _meta is the connection caller; mobile-style arguments cannot inject it', async () => {
  const f = await fixture(); f.initialize();
  f.call('injected', { threadId: 'fixed-thread', metadata: { 'openai/threadId': 'forged' } }); await immediate();
  assert.equal(f.messages.find(row => row.id === 'injected').result.isError, true); assert.equal(f.contexts.length, 0);
  const real = { 'x-codex-turn-metadata': { thread_id: 'actual-caller', turn_id: 'actual-turn' } };
  f.call('valid', { threadId: 'fixed-thread' }, real); await immediate();
  assert.deepEqual(f.contexts, [{ metadata: real }]); assert.equal(f.fake.running, true);
  await f.server.close();
});

test('a rejected concurrent startup never stops or releases the first generation', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ fake: { async select() { await gate; } } }); f.initialize(); f.call('first'); await immediate();
  f.call('second'); await immediate();
  assert.equal(f.messages.find(row => row.id === 'second').result.isError, true);
  assert.equal(f.fake.stops, 0);
  release(); await immediate();
  assert.equal(f.fake.running, true); assert.equal(f.messages.find(row => row.id === 'first').result.isError, undefined);
  f.call('third'); await immediate(); assert.equal(f.fake.stops, 0);
  await f.server.close(); assert.equal(f.fake.running, false);
});

test('shutdown waits for an in-flight select to unwind and never starts it afterward', async () => {
  let release, starts = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ fake: { async select() { await gate; }, async start() { starts++; this.running = true; } } });
  f.initialize(); f.call('first'); await immediate();
  let closed = false; const closing = f.server.close().then(() => { closed = true; });
  await immediate(); assert.equal(closed, false);
  release(); await closing;
  assert.equal(starts, 0); assert.equal(f.fake.running, false); assert.equal(f.messages.find(row => row.id === 'first').result.isError, true);
});

test('input end stops the owned connection and malformed JSON-RPC cannot start it', async () => {
  const f = await fixture(); f.initialize();
  f.input.write('null\n'); f.input.write('{bad\n'); await immediate();
  assert.ok(f.messages.some(row => row.error?.code === -32600)); assert.ok(f.messages.some(row => row.error?.code === -32700));
  assert.equal(f.contexts.length, 0);
  f.call('start'); await immediate(); f.input.end(); await immediate();
  await f.server.close(); assert.equal(f.fake.running, false); assert.ok(f.fake.stops >= 1);
});
