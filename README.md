# AgentsView

AgentsView 是一个面向 **Codex 与 Claude 编码代理**的轻量 Web 运行台：在浏览器里用“星图”查看多个任务的运行状态，在手机上处理待审批请求，并保留可追踪的审批审计记录。

界面提供中文 / English 切换，并针对手机竖屏做了响应式设计。

> English: AgentsView is a mobile-friendly, bilingual web console for monitoring Codex and Claude coding agents and handling narrowly scoped approval requests.

## 运行起来是什么样子

登录后首先看到三个状态星区：

- **运行中**：正在推理、调用工具或执行命令的任务。
- **待审批**：代理已经暂停，等待你允许或拒绝某个具体动作。
- **已完成**：成功、失败、中断和取消的终态任务；具体结果会显示为 outcome，而不会再扩张顶层状态种类。

点击任一星区会进入该状态的任务星图；再点击任务可查看当前步骤、最近事件和审批卡片。状态通过 WebSocket 实时更新。审批卡片只允许提交服务端已经登记的 `允许 / 拒绝` 决策，不提供任意命令拼接或完整远程终端。

默认启用 Demo 模式，因此即使没有配置 Codex 或 Claude，也能看到多任务、等待审批、批准后继续执行和完成归档的完整效果。Demo 与真实代理共用同一套状态、WebSocket、审批和审计链路。

## 快速开始

要求：

- Node.js **22 或更高版本**（建议使用当前 LTS）
- npm
- 可选：PM2、Codex CLI、Anthropic API key、Tailscale 或 Caddy

```bash
git clone https://github.com/zp29/AgentsView.git
cd AgentsView
cp .env.example .env
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:4173`。

若 `.env` 中没有设置 `AGENTSVIEW_ACCESS_TOKEN`，服务会在首次启动时生成强随机令牌并保存到本地数据目录的 `access-token` 文件。该文件已被 Git 忽略；不要把令牌粘到 URL、聊天记录或截图中。

首次启动后，在另一个终端读取令牌并创建一条可安全体验完整流程的 Demo 任务：

```bash
npm run token
npm run task -- --agent demo --title "检查项目" --cwd /absolute/path/to/project --prompt "运行测试并汇总结果"
```

把 `/absolute/path/to/project` 换成已有项目的绝对路径。真实 Codex / Claude 任务使用同一命令，只需在完成下文适配器配置后把 `--agent demo` 改为 `codex` 或 `claude`。

开发模式：

```bash
npm run dev
```

运行测试：

```bash
npm test
```

## 使用 PM2

