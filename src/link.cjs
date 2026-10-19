const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Channel } = require('./channel.cjs');
const { CodexConnection, statusOf } = require('./codex.cjs');

function taskJournalName(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw new Error('请指定有效的已有会话 ID。');
  return '连接任务-' + crypto.createHash('sha256').update(threadId).digest('hex');
}

function messageJournalName(messageId) {
  if (typeof messageId !== 'string' || !messageId || messageId.length > 512) throw new Error('消息 ID 无效。');
  return '消息任务-' + crypto.createHash('sha256').update(messageId).digest('hex');
}

class Link extends EventEmitter {
  constructor({ directory, codex = {}, channel, connection } = {}) {
    super(); this.channel = channel || new Channel({ directory }); this.codex = connection || new CodexConnection(codex);
    this.running = false; this.busy = false; this.error = null; this.selected = null;
    this.loop = null; this.handlers = new Set(); this.controller = null; this.stopping = null;
    this.messageQueue = []; this.queuedMessages = new Map(); this.queueWorker = null; this.queuePaused = false; this.queueController = new AbortController();
    this.codex.on('approval', entry => { this.emit('approval', entry); });
    this.codex.on('disconnected', () => { if (this.running) this.error = 'Codex 已断开，请停止连接后重新连接；消息不会自动重发。'; this.emit('state'); });
  }
  async select(threadId) {
    if (this.running || this.loop || this.stopping) throw new Error('请先停止连接并等待停止完成，再更换会话。');
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw new Error('请指定有效的已有会话 ID。');
    await this.codex.connect(); const t = await this.codex.readThread(threadId);
    if (t.id !== threadId) throw new Error('会话身份不一致，请重新选择。');
    this.selected = { id: t.id, title: t.name || t.title || t.preview || '未命名会话', status: statusOf(t) };
    return this.selected;
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    if (this.loop) await this.loop;
    if (!this.selected) throw new Error('请先绑定一个已有 Codex 会话。');
    this.channel.auth(); await this.codex.connect();
    this.assertTaskReady(this.selected.id);
    const queued = this.channel.state().messages.filter(message => message.status === 'queued');
    const lock = path.join(this.channel.directory, '连接器.lock');
    try { this.lock = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, created: Date.now() })); }
    catch { throw new Error('此账号已有连接器运行，或上次未正常退出。请先核实原进程。'); }
    this.lockPath = lock; this.running = true; this.error = null; this.queuePaused = false;
    if (this.queueController.signal.aborted) this.queueController = new AbortController();
    const controller = new AbortController(); this.controller = controller;
    // Resume only messages durably queued before submission. Processing and
    // unknown rows may already have started model work and are never replayed.
    for (const message of queued) this.enqueueMessage({ id: message.id, text: message.text, ...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}) });
    this.loop = this.receiveLoop(controller.signal).catch(() => {
      if (!controller.signal.aborted) this.error = '通道已停止，请检查连接后重启。';
    }).finally(async () => {
      // Finish the old generation before releasing its lock. A new start waits
      // for this promise, so a late poll can never stop or unlock the new run.
      this.running = false; controller.abort(); this.pauseQueue(); this.codex.close();
      if (this.queueWorker) await this.queueWorker;
      await Promise.allSettled([...this.handlers]);
      this.unlock(); this.controller = null; this.loop = null; this.emit('state');
    });
  }
  assertTaskReady(threadId, messageId) {
    taskJournalName(threadId);
    // An unresolved old message must not lock the entire destination. Keep all
    // legacy journals untouched; consult them only to prevent that exact mobile
    // message from being submitted again after a restart or a session switch.
    if (messageId === undefined) return;
    const current = this.channel.read(messageJournalName(messageId));
    const legacy = [this.channel.read(taskJournalName(threadId)), this.channel.read('连接任务')];
    const prior = current || legacy.find(entry => entry?.messageId === messageId);
    if (prior) {
      const error = new Error(prior.status === 'complete' ? '这条消息已经处理完成。' : '这条消息已经提交，不会重复发送；你可以继续发送新消息。');
      error.previouslyHandled = prior.status === 'complete';
      error.unknown = !error.previouslyHandled;
      throw error;
    }
  }
  unlock() { if (this.lock != null) { try { fs.closeSync(this.lock); } catch {} this.lock = null; try { fs.unlinkSync(this.lockPath); } catch {} } }
  get queuedCount() { return this.channel.state().messages.filter(message => message.status === 'queued').length; }
  pauseQueue() {
    this.queuePaused = true; this.queueController.abort();
    // Release callers waiting for messages that have not started. The durable
    // rows stay queued, ready for the next normal start; stop never waits on
    // those callers while preventing the worker from running them.
    for (const entry of this.messageQueue.splice(0)) {
      this.queuedMessages.delete(entry.message.id); entry.resolve({ queued: true });
    }
    this.emit('state');
  }
  async stop() {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      this.running = false; this.controller?.abort(); this.pauseQueue(); this.codex.close();
      if (this.loop) await this.loop;
      if (this.queueWorker) await this.queueWorker;
      await Promise.allSettled([...this.handlers]);
      this.unlock(); this.emit('state');
    })();
    this.stopping = stopping;
    try { await stopping; }
    finally { if (this.stopping === stopping) this.stopping = null; }
  }
  async receiveLoop(signal) {
    let failures = 0;
    while (this.running && !signal.aborted) {
      try {
        const result = await this.channel.poll({ signal }); failures = 0;
        if (!this.running || signal.aborted || result?.cancelled) break;
        for (const message of this.channel.inbox()) {
          if (!this.running || signal.aborted) break;
          const handler = this.handle(message).catch(() => {
            this.error = '消息处理结果未确认，请在电脑核对。'; this.emit('state');
          }).finally(() => this.handlers.delete(handler));
          this.handlers.add(handler);
        }
      } catch {
        if (!this.running || signal.aborted) break;
        failures++;
        this.error = '移动通道暂时断开，正在重新接收；不会重复提交已处理消息。'; this.emit('state');
        if (failures >= 3) { this.running = false; break; }
        await delay([1000, 3000, 8000][failures - 1], undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
      if (this.running && !signal.aborted) await delay(300, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  }
  async send(text, key) {
    const chars = Array.from(text || '本轮已结束，没有可转发的文字回复，请回电脑端查看。');
    for (let n = 0; n < chars.length; n += 3500) {
      if (this.controller?.signal.aborted) { const error = new Error('连接器已停止，发送结果请回电脑核对。'); error.unknown = true; throw error; }
      await this.channel.sendOwner(chars.slice(n, n + 3500).join(''), key + '-' + n);
    }
  }
  async handle(message) {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const control = text === '帮助' || text === '状态';
    let claimed = false;
    this.channel.update(s => { const row = s.messages.find(x => x.id === message.id); if (row?.status === 'pending') { row.status = control ? 'processing' : 'queued'; claimed = true; } });
    if (!claimed) return;
    if (control) {
      await this.send(text === '帮助' ? '开摆连接器\n直接发送文字即可继续聊天，连续消息会按顺序处理。\n状态：查看连接状态。\n更换会话请回电脑端设置。' : '当前会话：' + this.selected.title + '\n状态：' + (this.busy ? '处理中' : this.codex.connected ? '已连接' : '已断开') + (this.queuedCount ? '\n排队消息：' + this.queuedCount : ''), 'control-' + message.id);
      this.channel.markHandled(message.id); return;
    }
    if (this.queuePaused) { this.emit('state'); return { queued: true }; }
    return this.enqueueMessage(message);
  }
  enqueueMessage(message) {
    const existing = this.queuedMessages.get(message.id);
    if (existing) return existing.promise;
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    // Recovered rows have no waiting handle caller. Keep failures observed even
    // when their promise is not returned through the receive-loop handler set.
    promise.catch(() => {});
    const entry = { message, promise, resolve, reject };
    this.queuedMessages.set(message.id, entry); this.messageQueue.push(entry);
    this.drainQueue(); this.emit('state');
    return promise;
  }
  drainQueue() {
    if (this.queueWorker || this.queuePaused || this.controller?.signal.aborted) return;
    const worker = (async () => {
      while (this.messageQueue.length && !this.queuePaused && !this.controller?.signal.aborted) {
        if (!this.codex.connected) {
          this.error = 'Codex 已断开，排队消息已保留，重新连接后继续。'; this.emit('state'); break;
        }
        const entry = this.messageQueue.shift();
        try {
          await this.runMessage(entry.message);
          // Enhanced editions may finish a queued session switch here. It must
          // complete before the next text resolves its destination.
          if (!this.queuePaused && !this.controller?.signal.aborted) await this.afterMessage();
          entry.resolve();
        } catch (error) {
          this.error = error.message; this.emit('state'); entry.reject(error);
        } finally { this.queuedMessages.delete(entry.message.id); }
      }
    })();
    this.queueWorker = worker;
    worker.finally(() => {
      if (this.queueWorker === worker) this.queueWorker = null;
      if (this.messageQueue.length && this.codex.connected && !this.queuePaused && !this.controller?.signal.aborted) this.drainQueue();
    }).catch(() => {});
  }
  async afterMessage() {}
  async prepareMessage(message) { return message; }
  async prepareQueuedMessage(message) {
    const signal = this.queueController.signal;
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => { const error = new Error('消息已保留，重新连接后继续。'); error.name = 'AbortError'; reject(error); };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return this.prepareMessage(message, { signal }); }), cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  async runMessage(message) {
    let claimed = false;
    this.channel.update(state => {
      const row = state.messages.find(item => item.id === message.id);
      if (row?.status === 'queued') { row.status = 'processing'; claimed = true; }
    });
    if (!claimed) return;
    let prepared;
    try {
      prepared = await this.prepareQueuedMessage(message);
      if (this.queuePaused || this.queueController.signal.aborted || this.controller?.signal.aborted) throw new Error('消息已保留，重新连接后继续。');
    } catch {
      if (this.queuePaused || this.queueController.signal.aborted || this.controller?.signal.aborted) {
        // A user-requested stop did not submit this message. Preserve its
        // original payload for a safe preparation attempt on the next start.
        this.channel.update(state => { const row = state.messages.find(item => item.id === message.id); if (row?.status === 'processing') row.status = 'queued'; });
      } else {
        // An unreadable attachment affects only its own message. Keep a bounded
        // audit without paths, tokens or exception text, then continue the queue.
        const journal = messageJournalName(message.id);
        if (!this.channel.read(journal)) this.channel.save(journal, { messageId: message.id, threadId: this.selected?.id || null, status: 'failed', stage: 'prepare', at: Date.now() });
        this.channel.markHandled(message.id);
        this.error = '这条消息暂时无法读取，请重新发送。后续消息会继续处理。';
        try { await this.send(this.error, 'prepare-failure-' + message.id); } catch {}
      }
      this.emit('state'); return;
    }
    const text = typeof prepared?.text === 'string' ? prepared.text.trim() : '';
    if (!text || text.length > 16000) {
      await this.send('请发送不超过 16000 字的文字消息。', 'size-' + message.id);
      this.channel.markHandled(message.id); return;
    }
    this.busy = true; this.emit('state');
    let submitted = false, callbackAccepted = false;
    const threadId = this.selected.id;
    const journal = messageJournalName(message.id);
    try {
      this.assertTaskReady(threadId, message.id);
      // Durable intent precedes the only operation that may start model work.
      this.channel.save(journal, { messageId: message.id, threadId, status: 'sending', at: Date.now() });
      submitted = true;
      const reply = await this.codex.runTurn(threadId, prepared.text, turnId => {
        callbackAccepted = true;
        this.channel.save(journal, { messageId: message.id, threadId, turnId, status: 'accepted', at: Date.now() });
      }, { requestId: message.id });
      await this.send(reply, 'reply-' + message.id);
      this.channel.markHandled(message.id);
      this.channel.save(journal, { messageId: message.id, threadId, status: 'complete', at: Date.now() });
      this.error = null;
    } catch (error) {
      this.error = error.message;
      this.channel.update(s => { const row = s.messages.find(x => x.id === message.id); if (row) row.status = error.previouslyHandled ? 'handled' : 'unknown'; });
      if (submitted) this.channel.save(journal, { ...this.channel.read(journal), status: error.unknown || callbackAccepted ? 'unknown' : 'failed', at: Date.now() });
      try { await this.send('未能完成：' + error.message, 'failure-' + message.id); } catch {}
    } finally { this.busy = false; this.emit('state'); }
  }
}
module.exports = { Link, taskJournalName, messageJournalName };
