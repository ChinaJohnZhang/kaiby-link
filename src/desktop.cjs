'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const APP_TOOLS = new Set(['list_threads', 'read_thread', 'send_message_to_thread']);
const MAX_FRAME = 8 * 1024 * 1024;
const ITEM_LIMIT = 20000;
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
function failure(message, unknown = false) { const error = new Error(message); if (unknown) error.unknown = true; return error; }

// `metadata` is the executor's actual MCP request _meta, supplied by the local
// plugin handler. Never populate it from HTTP fields or from a mobile message.
// A standalone download cannot invent a caller and thereby become a desktop host.
function sourceOf(metadata, env = process.env) {
  let turn = metadata?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { return null; } }
  const threadId = turn?.thread_id ?? metadata?.['openai/threadId'] ?? metadata?.['openai/thread_id'] ?? env.CODEX_THREAD_ID;
  const turnId = turn?.turn_id ?? metadata?.['openai/turnId'] ?? metadata?.['openai/turn_id'];
  if (!validId(threadId) || (turnId != null && !validId(turnId))) return null;
  // Metadata and a real executor environment must not disagree about the caller.
  if (env.CODEX_THREAD_ID && threadId !== env.CODEX_THREAD_ID) return null;
  return Object.freeze({ kind: 'codex-mcp', threadId, ...(turnId ? { turnId } : {}), hostId: env.CODEX_APP_TOOLS_CALLER_HOST_ID || 'local' });
}

function discoverDesktopRuntime(env = process.env) {
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw failure('请先在 Codex 中启用连接器插件；独立窗口尚未接入桌面宿主。');
  const nodePath = env.CODEX_MCP_NODE_PATH || env.CODEX_BROWSER_USE_NODE_PATH;
  if (!nodePath || !path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) throw failure('Codex 尚未提供插件运行环境，请刷新插件后重试。');
  const roots = [];
  if (env.CODEX_ELECTRON_RESOURCES_PATH) roots.push(env.CODEX_ELECTRON_RESOURCES_PATH);
  let parent = path.dirname(nodePath);
  for (let n = 0; n < 6; n++, parent = path.dirname(parent)) if (path.basename(parent).toLowerCase() === 'resources') roots.push(parent);
  const candidates = roots.map(root => path.join(root, 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools', 'server.mjs'));
  const cache = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  try { for (const version of fs.readdirSync(cache).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(path.join(cache, version, 'server.mjs')); } catch {}
  const serverPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!serverPath) throw failure('未找到 Codex 自带的桌面工具插件，请更新或修复 Codex。');
  // The helper and runtime remain the application's own files. Its OS peer
  // authorization is left intact; no socket scanning, replacement or fallback.
  return { nodePath, serverPath };
}

function unpack(result, allowText = false) {
  if (!result || result.isError) throw failure('Codex 拒绝了桌面操作，请在电脑端检查权限和会话状态。');
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { if (allowText && text) return { accepted: true }; }
  throw failure('Codex 返回的桌面数据不完整，请更新连接器或 Codex。');
}
function statusOf(thread) {
  const status = typeof thread?.status === 'string' ? thread.status : thread?.status?.type;
  return ['running', 'inProgress', 'in_progress', 'waitingForApproval', 'waiting_for_approval'].includes(status) ? 'active' : status || 'notLoaded';
}
function textOf(item) {
  if (!Array.isArray(item?.content)) return null;
  const blocks = item.content.filter(block => block.type === 'text' && typeof block.text === 'string');
  return blocks.length ? blocks.map(block => block.text).join('\n') : null;
}
// This is the desktop's original delegation serializer (app-shared ZSr/$Sr).
// Compare the entire escaped envelope instead of parsing XML or searching for
// an input substring: user text may itself contain closing and nested tags.
function delegationEnvelope(sourceThreadId, input) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return ['<codex_delegation>', `  <source_thread_id>${escape(sourceThreadId)}</source_thread_id>`, `  <input>${escape(input)}</input>`, '</codex_delegation>'].join('\n');
}
function delegatedInput(item, envelope) {
  if (item?.type === 'functionCallOutput') return item.namespace === 'codex_app' && item.name === 'send_message_to_thread' &&
    item.output?.truncated === false && item.output.text === envelope;
  // Older desktop versions submit the identical escaped envelope as text.
  return item?.type === 'userMessage' && textOf(item) === envelope && !truncated(item);
}
function conversationInput(item) {
  if (item.type === 'userMessage') return true;
  return item.type === 'functionCallOutput' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread' &&
    typeof item.output?.text === 'string' && item.output.text.startsWith('<codex_delegation>\n  <source_thread_id>') && item.output.text.endsWith('</input>\n</codex_delegation>');
}
function publicReply(turn, oldItems, inputIndex) {
  const afterInput = turn.items.slice(inputIndex + 1);
  const nextInput = afterInput.findIndex(conversationInput);
  const ownSegment = nextInput === -1 ? afterInput : afterInput.slice(0, nextInput);
  const finals = ownSegment.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string' && validId(item.id) && !oldItems.has(item.id));
  if (finals.some(truncated)) throw failure('本轮回复已被桌面读取接口截断，请回 Codex 查看完整内容。', true);
  if (!finals.length && nextInput !== -1) throw failure('本次输入之后又有其他输入，回复对应关系无法确认，请回 Codex 核对。', true);
  if (!finals.length) return null;
  return finals.map(item => item.text).join('\n\n');
}
function truncated(item) {
  return item?.truncated === true || item?.isTruncated === true || item?.textTruncated === true ||
    typeof item?.text === 'string' && (item.text.length >= ITEM_LIMIT || /\[(?:[^\]\n]{0,50})truncat(?:ed|ion)[^\]\n]*\]|<truncated>|内容已截断|输出已截断/i.test(item.text));
}
function snapshot(data, threadId) {
  if (data?.thread?.id !== threadId || !Array.isArray(data.turns)) throw failure('会话身份不一致或历史不完整，未转发回复。');
  const turns = data.turns;
  for (const turn of turns) if (!validId(turn.id) || !Array.isArray(turn.items)) throw failure('Codex 本轮历史不完整，请回电脑端核对。');
  // read_thread must include outputs to correlate a desktop delegation. Keep
  // only that exact tool's bounded text in memory; all other tool output,
  // reasoning, progress and tool arguments are discarded at this boundary.
  const filtered = turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items.flatMap(item => {
    if (item.type === 'userMessage') return [{ id: item.id, type: item.type, content: item.content, truncated: item.truncated, isTruncated: item.isTruncated }];
    if (item.type === 'agentMessage' && item.phase === 'final_answer') return [{ id: item.id, type: item.type, phase: item.phase, text: item.text, truncated: item.truncated, isTruncated: item.isTruncated, textTruncated: item.textTruncated }];
    if (item.type === 'functionCallOutput' && item.name === 'send_message_to_thread' && item.namespace === 'codex_app') return [{ id: item.id, type: item.type, name: item.name, namespace: item.namespace, output: { text: item.output?.text, truncated: item.output?.truncated } }];
    return [];
  }) }));
  return { thread: { ...data.thread, status: statusOf(data.thread) }, turns: filtered, page: data.page };
}

