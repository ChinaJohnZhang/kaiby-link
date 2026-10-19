'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: immediate } = require('node:timers/promises');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { CodexConnection, safeEndpoint } = require('../src/codex.cjs');

function notification(c, method, params) { c.receive(JSON.stringify({ method, params })); }
function fakeConnection() {
  const c = new CodexConnection(); c.connected = true;
  c.request = async (method) => {
    if (method === 'thread/read') return { thread: { id: 'thread-1', status: { type: 'idle' } } };
    if (method === 'thread/resume') return { thread: { id: 'thread-1', status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    throw new Error('unexpected method');
  };
  return c;
}

test('plaintext external endpoints and credential-bearing URLs are refused', () => {
  assert.equal(safeEndpoint('ws://127.0.0.1:4500'), 'ws://127.0.0.1:4500/');
  assert.equal(safeEndpoint('wss://codex.example.test/control'), 'wss://codex.example.test/control');
  for (const input of ['ws://codex.example.test', 'ws://user:secret@localhost', 'ws://localhost/#secret',
    'ws://localhost/?token=secret', 'http://localhost', 'file:///tmp/server']) assert.throws(() => safeEndpoint(input));
});

test('only final answers for the accepted thread and turn are forwarded', async () => {
  const c = fakeConnection();
  const running = c.runTurn('thread-1', 'hello');
  await immediate();
  for (const [threadId, turnId, item] of [
    ['thread-1', 'turn-1', { id: 'reason', type: 'reasoning', text: 'private reasoning' }],
    ['thread-1', 'turn-1', { id: 'tool', type: 'commandExecution', text: 'private output' }],
    ['thread-1', 'turn-1', { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'private progress' }],
    ['thread-1', 'turn-1', { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: 'not final' }],
    ['thread-1', 'turn-other', { id: 'other-turn', type: 'agentMessage', phase: 'final_answer', text: 'other turn' }],
    ['thread-other', 'turn-1', { id: 'other-thread', type: 'agentMessage', phase: 'final_answer', text: 'other thread' }],
    ['thread-1', 'turn-1', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'public reply' }],
  ]) notification(c, 'item/completed', { threadId, turnId, item });
  notification(c, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(await running, 'public reply');
});

test('events arriving before turn/start acknowledgement retain their final answer', async () => {
  const c = fakeConnection(); const request = c.request;
  c.request = async method => {
    if (method !== 'turn/start') return request(method);
    notification(c, 'item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'early final' } });
    notification(c, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    return { turn: { id: 'turn-1' } };
  };
  assert.equal(await c.runTurn('thread-1', 'hello'), 'early final');
});

test('a second run is rejected while the first run is still doing preflight reads', async t => {
  const c = fakeConnection(); let release;
  const gate = new Promise(resolve => { release = resolve; }); const request = c.request;
  c.request = async method => { if (method === 'thread/read') await gate; return request(method); };
  const first = c.runTurn('thread-1', 'first'); first.catch(() => {});
  let secondOutcome = 'pending';
  const second = c.runTurn('thread-1', 'second').then(() => { secondOutcome = 'resolved'; }, () => { secondOutcome = 'rejected'; });
  t.after(async () => { release(); await immediate(); c.lost(); await second; });
  await immediate();
  assert.equal(secondOutcome, 'rejected');
});

test('disconnect makes an outstanding turn/start unknown and late acknowledgement is ignored', async () => {
  const c = new CodexConnection({ timeout: 1000 }); const written = [];
  c.transport = {}; c.write = value => written.push(value);
  const pending = c.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
  c.lost();
  await assert.rejects(pending, error => error.unknown === true);
  c.receive(JSON.stringify({ id: written[0].id, result: { turn: { id: 'late-turn' } } }));
  assert.equal(c.pending.size, 0);
});

test('failure to save an accepted receipt is an unknown submission, not a safe rejection', async () => {
  const c = fakeConnection();
  await assert.rejects(c.runTurn('thread-1', 'hello', () => { throw new Error('mock-disk-full'); }), error => error.unknown === true);
});

test('a turn that became active during resume is not submitted by the connector', async () => {
  const c = fakeConnection(); const request = c.request; let starts = 0;
  c.request = async method => {
    if (method === 'thread/resume') return { thread: { id: 'thread-1', status: { type: 'active' } } };
    if (method === 'turn/start') starts++;
    return request(method);
  };
  await assert.rejects(c.runTurn('thread-1', 'hello'), /正在运行/);
  assert.equal(starts, 0);
  assert.equal(c.turnReserved, false);
});

test('a synchronous transport write failure remains unknown instead of inviting a retry', async () => {
  const c = new CodexConnection({ timeout: 1000 });
  c.transport = {}; c.write = () => { throw new Error('mock-broken-pipe'); };
  await assert.rejects(c.request('turn/start', {}), error => error.unknown === true);
  assert.equal(c.pending.size, 0);
});

test('malformed protocol input closes cleanly and rejects an outstanding operation as unknown', async () => {
  const c = new CodexConnection({ timeout: 1000 }); let closed = false;
  c.transport = { terminate: () => { closed = true; } }; c.write = () => {};
  const operation = c.request('turn/start', {});
  c.receive('null');
  await assert.rejects(operation, error => error.unknown === true);
  assert.equal(closed, true);
  assert.equal(c.transport, null);
});

test('loopback mock transport completes a turn and reconnect ignores the old socket close', async t => {
  // This server is a protocol fixture only: no Codex process or model is run.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const c = new CodexConnection({ endpoint: `ws://127.0.0.1:${server.address().port}`, timeout: 1000 });
  t.after(async () => {
    c.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.id == null) return;
    const send = value => socket.send(JSON.stringify(value));
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'thread/read' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    } else if (message.method === 'turn/start') {
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'hidden', type: 'agentMessage', phase: 'commentary', text: 'progress' } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'mock final reply' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    }
  }));
  await c.connect();
  assert.equal(await c.runTurn('thread-1', 'fixture text'), 'mock final reply');
  c.close();
  await c.connect();
  assert.equal((await c.readThread('thread-1')).id, 'thread-1');
  assert.equal(c.connected, true);
});
