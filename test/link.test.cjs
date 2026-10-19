'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate: immediate } = require('node:timers/promises');
const { Channel } = require('../src/channel.cjs');
const { Link, taskJournalName, messageJournalName } = require('../src/link.cjs');

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
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'complete');
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

function addMessage(f, id, text, extra = {}) {
  const message = { id, text, ...extra };
  f.channel.update(state => { state.messages.push({ ...message, status: 'pending', received: Date.now() }); });
  return message;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function longPoll(f) {
  f.connection.connect = async () => { f.connection.connected = true; };
  f.channel.poll = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
}

test('three rapid texts persist their queue and complete in inbound order with one active model request', async t => {
  const f = fixture(t, 'first'), gate = deferred();
  const calls = []; let active = 0, maximum = 0;
  f.connection.runTurn = async (_thread, text, accepted, options) => {
    calls.push({ text, requestId: options.requestId }); active++; maximum = Math.max(maximum, active);
    await accepted('turn-' + options.requestId);
    if (text === 'first') await gate.promise;
    active--; return 'reply-' + text;
  };
  const first = f.link.handle(f.message);
  await immediate();
  const secondMessage = addMessage(f, '2', 'second'), thirdMessage = addMessage(f, '3', 'third');
  const second = f.link.handle(secondMessage), third = f.link.handle(thirdMessage);
  await f.link.handle(secondMessage);
  assert.deepEqual(f.channel.state().messages.map(row => row.status), ['processing', 'queued', 'queued']);
  assert.equal(f.link.queuedCount, 2);
  assert.deepEqual(calls, [{ text: 'first', requestId: '1' }]);
  assert.equal(f.channel.read(messageJournalName('2')), null);
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, [{ text: 'first', requestId: '1' }, { text: 'second', requestId: '2' }, { text: 'third', requestId: '3' }]);
  assert.equal(maximum, 1);
  assert.deepEqual(f.sent, ['reply-first', 'reply-second', 'reply-third']);
  assert.deepEqual(f.channel.state().messages.map(row => row.status), ['handled', 'handled', 'handled']);
  assert.equal(f.link.queuedCount, 0);
});

test('an unconfirmed model submission is persisted and is not automatically replayed', async t => {
  const f = fixture(t); let calls = 0;
  f.connection.runTurn = async () => { calls++; const error = new Error('mock-disconnect'); error.unknown = true; throw error; };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'unknown');
  await f.link.handle(f.message);
  assert.equal(calls, 1);
});

test('accepted work remains unknown if persisting its turn receipt fails', async t => {
  const f = fixture(t); const save = f.channel.save.bind(f.channel);
  f.channel.save = (name, value) => {
    if (name === messageJournalName(f.message.id) && value.status === 'accepted') throw new Error('mock-disk-full');
    return save(name, value);
  };
  await f.link.handle(f.message);
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'unknown');
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
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'unknown');
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.equal(fs.existsSync(path.join(f.channel.directory, '连接器.lock')), false);
});

test('stop preserves queued texts and the next start resumes only those not dispatched', async t => {
  const f = fixture(t, 'first'); longPoll(f);
  const active = deferred(), calls = [];
  f.connection.runTurn = async (_thread, text, accepted) => {
    calls.push(text); await accepted('turn-' + text);
    return text === 'first' ? active.promise : 'reply-' + text;
  };
  f.connection.close = () => { f.connection.connected = false; const error = new Error('stopped after submission'); error.unknown = true; active.reject(error); };
  await f.link.start();
  const first = f.link.handle(f.message);
  await immediate();
  const second = f.link.handle(addMessage(f, '2', 'second'));
  const third = f.link.handle(addMessage(f, '3', 'third'));
  await f.link.stop();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(f.channel.state().messages.map(row => row.status), ['unknown', 'queued', 'queued']);
  assert.equal(f.channel.read(messageJournalName('1')).status, 'unknown');
  assert.equal(f.channel.read(messageJournalName('2')), null);
  assert.equal(f.channel.read(messageJournalName('3')), null);
  const preserved = fs.readFileSync(f.channel.filename(messageJournalName('1')));
  await f.link.start();
  await f.link.queueWorker;
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.deepEqual(f.channel.state().messages.map(row => row.status), ['unknown', 'handled', 'handled']);
  assert.deepEqual(fs.readFileSync(f.channel.filename(messageJournalName('1'))), preserved);
  await f.link.stop();
});

