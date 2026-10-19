# 开摆连接器 · Kaiby Link

让移动聊天里的文字消息进入一个指定的 Codex 会话，并返回本轮最终回复。

[开摆AI官网](https://kaibyai.com) · [基础版免安装包](https://github.com/ChinaJohnZhang/kaiby-link/releases)

这个公开仓库提供 MIT 许可的**开源命令行版**。带本机浏览器配置页面的**基础版**只在 Releases 分发免安装 ZIP，界面和增强模块不属于本仓库的开源许可。开摆X的完整集成功能单独提供。

## 当前兼容范围

本项目为早期预览版。支持连接**已经存在、由用户使用的 Codex app-server**：

- 已开放本机 WebSocket 入口的 Codex 服务。
- 已运行共享 daemon、原生 CLI 支持 `codex app-server proxy` 的环境。

**普通 Codex 桌面实例若只使用私有 stdio 连接，当前不能直接附加。** 安装 Codex 桌面应用并不等于存在上述入口。连接失败时本工具会停止，不会另起 app-server、另建会话或调用 `exec resume` 冒充已接入原桌面。该兼容限制同样适用于基础版免安装包。

Mac 与 Windows 使用同一套 Node.js 程序；真实桌面接入取决于各自 Codex 版本和连接方式。免安装包、平台测试与实际通道验证范围以每次 Release 说明为准。

基础版下载对应系统的 ZIP 后解压：Mac 双击 `启动开摆连接器.command`，Windows 双击 `启动开摆连接器.cmd`，会自动打开本机浏览器设置页。包内附带运行环境，无需安装向导或另装 Node。结束时可按 Ctrl+C，或在页面选择“退出程序”。

## 开源版功能

- 扫码绑定一个移动账号，只接收扫码本人私聊中的文字。
- 手动指定一个已有 Codex 会话 ID，固定转发文字。
- 本轮结束后返回公开最终回复；长回复分段发送。
- `帮助`、`状态` 两个关键词。
- 消息去重、发送前记录意图，未知结果不自动重发。

开源版不提供图形设置、会话列表、搜索、切换、新建、历史查询、文件、语音或远程审批。连接器运行期间电脑需要保持在线。

## 使用

需要 Node.js 20.19 或更新版本，以及上面列出的现有 Codex 连接入口。

```sh
git clone https://github.com/ChinaJohnZhang/kaiby-link.git
cd kaiby-link
npm ci
node bin/kaiby-link.cjs login
```

扫码后，在自己的 Codex 中取得已有会话 ID，先做不发模型消息的连接检查：

```sh
node bin/kaiby-link.cjs check --thread YOUR_THREAD_ID --endpoint ws://127.0.0.1:YOUR_PORT
```

检查成功后启动固定会话转发：

```sh
node bin/kaiby-link.cjs run --thread YOUR_THREAD_ID --endpoint ws://127.0.0.1:YOUR_PORT
```

已有共享 daemon 的环境可以使用：

```sh
node bin/kaiby-link.cjs run --thread YOUR_THREAD_ID --mode proxy --codex-path /path/to/native/codex
```

Windows 的 `--codex-path` 指向原生 `codex.exe`，路径包含空格时使用引号；不使用 `codex.cmd`。可选 `--codex-home` 指定与目标服务一致的资料目录。工具不会替用户安装、启动或重启共享 daemon。

远程入口只接受 `wss://`，认证凭据通过 `KAIBY_LINK_CODEX_TOKEN` 环境变量传入；不要把密钥放进连接 URL。用 `--data-dir` 可以指定本工具资料目录。默认资料目录位于当前系统用户的数据目录，不能提交到 Git。

按 Ctrl+C 正常退出。若异常退出留下锁文件，请先确认原连接器已结束，再处理对应数据目录中的锁；不要删除认证、收发账本或未知发送记录来重试消息。

## 权限、数据与恢复

模型访问与费用沿用用户的 Codex 账号和配置，本工具不提供模型额度。移动消息不会自动批准命令、文件或网络权限；最小客户端无法呈现的交互请求会安全拒绝，相关任务可能无法继续，需要回到原客户端处理。

认证与必要的去重账本保存在本机用户数据目录，POSIX 使用受限文件权限，Windows 使用用户资料目录继承的访问权限。当前开源预览版不宣称提供系统保险库加密。不转发推理、工具输出或进度消息。公开源码、程序包和测试资料不包含实际绑定认证或用户会话正文。

发送结果不明时不会自动重试。请先在 Codex 与移动端核对消息，再处理未决任务；避免重复触发模型或工具操作。

## 开发与许可

```sh
npm test
```

自动测试使用隔离的模拟协议响应，不代表某个真实账号或桌面版本已经完成端到端验证。平台构建与测试状态见 Actions 和 Releases。

源码按 [MIT](LICENSE) 许可发布。协议参考与依赖归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。产品名称不表示腾讯或 OpenAI 官方授权、隶属或背书。
