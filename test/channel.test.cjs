'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Channel, WeixinProbe, parseJsonSafe, apiOrigin, defaultDataDirectory } = require('../src/channel.cjs');
const { Link } = require('../src/link.cjs');

const response = data => ({ ok: true, text: async () => JSON.stringify(data) });
const auth = { token: 'test-token', owner: 'test-owner', bot: 'test-bot', base: 'https://ilinkai.weixin.qq.com' };
function setup(t, fetcher = async () => response({ ret: 0 })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiby-link-channel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const channel = new Channel({ directory, fetcher });
  channel.save('认证', auth);
  return channel;
}
const message = (id, extra = {}) => ({ message_id: id, from_user_id: auth.owner, to_user_id: auth.bot,
  message_type: 1, message_state: 2, context_token: 'test-context',
  item_list: [{ type: 1, text_item: { text: '测试消息' } }], ...extra });

test('platform data directories use the current user profile and keep the compatibility export', () => {
  assert.equal(WeixinProbe, Channel);
  assert.equal(defaultDataDirectory('darwin', {}, '/home/demo'), path.join('/home/demo', 'Library', 'Application Support', 'kaiby-link'));
  assert.equal(defaultDataDirectory('win32', { LOCALAPPDATA: '/profile/local' }, '/home/demo'), path.join('/profile/local', 'kaiby-link'));
  assert.equal(defaultDataDirectory('win32', {}, '/profile'), path.join('/profile', 'AppData', 'Local', 'kaiby-link'));
  assert.equal(defaultDataDirectory('linux', { XDG_DATA_HOME: '/profile/data' }, '/home/demo'), path.join('/profile/data', 'kaiby-link'));
});

test('uint64 IDs retain all digits and quoted message text remains untouched', () => {
  const text = '{"id":18446744073709551615,"negative":-9007199254740992,"text":"123 \\\"id\\\": 18446744073709551615","small":42,"decimal":1.25,"exp":1e3}';
  const parsed = parseJsonSafe(text);
  assert.equal(parsed.id, '18446744073709551615');
  assert.equal(parsed.negative, '-9007199254740992');
  assert.equal(parsed.text, JSON.parse(text).text);
  assert.equal(parsed.small, 42);
  assert.equal(parsed.decimal, 1.25);
  assert.equal(parsed.exp, 1000);
});

test('only HTTPS upstream origins are accepted; redirects cannot change path, port, or credentials', () => {
  assert.equal(apiOrigin(auth.base), auth.base);
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://localhost',
    'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443',
    'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com/?token=secret', 'https://ilinkai.weixin.qq.com/#hash']) {
    assert.throws(() => apiOrigin(value));
  }
});

test('state filenames cannot escape the data directory and private files have restricted POSIX modes', t => {
  const channel = setup(t);
  for (const name of ['../escape', '..\\escape', '', '.', '..']) assert.throws(() => channel.save(name, {}));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(channel.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(channel.directory, '认证.json')).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(channel.directory).filter(x => x.endsWith('.tmp')).length, 0);
});

test('only owner direct text messages are queued; duplicate, group, wrong bot, incomplete, and unsafe IDs are ignored', t => {
  const channel = setup(t);
  channel.ingest({ msgs: [message('1'), message('1'), message('2', { from_user_id: 'stranger' }),
    message('3', { group_id: 'group' }), message('4', { message_type: 2 }), message('5', { to_user_id: 'other-bot' }),
    message('6', { message_state: 1 }), message('7', { context_token: '' }), message(Number.MAX_SAFE_INTEGER + 1)], get_updates_buf: 'cursor-1' });
  assert.deepEqual(channel.inbox(), [{ id: '1', text: '测试消息' }]);
  assert.equal(channel.state().cursor, 'cursor-1');
});

