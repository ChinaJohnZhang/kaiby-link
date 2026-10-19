'use strict';

// Protocol reference: Tencent/openclaw-weixin 2.4.10 (MIT).
// This client has no OpenClaw runtime or model dependency.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const DEFAULT_API = 'https://ilinkai.weixin.qq.com';
const VERSION = '2.4.10';

function defaultDataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'kaiby-link');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kaiby-link');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'kaiby-link');
}

function privateMode(filename, mode) {
  try { fs.chmodSync(filename, mode); }
  catch (error) {
    // Windows ACLs are inherited from the user's profile. POSIX mode bits cannot
    // express that ACL; do not claim that chmod provides Windows isolation.
    if (process.platform !== 'win32' || !['EPERM', 'ENOSYS', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
  }
}

function apiOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !/(^|\.)weixin\.qq\.com$/.test(u.hostname)
    || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('拒绝移动通道返回的非预期服务地址');
  }
  return u.origin;
}

// Preserve uint64 message IDs without rewriting digits inside message text.
function parseJsonSafe(text) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (c === '-' || /\d/.test(c)) {
      const number = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!number) { out += c; continue; }
      const token = number[0];
      out += !/[.eE]/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
      i += token.length - 1;
    } else out += c;
  }
  return JSON.parse(out);
}

function bindingOf(auth) {
  return crypto.createHash('sha256').update(JSON.stringify([auth.owner, auth.bot, auth.token, auth.base])).digest('hex');
}

function freshState() { return { cursor: '', seen: [], messages: [] }; }
function validText(text) { return typeof text === 'string' && Boolean(text.trim()) && [...text].length <= 3800; }