test('attachment preparation cannot be overtaken by later text or write model intent early', async t => {
  const f = fixture(t, 'image request'), gate = deferred(), prepared = [], calls = [];
  f.message.text = '';
  f.message.attachments = [{ type: 'image', file: 'fixture-image' }];
  f.channel.update(state => { state.messages[0].text = ''; state.messages[0].attachments = f.message.attachments; });
  f.link.prepareMessage = async (message, { signal }) => {
    assert.equal(signal.aborted, false); prepared.push(message.id);
    if (message.id === '1') await gate.promise;
    return { ...message, text: message.id === '1' ? 'image at fixture-local-path' : message.text };
  };
  f.connection.runTurn = async (_thread, text) => { calls.push(text); return 'done-' + text; };
  const first = f.link.handle(f.message);
  const second = f.link.handle(addMessage(f, '2', 'after image'));
  await immediate();
  assert.deepEqual(prepared, ['1']);
  assert.deepEqual(calls, []);
  assert.equal(f.channel.read(messageJournalName('1')), null);
  assert.equal(f.channel.read(messageJournalName('2')), null);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(prepared, ['1', '2']);
  assert.deepEqual(calls, ['image at fixture-local-path', 'after image']);
});

test('a failed attachment preparation affects one message and the following text still completes', async t => {
  const f = fixture(t, 'unreadable image'), calls = [];
  f.link.prepareMessage = async message => {
    if (message.id === '1') throw new Error('fixture failure: /private/secret-image.png token=fixture-private-token');
    return message;
  };
  f.connection.runTurn = async (_thread, text) => { calls.push(text); return 'following text reply'; };
  const first = f.link.handle(f.message);
  const second = f.link.handle(addMessage(f, '2', 'following text'));
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['following text']);
  assert.deepEqual(f.sent, ['这条消息暂时无法读取，请重新发送。后续消息会继续处理。', 'following text reply']);
  assert.deepEqual(f.channel.state().messages.map(row => row.status), ['handled', 'handled']);
  const audit = f.channel.read(messageJournalName('1'));
  assert.equal(audit.status, 'failed'); assert.equal(audit.stage, 'prepare');
  assert.equal(audit.messageId, '1'); assert.equal(audit.threadId, 'thread-1');
  assert.doesNotMatch(JSON.stringify(audit), /secret-image|private-token|fixture failure/);
  assert.equal(f.channel.read(messageJournalName('2')).status, 'complete');
  assert.equal(f.link.queuePaused, false); assert.equal(f.link.queuedCount, 0);
  assert.equal(f.link.error, null);
  await f.link.handle(f.message);
  assert.deepEqual(calls, ['following text']);
  assert.equal(f.sent.length, 2);
});

test('stopping during preparation preserves the original queued attachment and never dispatches a late result', async t => {
  const f = fixture(t, 'with attachment'), gate = deferred(); longPoll(f);
  const attachments = [{ type: 'image', file: 'fixture-encrypted-image' }];
  f.message.attachments = attachments;
  f.channel.update(state => { state.messages[0].attachments = attachments; });
  let prepares = 0, sends = 0, firstSignal;
  f.link.prepareMessage = async (message, { signal }) => {
    prepares++; if (prepares === 1) { firstSignal = signal; await gate.promise; }
    assert.deepEqual(message.attachments, attachments);
    return { ...message, text: 'prepared attachment text' };
  };
  f.connection.runTurn = async () => { sends++; return 'attachment reply'; };
  f.connection.close = () => { f.connection.connected = false; };
  await f.link.start();
  const first = f.link.handle(f.message);
  await immediate();
  await f.link.stop(); await first;
  assert.equal(firstSignal.aborted, true);
  assert.equal(sends, 0);
  assert.equal(f.channel.state().messages[0].status, 'queued');
  assert.deepEqual(f.channel.state().messages[0].attachments, attachments);
  assert.equal(f.channel.read(messageJournalName('1')), null);
  gate.resolve(); await immediate();
  assert.equal(sends, 0);
  await f.link.start(); await f.link.queueWorker;
  assert.equal(prepares, 2); assert.equal(sends, 1);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  await f.link.stop();
});