test('a partial batch keeps its old cursor and resumes the remaining message without duplicating admitted IDs', t => {
  const channel = setup(t);
  channel.ingest({ msgs: [], get_updates_buf: 'before' });
  const batch = { msgs: Array.from({ length: 31 }, (_, i) => message(String(i + 1))), get_updates_buf: 'after' };
  assert.deepEqual(channel.ingest(batch), { received: 30, pending: 30, backpressure: true });
  assert.deepEqual(channel.inbox().map(row => row.id), Array.from({ length: 30 }, (_, i) => String(i + 1)));
  assert.equal(channel.state().cursor, 'before');
  assert.deepEqual(channel.ingest(batch), { received: 0, pending: 30, backpressure: true });
  assert.equal(channel.state().cursor, 'before');
  channel.markHandled('1');
  assert.deepEqual(channel.ingest(batch), { received: 1, pending: 30 });
  assert.equal(channel.state().cursor, 'after');
  assert.equal(channel.state().messages.length, 31);
  assert.deepEqual([...channel.state().messages.map(row => row.id)].sort((a, b) => Number(a) - Number(b)), Array.from({ length: 31 }, (_, i) => String(i + 1)));
  assert.equal(channel.state().messages.find(row => row.id === '1').status, 'handled');
  assert.equal(fs.existsSync(path.join(channel.directory, '收发.lock')), false);
});

test('unknown history remains unchanged and consumes no active queue capacity', t => {
  const channel = setup(t);
  channel.ingest({ msgs: Array.from({ length: 30 }, (_, i) => message('unknown-' + i)), get_updates_buf: 'before' });
  channel.update(state => { for (const row of state.messages) row.status = 'unknown'; state.seen = []; });
  const history = channel.state().messages;
  const batch = { msgs: [message('unknown-0'), ...Array.from({ length: 31 }, (_, i) => message('new-' + i))], get_updates_buf: 'after' };
  assert.deepEqual(channel.ingest(batch), { received: 30, pending: 30, backpressure: true });
  assert.equal(channel.state().cursor, 'before');
  assert.deepEqual(channel.state().messages.filter(row => row.status === 'unknown'), history);
  assert.equal(channel.state().messages.filter(row => row.id === 'unknown-0').length, 1);
  assert.equal(channel.inbox().length, 30);
});

test('queued and processing rows both reserve active queue capacity', t => {
  const channel = setup(t);
  channel.ingest({ msgs: Array.from({ length: 30 }, (_, i) => message(String(i + 1))), get_updates_buf: 'before' });
  channel.update(state => { state.messages.forEach((row, index) => { row.status = index % 2 ? 'queued' : 'processing'; }); });
  assert.deepEqual(channel.ingest({ msgs: [message('31')], get_updates_buf: 'after' }), { received: 0, pending: 0, backpressure: true });
  assert.equal(channel.state().cursor, 'before');
  assert.equal(channel.state().messages.length, 30);
});

test('backpressure preserves every seen ID until its cursor batch has been completely admitted', t => {
  const channel = setup(t);
  channel.update(state => { state.seen = Array.from({ length: 2000 }, (_, i) => 'prior-' + i); });
  const batch = { msgs: Array.from({ length: 31 }, (_, i) => message(String(i + 1))), get_updates_buf: 'after' };
  assert.equal(channel.ingest(batch).backpressure, true);
  assert.equal(channel.state().seen.length, 2030);
  channel.markHandled('1');
  assert.equal(channel.ingest(batch).received, 1);
  assert.equal(channel.state().seen.length, 2000);
  assert.equal(channel.state().cursor, 'after');
});

test('repeated backpressure polls keep the receive loop running without model work or cursor loss', async t => {
  let polls = 0, release;
  const fourthPoll = new Promise(resolve => { release = resolve; });
  const batch = { msgs: Array.from({ length: 31 }, (_, i) => message(String(i + 1))), get_updates_buf: 'after' };
  const channel = setup(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).get_updates_buf, 'before');
    if (++polls === 4) setImmediate(release);
    return response(batch);
  });
  channel.ingest({ msgs: [], get_updates_buf: 'before' });
  const connection = new EventEmitter();
  connection.connected = true; connection.connect = async () => {}; connection.close = () => {};
  connection.runTurn = async () => { throw new Error('No model work is allowed in this fixture'); };
  const link = new Link({ channel, connection });
  link.selected = { id: 'fixture-thread', title: 'Fixture chat' };
  // Leave the bounded queue full to exercise repeated polling under pressure.
  link.handle = async () => {};
  await link.start();
  try {
    await fourthPoll;
    assert.equal(polls, 4); assert.equal(link.running, true); assert.equal(link.error, null);
    assert.equal(channel.state().cursor, 'before');
    assert.equal(channel.state().messages.length, 30);
  } finally { await link.stop(); }
});

