<p align="center">
  <a href="https://kaibyai.com"><img src="docs/assets/kaiby-ai-logo.png" width="96" height="96" alt="开摆 AI" /></a>
</p>

<h1 align="center">开摆连接器 · Kaiby Link</h1>

<p align="center"><strong>手机发消息，Codex 接着干。</strong><br />离开电脑，也能继续桌面里的对话。</p>

<p align="center">
  <a href="https://kaibyai.com"><strong>体验开摆 AI</strong></a> ·
  <a href="https://kaibyai.com/kaibyx"><strong>下载开摆 X</strong></a> ·
  <a href="https://github.com/ChinaJohnZhang/kaiby-link/releases">下载连接器</a>
</p>

## 开摆 AI：想象尽管放开，剩下的开摆。

从图片、视频创作，到电脑上的复杂工作，**开摆 AI 让灵感成为作品，让想法变成行动。**

| 产品 | 帮你做什么 | 为什么用它 |
| --- | --- | --- |
| **[开摆造物](https://kaibyai.com/kaibyai)** | 图片创作、视频生成、素材与灵感 | 一句描述展开画面，从图片到视频，在同一个创作空间完成 |
| **[开摆 X](https://kaibyai.com/kaibyx)** | 理解项目、处理文件、研究信息、调用工具、执行多步任务 | 项目、文件和工具连接起来；多种模型按任务选择，按量付费，无需订阅，用量和账单随时可查 |

**一个客户端，使用开摆造物与开摆 X。** 创作与工作自在切换，账号共用，账目清楚。

### [前往开摆 AI →](https://kaibyai.com)　[了解开摆 X →](https://kaibyai.com/kaibyx)　[下载客户端 →](https://kaibyai.com/download)

## 连接器能做什么

- 扫码绑定，手机文字消息进入你选择的 Codex 会话。
- 继续桌面里的工作，收到对应回复；长文自动分段。
- 连续补充消息，AI 工作中也能接收，进展和结果随时回到手机；收发记录自动保存、去重。
- 发送 `帮助` 查看用法，发送 `状态` 查看连接情况。
- 保存账号绑定，后续启动继续使用。
- Mac、Windows 双端使用。

**下载便携包，打开网页就能设置。** 在手机上发送 `会话`，按回复中的序号切换聊天；图片、视频直接在聊天中查看，普通文件作为附件收发。手机发来的图片、视频和文件会保存到本机，交给 Codex 继续处理。AI 也可以主动向手机发送进展、结果和附件。

使用时保持电脑在线、Codex 打开。需要权限确认的操作在 Codex 中处理。

## 快速开始

### 下载便携包

到 [Releases](https://github.com/ChinaJohnZhang/kaiby-link/releases) 下载对应系统的 ZIP，完整解压后双击：

- **Mac**：`启动开摆连接器.command`
- **Windows**：`启动开摆连接器.cmd`

浏览器会自动打开设置页。点击「连接 Codex」，按提示启用扩展，扫码、选择会话，然后开始连接。运行环境随包提供。

### 从源码运行

源码示例演示扫码绑定、固定会话转发和文字回复，供开发者继续扩展。

准备 Node.js 20.19 或更新版本，以及支持 WebSocket 或共享服务代理的 Codex 连接入口。

```sh
git clone https://github.com/ChinaJohnZhang/kaiby-link.git
cd kaiby-link
npm ci
node bin/kaiby-link.cjs login
```

扫码后，填入已有会话 ID 和连接地址：

```sh
node bin/kaiby-link.cjs check --thread YOUR_THREAD_ID --endpoint ws://127.0.0.1:YOUR_PORT
node bin/kaiby-link.cjs run --thread YOUR_THREAD_ID --endpoint ws://127.0.0.1:YOUR_PORT
```

运行 `node bin/kaiby-link.cjs --help` 查看共享服务代理等参数。

**让 AI 帮你部署：** 把项目链接交给 AI，并让它先读 [AGENTS.md](AGENTS.md)。环境识别、安装、诊断和收发验证交给 AI，你负责扫码和选择会话。

## 开发与许可

```sh
npm test
```

源码采用 [MIT](LICENSE) 许可。依赖与协议参考见 [第三方声明](THIRD_PARTY_NOTICES.md)。

---

**[开摆 AI](https://kaibyai.com) · [开摆造物](https://kaibyai.com/kaibyai) · [开摆 X](https://kaibyai.com/kaibyx)**<br />
把时间，留给更值得的事。
