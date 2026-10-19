const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

function safeEndpoint(value) {
  let u; try { u = new URL(value); } catch { throw new Error('请填写有效的 Codex 连接地址。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!['ws:', 'wss:'].includes(u.protocol) || (!local && u.protocol !== 'wss:') || u.username || u.password || u.hash || u.search) {
    throw new Error('Codex 连接须使用本机 ws 地址或受保护的 wss 地址，认证请使用环境变量。');
  }
  return u.href;
}
function statusOf(thread) { return typeof thread?.status === 'string' ? thread.status : thread?.status?.type || 'notLoaded'; }

class CodexConnection extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.pending = new Map(); this.sequence = 0; this.connected = false; this.active = null; this.turnReserved = false;
  }
  async connect() {
    if (this.connected) return;
    if (this.transport) throw new Error('正在连接 Codex，请稍后。');
    try {
      if (this.options.mode === 'proxy') {
        const executable = this.options.cliPath || 'codex';
        if (/\.(cmd|bat)$/i.test(executable)) throw new Error('请选择原生 codex 可执行文件，不能使用命令脚本。');
        const child = spawn(executable, ['app-server', 'proxy'], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: { ...process.env, ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}) },
        });
        this.transport = child; this.write = x => child.stdin.write(JSON.stringify(x) + '\n');
        let buffer = '';
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
          if (this.transport !== child) return;
          buffer += chunk;
          if (buffer.length > 8 * 1024 * 1024) { this.close(); return; }
          let index; while ((index = buffer.indexOf('\n')) >= 0) { this.receive(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
        });
        const disconnected = () => { if (this.transport === child) this.lost(); };
        child.stderr.resume(); child.on('error', disconnected); child.on('exit', disconnected);
        child.stdin.on('error', disconnected);
      } else {
        const endpoint = safeEndpoint(this.options.endpoint || '');
        const token = this.options.token || process.env.KAIBY_LINK_CODEX_TOKEN;
        if (new URL(endpoint).protocol === 'wss:' && !token) throw new Error('远程 Codex 连接需要设置 KAIBY_LINK_CODEX_TOKEN。');
        const socket = new WebSocket(endpoint, { headers: token ? { Authorization: 'Bearer ' + token } : {}, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 8000, followRedirects: false });
        this.transport = socket;
        socket.on('message', value => { if (this.transport === socket) this.receive(value.toString()); });
        const disconnected = () => { if (this.transport === socket) this.lost(); };
        socket.on('error', disconnected); socket.on('close', disconnected);
        await new Promise((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', () => reject(new Error('无法连接 Codex，请检查连接地址和运行状态。')));
          socket.once('close', () => reject(new Error('Codex 在建立连接前已关闭。')));
        });
        this.write = x => socket.send(JSON.stringify(x));
      }
      await this.request('initialize', { clientInfo: { name: 'kaiby_link', title: 'Kaiby Link', version: '0.1.0' } });
      this.write({ method: 'initialized' }); this.connected = true;
    } catch (error) { this.close(); throw error; }
  }
  request(method, params) {
    if (!this.transport || !this.write) return Promise.reject(new Error('Codex 尚未连接。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); const e = new Error('Codex 操作结果未确认，请在电脑端核对；不会自动重发。'); e.unknown = true; reject(e); }, this.options.timeout || 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch {
        clearTimeout(timer); this.pending.delete(id);
        const error = new Error('Codex 连接已中断，操作结果未确认，不会自动重发。'); error.unknown = true; reject(error);
      }
    });
  }
  receive(raw) {
    let message; try { message = JSON.parse(raw); } catch { this.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
    if (message.id != null && !message.method) {
      const p = this.pending.get(message.id); if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) { const error = new Error('Codex 拒绝了本次操作，请核对会话状态和版本兼容性。'); error.code = message.error.code; p.reject(error); }
      else p.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      // Decisions are made only at the computer. A mobile message never grants permissions.
      const entry = { id: message.id, method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId,
        params: message.params, command: message.params?.command || '', reason: message.params?.reason || '',
        respond: result => this.write({ id: message.id, result }),
        reject: (code = -32601, text = 'This client does not support the requested interaction.') => this.write({ id: message.id, error: { code, message: text } }) };
      this.emit('approval', entry); return;
    }
    const a = this.active;
    if (!a || message.params?.threadId !== a.threadId) return;
    if (!a.turnId) { a.buffer.push(message); return; }
    this.turnEvent(message);
  }
  turnEvent(message) {
    const a = this.active, p = message.params;
    if (!a || p?.threadId !== a.threadId || (p.turnId || p.turn?.id) !== a.turnId) return;
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'final_answer' && typeof p.item.text === 'string') a.finals.set(p.item.id, p.item.text);
    if (message.method === 'turn/completed') {
      this.active = null;
      if (p.turn?.status === 'completed') a.resolve([...a.finals.values()].join('\n\n'));
      else a.reject(new Error(p.turn?.status === 'interrupted' ? '本轮已停止，请在电脑端查看。' : '本轮未完成，请在电脑端查看原因。'));
    }
  }
  async readThread(threadId) { return (await this.request('thread/read', { threadId, includeTurns: false })).thread; }
  async runTurn(threadId, text, onAccepted = () => {}) {
    if (this.turnReserved || this.active) throw new Error('当前正在处理一条消息，请完成后再发送。');
    // Reserve before any asynchronous preflight. Two callers must never both
    // pass the status check and overwrite the active turn's reply collector.
    this.turnReserved = true;
    let active, accepted = false;
    try {
      const thread = await this.readThread(threadId);
      if (thread?.id !== threadId) throw new Error('会话身份不一致，请重新绑定。');
      if (statusOf(thread) === 'active') throw new Error('所选会话正在运行，请完成后再发送。');
      if (statusOf(thread) === 'systemError') throw new Error('所选会话暂不可用，请回电脑端处理。');
      const resumed = await this.request('thread/resume', { threadId, excludeTurns: true });
      if (resumed?.thread?.id !== threadId) throw new Error('恢复的会话身份不一致，未提交消息。');
      if (statusOf(resumed.thread) === 'active') throw new Error('所选会话正在运行，请完成后再发送。');
      if (statusOf(resumed.thread) === 'systemError') throw new Error('所选会话暂不可用，请回电脑端处理。');
      let resolve, reject; const done = new Promise((a, b) => { resolve = a; reject = b; }); done.catch(() => {});
      active = { threadId, turnId: null, finals: new Map(), buffer: [], resolve, reject }; this.active = active;
      const r = await this.request('turn/start', { threadId, input: [{ type: 'text', text }] });
      accepted = true;
      if (typeof r?.turn?.id !== 'string' || !r.turn.id) throw new Error('Codex 返回了无法识别的本轮回执，请回电脑核对。');
      active.turnId = r.turn.id; await onAccepted(r.turn.id);
      for (const message of active.buffer) this.turnEvent(message); active.buffer = [];
      return await done;
    } catch (error) {
      const e = error instanceof Error ? error : new Error('Codex 本轮结果无法确认，请回电脑核对。');
      // A failed local callback does not undo model work already accepted by
      // Codex. Keep that fact durable instead of permitting a retry as failure.
      if (accepted) e.unknown = true;
      throw e;
    } finally {
      if (active && this.active === active) this.active = null;
      this.turnReserved = false;
    }
  }
  lost() {
    this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); const e = new Error('Codex 连接中断，操作结果可能未确认，不会自动重发。'); e.unknown = true; p.reject(e); }
    this.pending.clear(); if (this.active) { const e = new Error('Codex 连接中断，请回电脑核对本轮结果。'); e.unknown = true; this.active.reject(e); this.active = null; }
    this.emit('disconnected');
  }
  close() {
    const transport = this.transport; this.transport = null; this.write = null;
    this.lost(); if (transport) { if (transport.terminate) transport.terminate(); else transport.kill(); }
  }
}
module.exports = { CodexConnection, safeEndpoint, statusOf };