test('state lock refuses concurrent writers without changing state', t => {
  const channel = setup(t);
  channel.ingest({ msgs: [message('1')] });
  const lock = path.join(channel.directory, '收发.lock');
  fs.writeFileSync(lock, '', { mode: 0o600 });
  assert.throws(() => channel.markHandled('1'), /正在更新/);
  assert.equal(channel.inbox().length, 1);
  fs.unlinkSync(lock);
  channel.markHandled('1');
  assert.deepEqual(channel.inbox(), []);
  assert.equal(channel.state().messages[0].context, undefined);
});

test('a processing claim can complete, while sending or unknown status cannot be marked handled', t => {
  const channel = setup(t);
  channel.ingest({ msgs: [message('1'), message('2'), message('3')] });
  channel.update(state => {
    state.messages.find(x => x.id === '1').status = 'processing';
    state.messages.find(x => x.id === '2').status = 'sending';
    state.messages.find(x => x.id === '3').status = 'unknown';
  });
  channel.markHandled('1');
  const completed = channel.state().messages.find(x => x.id === '1');
  assert.equal(completed.status, 'handled');
  assert.equal(completed.text, undefined);
  assert.equal(completed.context, undefined);
  assert.throws(() => channel.markHandled('2'), /结果待核实/);
  assert.throws(() => channel.markHandled('3'), /结果待核实/);
});

test('network send commits intent first and completion cannot overwrite concurrent inbound messages', async t => {
  let channel;
  channel = setup(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.msg.to_user_id, auth.owner);
    assert.equal(body.msg.context_token, 'test-context');
    assert.equal(options.redirect, 'error');
    assert.equal(channel.state().messages.find(x => x.id === '1').status, 'sending');
    channel.ingest({ msgs: [message('2')], get_updates_buf: 'cursor-2' });
    return response({ ret: 0 });
  });
  channel.ingest({ msgs: [message('1')] });
  await channel.reply('1', '已完成');
  assert.deepEqual(channel.inbox().map(x => x.id), ['2']);
  assert.equal(channel.state().cursor, 'cursor-2');
  assert.equal(channel.state().messages.find(x => x.id === '1').text, undefined);
  await assert.rejects(channel.reply('1', '重复'), /拒绝重复/);
});

test('ambiguous replies cannot be replayed or marked handled', async t => {
  let calls = 0;
  const channel = setup(t, async () => { calls++; throw new Error('mock-timeout'); });
  channel.ingest({ msgs: [message('1')] });
  await assert.rejects(channel.reply('1', '测试'), /mock-timeout/);
  assert.equal(channel.state().messages[0].status, 'unknown');
  await assert.rejects(channel.reply('1', '再发'), /拒绝重复/);
  assert.throws(() => channel.markHandled('1'), /结果待核实/);
  assert.equal(calls, 1);
});

test('owner send keeps unknown idempotency receipts across process instances and safe special keys', async t => {
  let calls = 0;
  const channel = setup(t, async () => { calls++; throw new Error('mock-disconnect'); });
  channel.ingest({ msgs: [message('1')] });
  channel.markHandled('1');
  await assert.rejects(channel.sendOwner('回复', '__proto__'), /mock-disconnect/);
  assert.equal(channel.state().outbound.__proto__.status, 'unknown');
  const restarted = new Channel({ directory: channel.directory, fetcher: channel.fetcher });
  await assert.rejects(restarted.sendOwner('重复', '__proto__'), /拒绝重复/);
  assert.equal(calls, 1);
  assert.equal({}.status, undefined);
});

test('parallel receive requests are rejected and the polling lock is released after completion', async t => {
  let release;
  const channel = setup(t, async () => new Promise(resolve => { release = () => resolve(response({ msgs: [], get_updates_buf: 'after' })); }));
  const first = channel.poll();
  await assert.rejects(channel.poll(), /已有移动通道接收进程/);
  release();
  await first;
  assert.equal(channel.state().cursor, 'after');
  assert.equal(fs.existsSync(path.join(channel.directory, '接收.lock')), false);
});