test('status controls remain responsive during a reply and do not interrupt ordered queued texts or reception', async t => {
  const f = fixture(t, 'first'), gate = deferred(); longPoll(f);
  const calls = [];
  f.connection.runTurn = async (_thread, text) => { calls.push(text); if (text === 'first') await gate.promise; return 'reply-' + text; };
  await f.link.start();
  const controller = f.link.controller, loop = f.link.loop;
  const first = f.link.handle(f.message);
  await immediate();
  const second = f.link.handle(addMessage(f, '2', 'second'));
  await f.link.handle(addMessage(f, '3', '状态'));
  assert.match(f.sent[0], /状态：处理中\n排队消息：1/);
  assert.deepEqual(calls, ['first']);
  assert.equal(f.link.controller, controller); assert.equal(f.link.loop, loop); assert.equal(f.link.running, true);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(f.sent.slice(1), ['reply-first', 'reply-second']);
  await f.link.stop();
});

test('the after-message hook completes a pending destination change before the next queued dispatch', async t => {
  const f = fixture(t, 'first'), gate = deferred(), calls = [];
  f.connection.runTurn = async (threadId, text) => { calls.push({ threadId, text }); if (text === 'first') await gate.promise; return text; };
  f.link.afterMessage = async () => { await immediate(); f.link.selected = { id: 'thread-two', title: 'Switched chat' }; };
  const first = f.link.handle(f.message);
  await immediate();
  const second = f.link.handle(addMessage(f, '2', 'second'));
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(calls, [{ threadId: 'thread-1', text: 'first' }, { threadId: 'thread-two', text: 'second' }]);
});

test('a connection can restart on its original thread without changing any legacy unresolved evidence', async t => {
  const f = fixture(t);
  f.connection.connect = async () => {};
  f.channel.inbox = () => [];
  f.channel.poll = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
  for (const status of ['sending', 'accepted', 'unknown']) {
    f.channel.save('连接任务', { threadId: 'thread-1', messageId: 'old-message', status, at: 1 });
    f.channel.save(taskJournalName('thread-1'), { threadId: 'thread-1', messageId: 'another-old-message', status, at: 2 });
    const before = ['连接任务', taskJournalName('thread-1')].map(name => fs.readFileSync(f.channel.filename(name)));
    await f.link.start();
    assert.equal(f.link.running, true);
    await f.link.stop();
    assert.deepEqual(['连接任务', taskJournalName('thread-1')].map(name => fs.readFileSync(f.channel.filename(name))), before);
    assert.equal(fs.existsSync(path.join(f.channel.directory, '连接器.lock')), false);
    assert.equal(f.channel.read(messageJournalName(f.message.id)), null);
  }
});

test('a different thread can start and writes only its own journal while legacy unknown stays untouched', async t => {
  const f = fixture(t);
  f.channel.save('连接任务', { threadId: 'old-thread', messageId: 'old-message', status: 'unknown', at: 1 });
  const before = fs.readFileSync(f.channel.filename('连接任务'));
  f.connection.connect = async () => { f.connection.connected = true; };
  f.channel.poll = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
  let calls = 0;
  f.connection.runTurn = async (threadId, _text, accepted, options) => {
    calls++;
    assert.equal(threadId, 'thread-1');
    assert.deepEqual(options, { requestId: f.message.id });
    assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'sending');
    assert.deepEqual(fs.readFileSync(f.channel.filename('连接任务')), before);
    await accepted('new-turn');
    assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'accepted');
    return '新会话的回复';
  };
  try {
    await f.link.start();
    assert.equal(f.link.running, true);
    await f.link.handle(f.message);
    assert.equal(calls, 1);
    assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'complete');
    assert.equal(f.channel.read(taskJournalName('old-thread')), null);
    assert.deepEqual(fs.readFileSync(f.channel.filename('连接任务')), before);
  } finally { await f.link.stop(); }
});