class DesktopConnection extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.env = options.env || process.env;
    this.source = sourceOf(options.metadata, this.env);
    this.ready = !!(this.source && this.env.CODEX_APP_TOOLS_PIPE_PATH && (this.env.CODEX_MCP_NODE_PATH || this.env.CODEX_BROWSER_USE_NODE_PATH));
    this.unavailableReason = !this.source ? '请先从 Codex 中启用连接器插件，尚未取得真实会话调用来源。' : !this.ready ? '连接器尚未接入 Codex 插件宿主，请在 Codex 中启用。' : null;
    this.connected = false; this.sequence = 0; this.pending = new Map(); this.destinations = new Map(); this.turnReserved = false;
    this.unknownSubmission = null; this.unknownSubmissions = new Map();
  }
  async connect() {
    if (this.connected) return;
    if (!this.ready) throw failure(this.unavailableReason);
    if (this.transport) throw failure('正在连接 Codex，请稍后。');
    try {
      const runtime = (this.options.discover || discoverDesktopRuntime)(this.env);
      const child = (this.options.spawn || spawn)(runtime.nodePath, [runtime.serverPath], { cwd: path.dirname(runtime.serverPath), env: { ...this.env, CODEX_APP_TOOLS_DEFERRED: '0' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.transport = child; this.buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.transport !== child) return;
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.close(); return; }
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) { const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (line.trim()) this.receive(line); }
      });
      child.stderr.resume();
      const lost = () => { if (this.transport === child) this.close(); };
      child.on('exit', lost); child.on('error', lost); child.stdin.on('error', lost);
      await this._rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'kaiby_link', title: 'Kaiby Link', version: '0.1.0' } });
      this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const catalog = await this._rpc('tools/list', {});
      if (![...APP_TOOLS].every(name => catalog.tools?.some(tool => tool.name === name))) throw failure('当前 Codex 缺少连接器所需的桌面工具，请更新 Codex。');
      this.connected = true;
    } catch (error) { this.close(); throw error; }
  }
  _write(message) { if (!this.transport?.stdin?.writable) throw failure('Codex 桌面连接已关闭。'); this.transport.stdin.write(JSON.stringify(message) + '\n'); }
  _rpc(method, params, mutation = false) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('Codex 操作结果未确认，请回电脑核对；不会自动重发。', mutation)); }, this.options.timeout || 15000);
      this.pending.set(id, { resolve, reject, timer, mutation });
      try { this._write({ jsonrpc: '2.0', id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(failure('Codex 连接已中断，操作结果未确认；不会自动重发。', mutation)); }
    });
  }
  receive(raw) {
    let message; try { message = JSON.parse(raw); } catch { this.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
    if (message.method) {
      // This adapter never answers approval or elicitation requests on behalf of
      // the user. The real desktop remains responsible for those interactions.
      if (message.id != null) try { this._write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Handle this interaction in the desktop application.' } }); } catch {}
      return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error) { const error = failure('Codex 拒绝了本次桌面操作，请回电脑端检查。'); error.code = message.error.code; pending.reject(error); }
    else if (!Object.hasOwn(message, 'result')) { pending.reject(failure('Codex 操作回执不完整，请回电脑核对。', pending.mutation)); }
    else pending.resolve(message.result);
  }
  async _tool(name, args) {
    if (!APP_TOOLS.has(name)) throw failure('连接器不允许调用这项桌面操作。');
    if (!this.connected || !this.source) throw failure('Codex 桌面尚未连接。');
    const meta = { 'openai/threadId': this.source.threadId, ...(this.source.turnId ? { 'openai/turnId': this.source.turnId } : {}) };
    const result = await this._rpc('tools/call', { name, arguments: args, _meta: meta }, name === 'send_message_to_thread');
    return unpack(result, name === 'send_message_to_thread');
  }
  async request(method, params = {}) {
    if (method === 'thread/read') return { thread: await this.readThread(params.threadId) };
    if (method !== 'thread/list') throw failure('连接器只提供会话列表、读取与已绑定会话聊天。');
    if (params.cursor) throw failure('桌面工具暂不支持继续分页，请在 Codex 中查找目标会话。');
    const result = await this._tool('list_threads', { limit: Math.min(50, Math.max(1, Number(params.limit) || 50)) });
    const rows = [...(result.pinnedThreads || []), ...(result.threads || [])], seen = new Set(), data = [];
    for (const thread of rows) {
      if (thread.kind !== 'codex' || !validId(thread.id)) continue;
      const hostId = thread.hostId || 'local', key = `${hostId}:${thread.id}`;
      if (seen.has(key)) continue; seen.add(key);
      const hosts = this.destinations.get(thread.id) || new Set(); hosts.add(hostId); this.destinations.set(thread.id, hosts);
      data.push({ ...thread, name: thread.title || '未命名会话', status: statusOf(thread), hostId });
    }
    return { data, nextCursor: null };
  }
  _host(threadId) {
    if (!validId(threadId)) throw failure('请指定有效的已有会话 ID。');
    const hosts = this.destinations.get(threadId);
    if (hosts?.size > 1) throw failure('不同设备存在同名会话标识，请在 Codex 中核对后重新绑定。');
    return hosts ? [...hosts][0] : 'local';
  }
  async _read(threadId) {
    const data = await this._tool('read_thread', { threadId, hostId: this._host(threadId), turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: ITEM_LIMIT });
    return snapshot(data, threadId);
  }
  async readThread(threadId) { return (await this._read(threadId)).thread; }
  // Explicit reconciliation only. This reads a known completed turn, verifies
  // its full original input/source envelope, and never sends or clears the
  // durable unknown submission. The caller records delivery separately.
  async recoverTurn(threadId, turnId, text) {
    if (!validId(turnId) || typeof text !== 'string' || !text.trim() || text.length > 16000 || !this.source) throw failure('请指定已提交回合的真实 ID 和完整原始输入。');
    const data = await this._read(threadId), turn = data.turns.find(item => item.id === turnId);
    if (!turn || turn.status !== 'completed') throw failure('未找到指定的已完成回合，请在 Codex 中核对。');
    const envelope = delegationEnvelope(this.source.threadId, text);
    const inputs = turn.items.flatMap((item, index) => validId(item.id) && delegatedInput(item, envelope) ? [index] : []);
    if (inputs.length !== 1) throw failure('指定回合的原始输入或调用来源不匹配，未恢复回复。');
    const reply = publicReply(turn, new Set(), inputs[0]);
    if (reply == null) throw failure('指定输入之后尚无可确认的最终回复，请在 Codex 中核对。');
    return reply;
  }
  async runTurn(threadId, text, onAccepted = () => {}, { requestId } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw failure('请发送不超过 16000 字的文字消息。');
    if (requestId != null && (typeof requestId !== 'string' || !requestId || requestId.length > 512)) throw failure('消息 ID 无效。');
    // Real inbound IDs isolate retries even when two messages have identical
    // text. Direct callers without an ID conservatively identify the same
    // request by destination + full text, never by the whole destination alone.
    const submissionKey = crypto.createHash('sha256').update(JSON.stringify(requestId == null ? ['text', threadId, text] : ['request', requestId])).digest('hex');
    if (this.unknownSubmissions.has(submissionKey)) throw failure('这条消息已经提交，不会重复发送；你可以继续发送新消息。', true);
    if (this.turnReserved) throw failure('当前正在处理一条消息，请完成后再发送。');
    this.turnReserved = true;
    let dispatched = false;
    const controller = new AbortController(); this.activeController = controller;
    try {
      const before = await this._read(threadId);
      if (statusOf(before.thread) === 'systemError') throw failure('所选会话暂不可用，请回电脑端处理。');
      const oldItems = new Set(before.turns.flatMap(turn => turn.items.map(item => item.id)).filter(Boolean));
      const envelope = delegationEnvelope(this.source.threadId, text);
      if (envelope.length >= ITEM_LIMIT) throw failure('本条文字转义后超出桌面读取上限，请缩短后发送。');
      dispatched = true;
      const receipt = await this._tool('send_message_to_thread', { threadId, hostId: this._host(threadId), prompt: text });
      if (receipt.threadId != null && receipt.threadId !== threadId) throw failure('Codex 返回的提交会话身份不一致，请回电脑核对。', true);
      let turnId = receipt.turnId ?? receipt.turn?.id ?? null;
      const userId = receipt.userMessageId ?? receipt.userMessage?.id ?? null;
      if (turnId != null && !validId(turnId)) throw failure('Codex 返回的本轮回执无法确认，请回电脑核对。', true);
      let announced = false, matchedInputId = null;
      const deadline = Date.now() + (this.options.turnTimeout || 15 * 60 * 1000);
      while (Date.now() < deadline) {
        if (controller.signal.aborted || !this.connected) throw failure('Codex 桌面已断开，请回电脑端核对本轮结果。', true);
        const after = await this._read(threadId);
        const matches = after.turns.flatMap(turn => turn.items.flatMap((item, index) => validId(item.id) && !oldItems.has(item.id) &&
          (!userId || item.id === userId) && delegatedInput(item, envelope) ? [{ turn, index, inputId: item.id }] : []));
        if (matches.length > 1) throw failure('出现多条相同输入，本轮对应关系无法确认，请回电脑核对。', true);
        const match = matches[0];
        if (match && (turnId && match.turn.id !== turnId || matchedInputId && match.inputId !== matchedInputId)) throw failure('Codex 本轮输入和回执不一致，请回电脑核对。', true);
        if (match) { turnId = match.turn.id; matchedInputId = match.inputId; }
        // An existing active turn may receive this exact input as steering.
        // Even an explicit receipt must be proven by its new input item before
        // any final from that turn can be attributed to this mobile message.
        const turn = match?.turn;
        if (turn && !announced) { announced = true; await onAccepted(turnId); }
        if (turn?.status === 'completed') {
          const reply = publicReply(turn, oldItems, match.index);
          if (reply != null) return reply;
        }
        if (turn && ['failed', 'interrupted', 'cancelled'].includes(turn.status)) throw failure('本轮未完成，请回 Codex 查看原因。', true);
        await delay(this.options.pollInterval ?? 1500, undefined, { signal: controller.signal });
      }
      throw failure('等待本轮回复超时，请回 Codex 核对；不会自动重发。', true);
    } catch (error) {
      const result = error?.name === 'AbortError' ? failure('Codex 桌面连接已停止，请回电脑核对本轮结果。') : error instanceof Error ? error : failure('本轮结果无法确认，请回电脑核对。');
      if (dispatched) {
        result.unknown = true;
        this.unknownSubmission = { threadId, submissionKey, ...(requestId == null ? {} : { requestId }) };
        this.unknownSubmissions.set(submissionKey, this.unknownSubmission);
      }
      throw result;
    } finally { if (this.activeController === controller) this.activeController = null; this.turnReserved = false; }
  }
  close() {
    const child = this.transport; this.transport = null; const wasConnected = this.connected; this.connected = false;
    this.activeController?.abort();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure('Codex 桌面连接已中断，请回电脑核对；不会自动重发。', entry.mutation)); }
    this.pending.clear();
    if (child) { try { child.kill(); } catch {} }
    if (wasConnected || child) this.emit('disconnected');
  }
}

module.exports = { DesktopConnection, sourceOf, discoverDesktopRuntime };