test('stopping polling aborts the in-flight fetch immediately without changing the cursor', async t => {
  let receivedSignal;
  const channel = setup(t, async (_url, options) => new Promise((resolve, reject) => {
    receivedSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const polling = channel.poll({ signal: controller.signal });
  controller.abort();
  assert.deepEqual(await polling, { cancelled: true });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(channel.state().cursor, '');
  assert.equal(fs.existsSync(path.join(channel.directory, '接收.lock')), false);
});

test('pre-cancelled poll and request never start a network operation or create a receiving lock', async t => {
  let calls = 0;
  const channel = setup(t, async () => { calls++; return response({ ret: 0 }); });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await channel.poll({ signal: controller.signal }), { cancelled: true });
  await assert.rejects(channel.request('ilink/bot/getupdates', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(channel.directory, '接收.lock')), false);
});

test('business errors are not treated as successful HTTP and expected poll timeout does not advance cursor', async t => {
  const channel = setup(t, async () => response({ ret: -14 }));
  await assert.rejects(channel.poll(), /-14/);
  channel.fetcher = async () => { const error = new Error('mock-timeout'); error.name = 'TimeoutError'; throw error; };
  assert.deepEqual(await channel.poll(), { timeout: true });
  assert.equal(channel.state().cursor, '');
  assert.equal(fs.existsSync(path.join(channel.directory, '接收.lock')), false);
});

test('login returns QR data without writing image files; confirmed rebind clears old owner queue and QR secret', async t => {
  let calls = 0;
  const channel = setup(t, async () => {
    calls++;
    return calls === 1 ? response({ qrcode: 'mock-qr-code', qrcode_img_content: 'https://example.test/mock-qr' })
      : response({ status: 'confirmed', bot_token: 'new-test-token', ilink_user_id: 'new-owner', ilink_bot_id: 'new-bot', baseurl: auth.base });
  });
  channel.ingest({ msgs: [message('1')] });
  const qr = await channel.beginLogin();
  assert.equal(qr.status, 'waiting');
  assert.equal(qr.qrText, 'https://example.test/mock-qr');
  assert.match(qr.qrDataUrl, /^data:image\/gif;base64,/);
  assert.equal(fs.readdirSync(channel.directory).some(x => /\.(gif|png|svg)$/.test(x)), false);
  assert.deepEqual(await channel.loginStep(), { status: 'confirmed', authenticated: true });
  assert.equal(fs.existsSync(path.join(channel.directory, '登录中.json')), false);
  assert.equal(channel.auth().owner, 'new-owner');
  assert.deepEqual(channel.inbox(), []);
  assert.equal(channel.state().lastContext, undefined);
  await assert.rejects(channel.sendOwner('旧消息', 'after-rebind'), /先在移动端/);
});

test('unsafe QR redirect and confirmed login without ownership cannot replace existing authentication', async t => {
  const channel = setup(t, async () => response({ status: 'scaned_but_redirect', redirect_host: 'weixin.qq.com.evil.test' }));
  channel.save('登录中', { code: 'mock-code', base: auth.base, created: Date.now() });
  await assert.rejects(channel.loginStep(), /非预期服务地址/);
  assert.deepEqual(channel.auth(), auth);
  channel.fetcher = async () => response({ status: 'confirmed', bot_token: 'missing-owner' });
  await assert.rejects(channel.loginStep(), /缺少账号归属/);
  assert.deepEqual(channel.auth(), auth);
});

test('inflight receive cannot be inserted after another account is bound', async t => {
  let release;
  const channel = setup(t, async () => new Promise(resolve => { release = () => resolve(response({ msgs: [message('1')], get_updates_buf: 'stale' })); }));
  const polling = channel.poll();
  channel.save('认证', { ...auth, token: 'rebound-token', owner: 'new-owner' });
  release();
  await assert.rejects(polling, /扫码账号已变化/);
  assert.deepEqual(channel.inbox(), []);
  assert.equal(channel.state().cursor, '');
});

test('outbound validation fails before any network call', async t => {
  let calls = 0;
  const channel = setup(t, async () => { calls++; return response({ ret: 0 }); });
  channel.ingest({ msgs: [message('1')] });
  for (const text of ['', ' ', '😀'.repeat(3801)]) await assert.rejects(channel.reply('1', text), /3800/);
  await assert.rejects(channel.sendOwner('有效', ''), /幂等键/);
  assert.equal(calls, 0);
  assert.equal(channel.inbox().length, 1);
});
