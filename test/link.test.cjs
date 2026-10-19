'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate: immediate } = require('node:timers/promises');
const { Channel } = require('../src/channel.cjs');
const { Link } = require('../src/link.cjs');

const fixtureAuth = { token: 'fixture-token', owner: 'fixture-owner', bot: 'fixture-bot', base: 'https://ilinkai.weixin.qq.com' };
function fixture(t, text = '继续测试') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiby-link-run-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  const channel = new Channel({ directory, fetcher: async (_url, options) => {
    sent.push(JSON.parse(options.body).msg.item_list[0].text_item.text);
    return { ok: true, text: async () => '{"ret":0}' };
  } });
  channel.save('认证', fixtureAuth);
  channel.ingest({ msgs: [{ message_id: '1', from_user_id: fixtureAuth.owner, to_user_id: fixtureAuth.bot,
    message_type: 1, message_state: 2, context_token: 'fixture-context', item_list: [{ type: 1, text_item: { text } }] }] });
  const connection = new EventEmitter();
  connection.connected = true;
  connection.close = () => {};
  connection.runTurn = async (_id, _text, accepted) => { await accepted('turn-1'); return '仅公开的最终答案'; };
  const link = new Link({ channel, connection });
  link.selected = { id: 'thread-1', title: '测试会话' };
  return { channel, connection, link, sent, message: channel.inbox()[0] };
}

test('a successful Codex reply becomes handled and cannot run twice', async t => {
  const f = fixture(t); let calls = 0;
  const original = f.connection.runTurn;
  f.connection.runTurn = (...args) => { calls++; return original(...args); };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  assert.equal(f.channel.read('连接任务').status, 'complete');
  assert.deepEqual(f.sent, ['仅公开的最终答案']);
  assert.equal(f.link.error, null);
  await f.link.handle(f.message);
  assert.equal(calls, 1);
});

test('help uses the same claim-to-completion lifecycle without model work', async t => {
  const f = fixture(t, '帮助'); let calls = 0;
  f.connection.runTurn = async () => { calls++; throw new Error('must not run'); };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  assert.equal(calls, 0);
  assert.equal(f.sent.length, 1);
});

test('busy incoming text is acknowledged once and never submitted', async t => {
  const f = fixture(t); let calls = 0;
  f.link.busy = true;
  f.connection.runTurn = async () => { calls++; };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  assert.equal(calls, 0);
  assert.match(f.sent[0], /本条消息未提交/);
});

test('an unconfirmed model submission is persisted and is not automatically replayed', async t => {
  const f = fixture(t); let calls = 0;
  f.connection.runTurn = async () => { calls++; const error = new Error('mock-disconnect'); error.unknown = true; throw error; };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(f.channel.read('连接任务').status, 'unknown');
  await f.link.handle(f.message);
  assert.equal(calls, 1);
});

test('accepted work remains unknown if persisting its turn receipt fails', async t => {
  const f = fixture(t); const save = f.channel.save.bind(f.channel);
  f.channel.save = (name, value) => {
    if (name === '连接任务' && value.status === 'accepted') throw new Error('mock-disk-full');
    return save(name, value);
  };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(f.channel.read('连接任务').status, 'unknown');
});

test('stop cancels and joins the previous poll before a new run acquires its lock', async t => {
  const f = fixture(t); let activePolls = 0, maximumPolls = 0, calls = 0;
  f.channel.inbox = () => [];
  f.connection.connect = async () => { f.connection.connected = true; };
  f.connection.close = () => { f.connection.connected = false; };
  f.channel.poll = ({ signal }) => new Promise(resolve => {
    calls++; activePolls++; maximumPolls = Math.max(maximumPolls, activePolls);
    signal.addEventListener('abort', () => {
      setImmediate(() => { activePolls--; resolve({ cancelled: true }); });
    }, { once: true });
  });
  await f.link.start();
  const stopping = f.link.stop();
  const restarting = f.link.start();
  await Promise.all([stopping, restarting]);
  assert.equal(calls, 2);
  assert.equal(maximumPolls, 1);
  assert.equal(f.link.running, true);
  assert.equal(fs.existsSync(path.join(f.channel.directory, '连接器.lock')), true);
  await f.link.stop();
  assert.equal(f.link.loop, null);
  assert.equal(activePolls, 0);
  assert.equal(fs.existsSync(path.join(f.channel.directory, '连接器.lock')), false);
});

test('stop joins the active message handler and preserves its unknown receipt', async t => {
  const f = fixture(t); let polls = 0, rejectTurn;
  f.connection.connect = async () => { f.connection.connected = true; };
  f.connection.runTurn = async (_id, _text, accepted) => {
    await accepted('turn-1');
    return new Promise((_resolve, reject) => { rejectTurn = reject; });
  };
  f.connection.close = () => {
    f.connection.connected = false;
    if (rejectTurn) { const error = new Error('mock-disconnect'); error.unknown = true; rejectTurn(error); }
  };
  f.channel.poll = async ({ signal }) => {
    if (++polls === 1) return { received: 1 };
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
  };
  await f.link.start();
  await immediate();
  assert.equal(f.link.busy, true);
  await f.link.stop();
  assert.equal(f.link.busy, false);
  assert.equal(f.link.handlers.size, 0);
  assert.equal(f.channel.read('连接任务').status, 'unknown');
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(fs.existsSync(path.join(f.channel.directory, '连接器.lock')), false);
});
