#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { Channel } = require('../src/channel.cjs');
const { Link } = require('../src/link.cjs');

// The desktop starts this server through its normal MCP configuration. Caller
// context comes from the executor's tool request, never from mobile input.
async function serve(options = {}) {
  const input = options.input || process.stdin, output = options.output || process.stdout;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const inFlight = new Set();
  let link, starting = false, ending = false, closing, initialized = false;
  const reply = value => { if (!output.destroyed && output.writable !== false) output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  function close() {
    if (closing) return closing;
    ending = true; lines.close();
    closing = (async () => {
      await Promise.allSettled([link?.stop(), ...inFlight]);
      // Startup may finish a pending select after the first stop. Its own
      // ending check disposes that generation before shutdown can resolve.
      await link?.stop();
    })();
    return closing;
  }
  async function handle(request) {
    const id = request?.id;
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (id != null && !(typeof id === 'string' || typeof id === 'number' && Number.isFinite(id)))) {
      return reply({ id: null, error: { code: -32600, message: 'Invalid request' } });
    }
    if (id == null) return;
    if (request.method === 'initialize') {
      if (initialized || ending) return reply({ id, error: { code: -32600, message: 'Already initialized or shutting down' } });
      initialized = true;
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const protocolVersion = supported.includes(request.params?.protocolVersion) ? request.params.protocolVersion : supported[0];
      return reply({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kaiby-link', version: '0.1.0' } } });
    }
    if (request.method === 'ping') return reply({ id, result: {} });
    if (!initialized || ending) return reply({ id, error: { code: -32600, message: 'Not initialized or shutting down' } });
    if (request.method === 'tools/list') return reply({ id, result: { tools: [{ name: 'start_kaiby_link', description: '启动开摆连接器开源版。用户须先在命令行扫码，并明确指定一个已有 Codex 会话 ID。仅转发该会话的文字和最终回复。', inputSchema: { type: 'object', properties: { threadId: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['threadId'], additionalProperties: false } }] } });
    if (request.method !== 'tools/call' || request.params?.name !== 'start_kaiby_link') return reply({ id, error: { code: -32601, message: 'Unknown method or tool' } });
    let acquired = false, created;
    try {
      if (ending || starting || link?.running) throw new Error('连接器已在运行或正在启动。请先停止原连接器。');
      starting = true; acquired = true;
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'threadId') || typeof args.threadId !== 'string' || args.threadId !== args.threadId.trim() || !args.threadId || args.threadId.length > 200) throw new Error('请手动指定一个已有会话 ID。');
      const { DesktopConnection } = require('../src/desktop.cjs');
      const connectionOptions = { metadata: request.params._meta };
      const connection = options.createConnection ? options.createConnection(connectionOptions) : new DesktopConnection(connectionOptions);
      const channel = options.channel || new Channel({ directory: process.env.KAIBY_LINK_DATA_DIR });
      channel.auth();
      created = options.createLink ? options.createLink({ channel, connection }) : new Link({ channel, connection }); link = created;
      await created.select(args.threadId);
      if (ending) throw new Error('扩展已停止。');
      await created.start();
      if (ending) { await created.stop(); throw new Error('扩展已停止。'); }
      reply({ id, result: { content: [{ type: 'text', text: '开摆连接器已启动，已固定绑定指定的已有会话。电脑和此扩展保持运行时，可从本人移动聊天发送文字。' }] } });
    } catch (error) {
      // A rejected concurrent call does not own the current generation.
      if (created) { await created.stop(); if (link === created) link = null; }
      reply({ id, result: { isError: true, content: [{ type: 'text', text: '连接器未启动。请核对命令行扫码、已有会话 ID，以及当前桌面是否提供本地工具；没有重发消息。' }] } });
    } finally { if (acquired) starting = false; }
  }
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 1024 * 1024) { void close(); return; }
    let request; try { request = JSON.parse(line); } catch { reply({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    const task = handle(request).catch(() => reply({ id: request?.id ?? null, error: { code: -32603, message: 'Request failed' } })).finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
  input.once('end', () => void close());
  input.once('error', () => void close());
  return { close };
}
if (require.main === module) {
  serve().then(server => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().finally(() => process.exit(0)));
  }).catch(() => { process.stderr.write('开摆连接器扩展未能启动。\n'); process.exitCode = 1; });
}
module.exports = { serve };
