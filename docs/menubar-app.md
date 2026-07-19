# AgentsBar — 独立 macOS 菜单栏观察器

AgentsBar 是一个**安装即可用**的 macOS 菜单栏 App：在状态栏观察 Claude Code（**CC**）与 Codex（**GPT**）的真实任务状态。  
代码放在本仓库 [`apps/AgentsBar/`](../apps/AgentsBar/)，**运行时不依赖** Node 版 AgentsView，也不要求用户 `npm start`。

## 产品承诺

| 用户期望 | 实现 |
| --- | --- |
| 安装就能用 | App 内置 Local Hub（本机 HTTP），打开即监听 |
| 不受仓库影响 | 不依赖 AgentsView 目录、npm、PM2 |
| 第一次打开设好 Hook | 首次向导安装 Claude / Codex command hooks |
| 状态栏主界面 | `CC:n GPT:m` + 图标颜色；下拉看任务列表 |
| 只观察 | 不拦截终端权限、菜单内不做允许/拒绝 |
| 无 Demo | 只显示真实 CLI 会话产生的任务 |

## 已拍板决策

- **Q1=A**：不拦截 `PermissionRequest`；权限仍走 Claude Code / Codex 原生流程。状态栏以**运行中 / 已完成**为主；「待审批」UI 可保留但默认多为 0。
- **Q2=A**：固定本机端口 **18273**（`127.0.0.1`），与 AgentsView Web 默认 `4173` 并存、数据互不影响。
- 状态栏默认样式：**方案 B** — 图标颜色 + `CC:n GPT:m`。
- 已完成默认范围：**今日**。
- 技术：**原生 Swift**（MenuBarExtra）。
- 分发：自用 + 开源自行打包；不做公证 / Sparkle。

## 架构

```text
AgentsBar.app
├── MenuBar UI / Settings / Onboarding
└── Local Hub (127.0.0.1:18273)
        ▲
        │ POST /hooks/{claude|codex}  + shared secret
        │
~/Library/Application Support/AgentsBar/bin/agentsbar-hook
        ▲
        │ command hook (stdin JSON)
~/.claude/settings.json  ·  ~/.codex/hooks.json
        ▲
Claude Code CLI / Codex CLI
```

- **Local Hub**：与 UI 同进程；任务状态机；密钥校验；JSON 快照落盘。
- **Hook relay**：安装到 Application Support 的稳定路径（避免 `.app` 移动后路径失效）；读 stdin，POST 到 Hub；失败时打印错误并向 stdout 写 `{}`，**绝不阻断** CLI。
- **PermissionRequest**：立即返回 `{}`（不 `updatedInput` / 不 deny），CLI 使用原生权限 UI。

## 状态模型

与 AgentsView 语义对齐的三态（无 Demo）：

| 状态 | 来源（Hook 事件，简） |
| --- | --- |
| `running` | SessionStart / UserPromptSubmit / 工具事件 |
| `waiting_approval` | 预留；MVP 不因 PermissionRequest 进入此态 |
| `completed` | Stop / StopFailure / SessionEnd |

代理展示名：`claude` → **CC**，`codex` → **GPT**。

任务显示名默认模板：`{agent}-{cwd}-{title}`（设置可改）。

图标颜色优先级：有运行中 → 青；今日仅完成或空闲 → 绿/灰；Hub 异常 → 红。

## 首次启动

1. 创建 `~/Library/Application Support/AgentsBar/`（密钥、状态、relay）。
2. 向导：安装 Claude Hook、安装 Codex Hook、登录时启动（建议默认开）。
3. 提示用户**新开** CLI 会话后才会出现任务（Hook 不能接管已打开会话）。

## 与 AgentsView Web 的关系

| | AgentsView | AgentsBar |
| --- | --- | --- |
| 形态 | Node Web 控制台 | 原生菜单栏 App |
| 端口 | 4173 | 18273 |
| 审批 | 支持 | 不做 |
| 启动 | npm / PM2 | 打开 App / 登录项 |
| 依赖 | 彼此无运行时依赖 | 彼此无运行时依赖 |

## 非目标（MVP）

- 菜单内 allow/deny、创建任务、PTY、文件管理
- 内嵌 Node / 打包整站 AgentsView
- 多机、公网暴露 Hub
- 自动更新与 Apple 公证流程

## 构建

见 [`apps/AgentsBar/README.md`](../apps/AgentsBar/README.md)。
