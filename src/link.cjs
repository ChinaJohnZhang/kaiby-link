const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Channel } = require('./channel.cjs');
const { CodexConnection, statusOf } = require('./codex.cjs');

class Link extends EventEmitter {
  constructor({ directory, codex = {}, channel, connection } = {}) {
    super(); this.channel = channel || new Channel({ directory }); this.codex = connection || new CodexConnection(codex);
    this.running = false; this.busy = false; this.error = null; this.selected = null;
    this.loop = null; this.handlers = new Set(); this.controller = null; this.stopping = null;
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
    const prior = this.channel.read('连接任务');
    if (prior && ['sending', 'accepted', 'unknown'].includes(prior.status)) throw new Error('上次消息结果尚未确认，请先在 Codex 核对；连接器不会自动重发。');
    const lock = path.join(this.channel.directory, '连接器.lock');
    try { this.lock = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, created: Date.now() })); }
    catch { throw new Error('此账号已有连接器运行，或上次未正常退出。请先核实原进程。'); }
    this.lockPath = lock; this.running = true; this.error = null;
    const controller = new AbortController(); this.controller = controller;
    this.loop = this.receiveLoop(controller.signal).catch(() => {
      if (!controller.signal.aborted) this.error = '通道已停止，请检查连接后重启。';
    }).finally(async () => {
      // Finish the old generation before releasing its lock. A new start waits
      // for this promise, so a late poll can never stop or unlock the new run.
      this.running = false; controller.abort(); this.codex.close();
      await Promise.allSettled([...this.handlers]);
      this.unlock(); this.controller = null; this.loop = null; this.emit('state');
    });
  }
  unlock() { if (this.lock != null) { try { fs.closeSync(this.lock); } catch {} this.lock = null; try { fs.unlinkSync(this.lockPath); } catch {} } }
  async stop() {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      this.running = false; this.controller?.abort(); this.codex.close();
      if (this.loop) await this.loop;
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
    let claimed = false;
    this.channel.update(s => { const row = s.messages.find(x => x.id === message.id); if (row?.status === 'pending') { row.status = 'processing'; claimed = true; } });
    if (!claimed) return;
    const text = message.text.trim();
    if (text === '帮助' || text === '状态') {
      await this.send(text === '帮助' ? '开摆连接器\n当前固定绑定一个 Codex 会话。直接发送文字即可继续聊天。\n状态：查看连接状态。\n更换会话请回电脑端设置。' : '当前会话：' + this.selected.title + '\n状态：' + (this.busy ? '处理中' : this.codex.connected ? '已连接' : '已断开'), 'control-' + message.id);
      this.channel.markHandled(message.id); return;
    }
    if (this.busy || !this.codex.connected) {
      await this.send(this.busy ? '当前会话正在处理消息，请完成后再发送。本条消息未提交。' : 'Codex 已断开，请回电脑端重新连接。本条消息未提交。', 'busy-' + message.id);
      this.channel.markHandled(message.id); return;
    }
    if (!text || text.length > 16000) { await this.send('请发送不超过 16000 字的文字消息。', 'size-' + message.id); this.channel.markHandled(message.id); return; }
    this.busy = true; this.emit('state');
    let submitted = false, callbackAccepted = false;
    const threadId = this.selected.id;
    try {
      // Durable intent precedes the only operation that may start model work.
      this.channel.save('连接任务', { messageId: message.id, threadId, status: 'sending', at: Date.now() });
      submitted = true;
      const reply = await this.codex.runTurn(threadId, message.text, turnId => {
        callbackAccepted = true;
        this.channel.save('连接任务', { messageId: message.id, threadId, turnId, status: 'accepted', at: Date.now() });
      });
      await this.send(reply, 'reply-' + message.id);
      this.channel.markHandled(message.id);
      this.channel.save('连接任务', { messageId: message.id, threadId, status: 'complete', at: Date.now() });
      this.error = null;
    } catch (error) {
      this.error = error.message;
      this.channel.update(s => { const row = s.messages.find(x => x.id === message.id); if (row) row.status = 'unknown'; });
      if (submitted) this.channel.save('连接任务', { ...this.channel.read('连接任务'), status: error.unknown || callbackAccepted ? 'unknown' : 'failed', at: Date.now() });
      try { await this.send('未能完成：' + error.message, 'failure-' + message.id); } catch {}
    } finally { this.busy = false; this.emit('state'); }
  }
}
module.exports = { Link };