class Channel {
  constructor({ directory = defaultDataDirectory(), fetcher = globalThis.fetch } = {}) {
    if (typeof fetcher !== 'function') throw new Error('需要 Node.js 20.19 或更新版本');
    this.directory = path.resolve(directory);
    this.fetcher = fetcher;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('数据目录不能是符号链接');
    privateMode(this.directory, 0o700);
  }
  filename(name) {
    if (typeof name !== 'string' || !name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw new Error('无效的状态文件名');
    return path.join(this.directory, name + '.json');
  }
  read(name, fallback = null) {
    const filename = this.filename(name);
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!fs.fstatSync(fd).isFile()) throw new Error('状态文件不是普通文件');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  save(name, value) {
    const destination = this.filename(name);
    const temp = destination + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      privateMode(temp, 0o600);
      fs.renameSync(temp, destination);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  auth() {
    const a = this.read('认证');
    if (!a?.token || !a?.owner || !a?.bot) throw new Error('尚未扫码绑定');
    apiOrigin(a.base);
    return a;
  }
  async request(endpoint, { base = DEFAULT_API, token, body, timeout = 35000, signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    requestSignal.throwIfAborted();
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(crypto.randomBytes(4).readUInt32BE())).toString('base64');
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    const response = await this.fetcher(apiOrigin(base) + '/' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: requestSignal,
    });
    if (!response.ok) throw new Error('移动通道 HTTP ' + response.status);
    const data = parseJsonSafe(await response.text());
    requestSignal.throwIfAborted();
    if ((data.ret != null && data.ret !== 0) || (data.errcode != null && data.errcode !== 0)) {
      throw new Error('移动通道业务错误 ' + (data.errcode || data.ret));
    }
    return data;
  }
  meta() { return { channel_version: VERSION, bot_agent: 'KaibyLink/0.1.0' }; }
  async beginLogin() {
    const data = await this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } });
    if (!data.qrcode || !data.qrcode_img_content) throw new Error('移动通道没有返回有效二维码');
    const qr = require('qrcode-generator')(0, 'M');
    qr.addData(data.qrcode_img_content); qr.make();
    this.save('登录中', { code: data.qrcode, base: DEFAULT_API, created: Date.now() });
    return { status: 'waiting', qrDataUrl: qr.createDataURL(7, 14), qrText: data.qrcode_img_content };
  }
  async loginStep(code) {
    const login = this.read('登录中');
    if (!login || Date.now() - login.created > 5 * 60000) throw new Error('二维码已过期，请重新生成');
    const data = await this.request('ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(login.code)
      + (code ? '&verify_code=' + encodeURIComponent(code) : ''), { base: login.base });
    if (data.status === 'scaned_but_redirect') {
      login.base = apiOrigin('https://' + data.redirect_host); this.save('登录中', login);
    }
    if (data.status === 'confirmed') {
      if (!data.bot_token || !data.ilink_user_id || !data.ilink_bot_id) throw new Error('绑定响应缺少账号归属，停止接入');
      const auth = { token: data.bot_token, owner: data.ilink_user_id, bot: data.ilink_bot_id,
        base: apiOrigin(data.baseurl || login.base) };
      this.update(state => {
        // Every confirmed binding starts with a fresh cursor and context. The new
        // owner must never receive text queued under an earlier binding.
        const replacement = { ...freshState(), binding: bindingOf(auth) };
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, replacement);
        this.save('认证', auth);
      });
      fs.rmSync(this.filename('登录中'), { force: true });
      return { status: 'confirmed', authenticated: true };
    }
    return { status: data.status };
  }
  state() {
    const state = this.read('收发', freshState());
    if (!state || typeof state.cursor !== 'string' || !Array.isArray(state.seen) || !Array.isArray(state.messages)) {
      throw new Error('收发状态损坏，停止处理以防重复发送');
    }
    return state;
  }
  update(change) {
    const lock = path.join(this.directory, '收发.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('收发状态正在更新，请稍后重试'); throw error; }
    try { const state = this.state(), result = change(state); this.save('收发', state); return result; }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  checkBinding(state, auth) {
    const binding = bindingOf(auth);
    if (bindingOf(this.auth()) !== binding || (state.binding && state.binding !== binding)) throw new Error('扫码账号已变化，请重新连接');
    state.binding = binding;
    return binding;
  }
  ingest(data, expectedAuth = this.auth()) {
    return this.update(state => {
      this.checkBinding(state, expectedAuth);
      let added = 0, backpressure = false;
      let active = state.messages.filter(message => ['pending', 'queued', 'processing'].includes(message.status)).length;
      for (const message of data.msgs || []) {
        if (message.from_user_id !== expectedAuth.owner || message.group_id || message.message_type !== 1
          || (message.to_user_id && message.to_user_id !== expectedAuth.bot)
          || (message.message_state != null && message.message_state !== 2)) continue;
        if (!message.message_id || (typeof message.message_id === 'number' && !Number.isSafeInteger(message.message_id))) continue;
        const id = String(message.message_id);
        if (state.seen.includes(id) || state.messages.some(message => message.id === id)) continue;
        const text = (message.item_list || []).filter(x => x.type === 1).map(x => x.text_item?.text || '').join('\n');
        if (!text || !message.context_token) continue;
        // Keep the old cursor when this batch does not fit yet. Admitted rows
        // remain durable, and seen IDs skip them when that cursor is pulled
        // again after the worker frees room. Backpressure is not a poll error.
        if (active >= 30) { backpressure = true; break; }
        state.messages.push({ id, text, context: message.context_token, status: 'pending', received: Date.now() });
        state.lastContext = message.context_token;
        state.seen.push(id); added++; active++;
      }
      // Do not discard replay deduplication until the entire cursor batch has
      // been admitted, even if a large batch needs several passes.
      if (!backpressure) state.seen = state.seen.slice(-2000);
      const recent = state.messages.filter(x => ['sent', 'handled', 'ignored'].includes(x.status)
        && x.received > Date.now() - 86400000).slice(-170);
      state.messages = state.messages.filter(x => !['sent', 'handled', 'ignored'].includes(x.status)).concat(recent);
      if (!backpressure && typeof data.get_updates_buf === 'string') state.cursor = data.get_updates_buf;
      return { received: added, pending: state.messages.filter(x => x.status === 'pending').length, ...(backpressure ? { backpressure: true } : {}) };
    });
  }
  async poll({ signal } = {}) {
    if (signal?.aborted) return { cancelled: true };
    const lock = path.join(this.directory, '接收.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('已有移动通道接收进程运行'); throw error; }
    try {
      const auth = this.auth();
      const data = await this.request('ilink/bot/getupdates', { base: auth.base, token: auth.token, signal,
        body: { get_updates_buf: this.state().cursor, base_info: this.meta() } });
      return this.ingest(data, auth);
    } catch (error) {
      if (signal?.aborted) return { cancelled: true };
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return { timeout: true };
      throw error;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  inbox() { return this.state().messages.filter(x => x.status === 'pending').map(({ id, text }) => ({ id, text })); }
  markHandled(id) {
    const auth = this.auth();
    this.update(state => {
      this.checkBinding(state, auth);
      const message = state.messages.find(x => x.id === id);
      if (!message) throw new Error('消息不存在');
      if (!['pending', 'processing', 'handled'].includes(message.status)) throw new Error('消息发送中或结果待核实，不能改为已处理');
      if (message.context) state.lastContext = message.context;
      message.status = 'handled'; delete message.text; delete message.context;
    });
  }
  async sendOwner(text, key) {
    if (!validText(text) || typeof key !== 'string' || !key.trim() || key.length > 256) throw new Error('发送内容或幂等键无效');
    const auth = this.auth();
    const intent = this.update(state => {
      const binding = this.checkBinding(state, auth);
      const context = state.lastContext || [...state.messages].reverse().find(x => x.context)?.context;
      if (!context) throw new Error('请先在移动端发送一条消息');
      state.outbound ||= {};
      if (Object.hasOwn(state.outbound, key)) throw new Error('消息已经发送或结果待核实，拒绝重复发送');
      const clientId = 'kaiby-' + crypto.randomUUID();
      Object.defineProperty(state.outbound, key, { enumerable: true, configurable: true, writable: true,
        value: { clientId, status: 'sending', at: Date.now() } });
      return { context, clientId, binding };
    });
    const finish = status => this.update(state => {
      if (state.binding !== intent.binding || state.outbound?.[key]?.clientId !== intent.clientId) {
        throw new Error('扫码账号或发送状态已变化，请核查发送结果');
      }
      state.outbound[key].status = status;
      // Unknown sends are never pruned or automatically replayed.
      for (const [name, value] of Object.entries(state.outbound)) {
        if (value.status === 'sent' && value.at < Date.now() - 86400000) delete state.outbound[name];
      }
    });
    try { await this.sendText(auth, text, intent); }
    catch (error) { finish('unknown'); throw error; }
    finish('sent');
    return { sent: true };
  }
  async sendText(auth, text, { context, clientId }) {
    return this.request('ilink/bot/sendmessage', { base: auth.base, token: auth.token, body: {
      msg: { from_user_id: '', to_user_id: auth.owner, client_id: clientId, message_type: 2,
        message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }] }, base_info: this.meta(),
    } });
  }
  async reply(id, text) {
    if (!validText(text)) throw new Error('回复须为非空文本且不超过3800字');
    const auth = this.auth();
    const message = this.update(state => {
      const binding = this.checkBinding(state, auth);
      const row = state.messages.find(x => x.id === id);
      if (!row || row.status !== 'pending') throw new Error('消息不存在、已回复或发送结果待核实；拒绝重复发送');
      row.status = 'sending'; row.clientId = 'kaiby-' + crypto.randomUUID();
      return { ...row, binding };
    });
    const settle = status => this.update(state => {
      const row = state.messages.find(x => x.id === id);
      if (state.binding !== message.binding || !row || row.clientId !== message.clientId || row.status !== 'sending') {
        throw new Error('扫码账号或发送状态发生变化，请核查发送结果');
      }
      row.status = status;
      if (status === 'sent') { delete row.text; delete row.context; }
    });
    try { await this.sendText(auth, text, message); }
    catch (error) { settle('unknown'); throw error; }
    settle('sent');
    return { sent: true };
  }
}

module.exports = { Channel, WeixinProbe: Channel, parseJsonSafe, apiOrigin, defaultDataDirectory };