test('new inbound IDs continue on a thread with scoped unknown and preserve the old journal', async t => {
  const f = fixture(t);
  const journal = taskJournalName('thread-1');
  f.channel.save(journal, { threadId: 'thread-1', messageId: 'old-message', status: 'unknown', at: 1 });
  const before = fs.readFileSync(f.channel.filename(journal));
  f.connection.connect = async () => {};
  let calls = 0; f.connection.runTurn = async () => { calls++; return 'new message completed'; };
  assert.doesNotThrow(() => f.link.assertTaskReady('thread-1'));
  await f.link.handle(f.message);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(f.channel.filename(journal)), before);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'complete');
});

test('unrelated legacy records and identities do not lock new inbound messages', async t => {
  const f = fixture(t);
  f.connection.connect = async () => {};
  f.channel.save('连接任务', { messageId: 'legacy-without-thread', status: 'unknown' });
  assert.doesNotThrow(() => f.link.assertTaskReady('thread-1', f.message.id));
  f.channel.save('连接任务', { threadId: 'another-thread', status: 'unknown' });
  f.channel.save(taskJournalName('thread-1'), { threadId: 'incorrect-thread', status: 'complete' });
  assert.doesNotThrow(() => f.link.assertTaskReady('thread-1', f.message.id));
  assert.match(taskJournalName('../thread/with-path'), /^连接任务-[a-f0-9]{64}$/);
  assert.match(messageJournalName('../message/with-path'), /^消息任务-[a-f0-9]{64}$/);
});

test('the same unknown message cannot be resubmitted even if its inbox row is reset or the session changes', async t => {
  const f = fixture(t); let calls = 0;
  f.connection.runTurn = async () => { calls++; const error = new Error('unconfirmed'); error.unknown = true; throw error; };
  await f.link.handle(f.message);
  const journal = messageJournalName(f.message.id), before = fs.readFileSync(f.channel.filename(journal));
  f.channel.update(state => { state.messages[0].status = 'pending'; });
  f.link.selected = { id: 'thread-2', title: '新选择的会话' };
  await f.link.handle(f.message);
  assert.equal(calls, 1);
  assert.equal(f.channel.state().messages[0].status, 'unknown');
  assert.deepEqual(fs.readFileSync(f.channel.filename(journal)), before);
});

test('same-message legacy unknown remains protected while a distinct inbound message completes', async t => {
  for (const legacyName of ['连接任务', taskJournalName('thread-1')]) {
    const f = fixture(t); let calls = 0;
    f.channel.save(legacyName, { threadId: 'thread-1', messageId: f.message.id, status: 'unknown', at: 1 });
    const before = fs.readFileSync(f.channel.filename(legacyName));
    f.connection.runTurn = async () => { calls++; return 'new reply'; };
    await f.link.handle(f.message);
    assert.equal(calls, 0);
    f.channel.update(state => { state.messages.push({ ...f.message, id: '2', status: 'pending' }); });
    await f.link.handle({ ...f.message, id: '2' });
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(f.channel.filename(legacyName)), before);
    assert.equal(f.channel.read(messageJournalName('2')).status, 'complete');
  }
});

test('a durable completed message is not replayed if the inbox row returns to pending', async t => {
  const f = fixture(t); let calls = 0;
  f.connection.runTurn = async () => { calls++; return 'done'; };
  await f.link.handle(f.message);
  f.channel.update(state => { state.messages[0].status = 'pending'; });
  await f.link.handle(f.message);
  assert.equal(calls, 1);
  assert.equal(f.channel.state().messages[0].status, 'handled');
  assert.equal(f.channel.read(messageJournalName(f.message.id)).status, 'complete');
});
