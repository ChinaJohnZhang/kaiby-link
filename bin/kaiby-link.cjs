#!/usr/bin/env node
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { Channel } = require('../src/channel.cjs');
const { Link } = require('../src/link.cjs');

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    thread: { type: 'string' }, endpoint: { type: 'string' }, mode: { type: 'string', default: 'websocket' },
    'codex-path': { type: 'string' }, 'codex-home': { type: 'string' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('开摆连接器 · 开源版\nhttps://kaibyai.com\n\nlogin    生成扫码二维码并等待绑定\nrun      连接固定会话，必填 --thread\ncheck    只读检查指定会话连接\nstatus   查看扫码状态\n\n连接现有服务器：--endpoint ws://127.0.0.1:端口\n连接已有共享服务：--mode proxy --codex-path 原生CLI路径\n可选：--codex-home 资料目录 --data-dir 本工具资料目录\n\n不自动接管未开放连接的桌面实例，不创建新会话。'); return;
  }
  const channel = new Channel({ directory: values['data-dir'] });
  if (command === 'status') { console.log(JSON.stringify({ authenticated: Boolean(channel.read('认证')?.token) })); return; }
  if (command === 'login') {
    const result = await channel.beginLogin(); const qr = require('qrcode-generator')(0, 'M'); qr.addData(result.qrText); qr.make();
    console.log(qr.createASCII()); console.log('请用移动端扫码。二维码仅用于本次绑定，不要转发。');
    const deadline = Date.now() + 5 * 60000;
    while (Date.now() < deadline) { const state = await channel.loginStep(); if (state.authenticated) { console.log('绑定成功。'); return; } if (['expired', 'canceled'].includes(state.status)) break; await delay(1500); }
    throw new Error('二维码已过期，请重新运行 login。');
  }
  if (!['run', 'check'].includes(command)) throw new Error('未知命令，请运行 --help 查看用法。');
  const link = new Link({ channel, codex: { mode: values.mode, endpoint: values.endpoint, cliPath: values['codex-path'], codexHome: values['codex-home'] } });
  link.on('approval', request => {
    console.error('本轮需要在电脑端处理权限或输入请求，移动端不会自动批准。');
    // A minimal client safely declines requests it cannot present. It never weakens Codex policy.
    if (request.method.includes('requestApproval')) request.respond(request.method.includes('permissions') ? { permissions: {} } : { decision: 'decline' });
    else if (request.method.includes('requestUserInput')) request.respond({ answers: {} });
    else if (request.method === 'mcpServer/elicitation/request') request.respond({ action: 'decline', content: null });
    else request.reject(-32601, '此客户端不支持该交互请求。');
  });
  await link.select(values.thread);
  console.log('已连接：' + link.selected.title);
  if (command === 'check') { await link.stop(); return; }
  await link.start(); console.log('连接器已运行。退出请按 Ctrl+C。');
  const stop = () => { link.stop().finally(() => process.exit(0)); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await link.loop;
}
if (require.main === module) main().catch(() => { console.error('操作未完成。请核对扫码、会话 ID、现有 Codex 连接入口及兼容版本；不会自动重发消息。'); process.exitCode = 1; });
module.exports = { main };