AgentsView 必须以 **单实例 fork 模式**运行。当前版本的实时序列、审批锁和代理子进程归属都在单一服务进程中；不要改成 cluster 或多实例。

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs agentsview
```

若系统默认 `node` 不是 22 或更高版本，可在启动 PM2 时显式指定解释器；该值需要是 Node 可执行文件的绝对路径：

```bash
AGENTSVIEW_NODE=/absolute/path/to/node pm2 start ecosystem.config.cjs
```

配置修改后：

```bash
pm2 restart agentsview --update-env
```

如需随系统启动，可运行 `pm2 startup`，再按 PM2 打印的命令完成系统服务安装，最后执行 `pm2 save`。

`ecosystem.config.cjs` 已配置 `instances: 1`、`exec_mode: fork` 和 `wait_ready: true`。服务完成监听和恢复状态后才向 PM2 发送 ready 信号；停止时会先停止接收新审批，再关闭 WebSocket 与适配器子进程。

## 手机安全访问

服务默认只监听 `127.0.0.1:4173`，因此局域网和公网都不能直接访问。这是有意的安全默认值。

### 推荐：Tailscale Serve

在电脑和手机登录同一个 tailnet，然后在运行 AgentsView 的电脑执行：

```bash
tailscale serve --bg 4173
```

Tailscale 会把 tailnet 内的 HTTPS 地址反向代理到本机 `127.0.0.1:4173`。使用 `tailscale serve status` 查看地址。建议通过 tailnet ACL 限制可访问的用户或设备；**不要改用 Tailscale Funnel**，后者会把服务公开到互联网。

把 `tailscale serve status` 显示的完整 HTTPS Origin 写入 `.env`，并允许 AgentsView 信任这个受控的本机反向代理。例如：

```dotenv
AGENTSVIEW_PUBLIC_ORIGIN=https://your-machine.your-tailnet.ts.net
AGENTSVIEW_TRUST_PROXY=true
```

Origin 只填写协议与主机名，不带路径或末尾 `/`。修改后重启 AgentsView；PM2 用户执行 `pm2 restart agentsview --update-env`。保持 `AGENTSVIEW_HOST=127.0.0.1`，不要为了手机访问改成 `0.0.0.0`。

官方说明：[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 与 [`tailscale serve` CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

### 备选：Caddy HTTPS

如果已有域名和可信服务器，可让 Caddy 终止 TLS，AgentsView 仍保持仅监听回环地址：

```caddyfile
agents.example.com {
    reverse_proxy 127.0.0.1:4173
}
```

同时配置：

```dotenv
AGENTSVIEW_PUBLIC_ORIGIN=https://agents.example.com
AGENTSVIEW_TRUST_PROXY=true
```

只在代理由你控制时开启 `AGENTSVIEW_TRUST_PROXY`，并使用防火墙、身份访问策略或 VPN 限制入口。Caddy 能代理 WebSocket；域名、DNS 和证书要求见 [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) 与 [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## 接入 Codex

AgentsView 通过本机 `codex app-server` 的 JSONL 协议启动和管理任务，并把线程状态、工具事件、token 使用量和审批请求归一化到统一模型。

默认配置：

```dotenv
CODEX_ENABLED=auto
CODEX_COMMAND=codex
```

`auto` 表示只有在启动时能找到可用 Codex CLI 才启用真实适配器。AgentsView 发起的 Codex 任务可以在 Web 端审批；**另一个终端里已经独立运行的 Codex 会话无法被可靠附加或接管**。这是 app-server 的会话归属边界，不是 UI 限制。

相关协议说明：[Codex app-server](https://developers.openai.com/codex/app-server#protocol)。

## 接入 Claude

### Claude Agent SDK

由 AgentsView 新建的 Claude 任务使用 Agent SDK 的权限回调暂停并等待 Web 决策。需要：

```bash
npm install @anthropic-ai/claude-agent-sdk
```

```dotenv
CLAUDE_ENABLED=auto
ANTHROPIC_API_KEY=your_api_key
```

SDK 是可选依赖；未安装时服务仍可使用 Codex、Demo 与 Claude Hooks。Claude Agent SDK 作为第三方产品接入时需要 Anthropic API 凭据；`claude.ai` 订阅登录不能当作 API key。允许决策会原样返回适配器已经登记的工具输入，浏览器不能改写输入。

### Claude Code CLI Hooks 兼容模式

Hooks 适合给**启动前已经安装好配置**的普通 Claude Code CLI 会话补充状态和 `PermissionRequest` 审批兼容。服务首次启动时会自动生成独立的 `data/claude-hook-secret`；也可以用 `CLAUDE_HOOK_SECRET` 显式覆盖。

启动 AgentsView 后执行：

```bash
npm run hooks:print
```

把输出中的 `hooks` 对象合并到 `~/.claude/settings.json`，然后新开一个 Claude Code 会话。输出包含本机 Hook 密钥，不要提交到 Git 或发到聊天中。AgentsView 不会自动改写你的 Claude 配置。

生成的 HTTP Hook 指向 `POST /api/hooks/claude`，使用独立的 `X-AgentsView-Hook-Secret` 请求头认证，不使用浏览器 Cookie。Hook 超时会比 `AGENTSVIEW_APPROVAL_TTL_MINUTES` 多保留 15 秒，使 AgentsView 有时间先安全拒绝过期审批，再由 Claude Code 结束 HTTP 请求。一次 `Stop` 会归档当前任务；同一 Claude 会话之后提交的新提示会在星图中创建新任务，不会把旧的已完成记录改回运行中。

能力边界：

- Hooks 必须在会话开始前生效，不能接管一个已经显示在终端里的旧审批提示。
- 可以上报部分生命周期 / 工具事件，并在权限 Hook 等待期间传回允许或拒绝。
- 不能重建完整历史，不能可靠注入任意用户消息，也不是远程终端。
- Hook 服务不可用时，Claude Code 应回退到原生终端权限流程，不能把“监控服务离线”变成无条件放行。
- 使用 `--bare` 等跳过 Hooks 的启动方式时不会接入 AgentsView。
- Hook 请求可能包含提示词、工作目录和工具输入；接口应保持在回环地址或受控 HTTPS 反向代理之后。不要把 Hook 密钥放进 URL、网页代码或公开仓库。

参考：[Claude Agent SDK user input & permissions](https://code.claude.com/docs/en/agent-sdk/user-input)、[Claude Code Hooks](https://code.claude.com/docs/en/hooks)。

## 审批安全模型

审批不是“把手机输入转发到 shell”，而是一个受限决策通道：

1. 适配器先把待审批动作登记到服务端，并生成不可猜测的请求标识。
2. UI 只显示经过转义 / 纯文本渲染的摘要，只提交请求标识与 `allow` 或 `deny`。
3. 服务端检查登录会话、请求是否仍待处理、是否过期，以及该请求是否已经被另一设备决策。
4. 服务端先记录“已提交”审计事件，再调用拥有该任务的适配器；投递结果另记一条审计事件。
5. 同一请求重复提交相同决策是幂等的；冲突决策或过期请求会被拒绝。

登录使用主访问令牌换取内存会话，浏览器得到 `HttpOnly`、`SameSite=Strict` Cookie。令牌不保存到 localStorage，不应放在查询参数里。WebSocket 同样校验会话和 Origin。

审计日志只保存必要字段，并对命令、路径和敏感内容做截断或脱敏。它能帮助追溯“谁在何时批准了哪个已登记动作”，但不能替代操作系统权限、Codex 沙箱或 Claude 权限策略。

> 重要边界：AgentsView 与本机 Agent 若以同一个操作系统用户运行，就不是强隔离的安全域。子进程环境会剔除 AgentsView 控制密钥，但同用户进程原则上仍可能读取该用户可访问的文件或调试其他进程。请继续使用 Codex / Claude 自带沙箱与权限策略；高安全场景应把 Agent 放进独立系统用户、容器或虚拟机，并在未来引入独立签名设备 / Passkey，而不能只依赖手机网页按钮。

## 配置

完整示例见 [`.env.example`](./.env.example)。常用项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENTSVIEW_HOST` | `127.0.0.1` | HTTP 监听地址；建议保持回环地址 |
| `AGENTSVIEW_PORT` | `4173` | HTTP / WebSocket 端口 |
| `AGENTSVIEW_PUBLIC_ORIGIN` | 空 | 允许的外部 Origin，可用逗号分隔多个 HTTPS Origin |
| `AGENTSVIEW_DATA_DIR` | `./data` | 快照、访问令牌与审计数据目录 |
| `AGENTSVIEW_ACCESS_TOKEN` | 自动生成 | 首次登录的主访问令牌 |
| `AGENTSVIEW_SESSION_TTL_HOURS` | `24` | 登录会话有效期 |
| `AGENTSVIEW_APPROVAL_TTL_MINUTES` | `10` | 待审批请求有效期 |
| `AGENTSVIEW_DEMO_MODE` | `true` | 是否加载可交互 Demo 任务 |
| `CODEX_ENABLED` | `auto` | Codex 适配器开关 |
| `CLAUDE_ENABLED` | `auto` | Claude 适配器开关 |
| `CLAUDE_HOOK_SECRET` | 自动生成 | Claude CLI HTTP Hooks 的独立共享密钥 |
| `AGENTSVIEW_TRUST_PROXY` | `false` | 是否信任受控反向代理 |

## 当前 API 面

| 方法 / 通道 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/session` | 用访问令牌建立浏览器会话 |
| `DELETE` | `/api/session` | 注销当前会话 |
| `GET` | `/api/bootstrap` | 获取完整状态快照与适配器能力 |
| `POST` | `/api/tasks` | 创建由 AgentsView 管理的新任务 |
| `PUT` | `/api/approvals/:requestId/decision` | 幂等提交允许或拒绝 |
| `POST` | `/api/hooks/claude` | 接收带独立 Hook 密钥的 Claude Code 事件 |
| `GET` | `/health` | 进程健康检查 |
| WebSocket | `/ws` | 推送带序号的状态事件 |

除登录、健康检查与 Claude Hook 外，接口都需要有效浏览器会话。Claude Hook 不接受浏览器会话，必须提供独立共享密钥；它只接收受支持的生命周期和权限事件，不是通用命令入口。当前 MVP 有意不提供通用 shell、任意 stdin 转发、文件浏览器、多人 RBAC 或跨机器分布式调度。

## 项目结构

```text
AgentsView/
├── public/                 # 双语、响应式星图 UI
├── src/                    # HTTP/WS、状态、审计、适配器
├── test/                   # 状态与审批测试
├── docs/architecture.md    # 架构、安全边界和扩展原则
├── ecosystem.config.cjs    # PM2 单实例配置
└── .env.example            # 安全默认配置
```

## 许可证

[MIT](./LICENSE)
