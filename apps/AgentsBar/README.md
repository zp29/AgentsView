# AgentsBar

独立 macOS 菜单栏 App：在状态栏观察 **Claude Code（CC）** 与 **Codex（GPT）** 的真实任务。  
自带本机 Local Hub，**不需要**单独启动仓库里的 Node AgentsView 服务。

产品说明：[docs/menubar-app.md](../../docs/menubar-app.md)  
预编译安装包：[GitHub Releases](https://github.com/zp29/AgentsView/releases)（`AgentsBar-*.dmg`）

## v1 能做什么

| 能力 | 行为 |
| --- | --- |
| 安装即用 | 打开 App 启动 Local Hub（`127.0.0.1:18273`） |
| 首次向导 | 安装 Claude / Codex command hooks；可选登录时启动 |
| 状态栏 | 轨道 logo + 运行中总数；**0 不显示数字** |
| 状态边框 | 运行中：绿色胶囊 + 缓慢旋转虚线；待处理：红橙；刚完成：红闪约 5–6 秒后消失 |
| 面板 | 运行中 / 今日完成；名称模板默认 `{agent}-{cwd}-{title}` |
| 久未活动 | ≥45 分钟无活动：列表橙色框 +「久未活动」标签（**不**自动完成） |
| 手动状态 | 右键：标记完成 / 中断 / 重新运行中 / 打开目录 / 移除 |
| 只观察 | 不拦截 `PermissionRequest`；不做菜单内允许/拒绝 |
| 无 Demo | 仅真实 CLI Hook 产生的会话 |

数据目录：`~/Library/Application Support/AgentsBar/`。

## 要求

- macOS 14+
- 从源码构建需要 [Xcode](https://developer.apple.com/xcode/) 15+（`xcode-select` 指向 Xcode，而不仅是 CLT）

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

## 安装

### 用 Release DMG（推荐）

1. 打开 [Releases](https://github.com/zp29/AgentsView/releases)，下载最新 `AgentsBar-x.y.z.dmg`
2. 将 `AgentsBar.app` 拖到「应用程序」
3. 首次打开若被拦截：系统设置 → 隐私与安全性 → 仍要打开  
   （当前为 **ad-hoc 签名、未 Apple 公证**）

### 从源码

```bash
cd apps/AgentsBar
./scripts/build.sh              # → build/Build/Products/Release/AgentsBar.app
./scripts/build.sh --install    # → ~/Applications/AgentsBar.app 并尝试打开
```

或用 Xcode 打开 `AgentsBar.xcodeproj`，Scheme **AgentsBar**，Run。

## 使用

1. 打开 AgentsBar，完成首次向导（建议开启「登录时启动」并安装 Hooks）。
2. **新开** Claude Code 或 Codex 会话（装 Hook 前已打开的会话不会上报）。
3. 状态栏出现运行中数量与边框动效；点击打开面板查看列表。
4. 设置中可改名称模板、显示项；可重装 / 移除 Hooks。
5. 卡住或已结束但仍显示「运行中」的任务：在列表 **右键** 手动改状态。

默认 Hub：`http://127.0.0.1:18273`（仅 loopback）。

## 卸载 Hooks

设置 →「移除 AgentsBar Hooks」，或删除 App 后手动从 `~/.claude/settings.json` / `~/.codex/hooks.json` 去掉含 `agentsbar-hook` 的 command。

## 本地打 DMG

```bash
cd apps/AgentsBar
VERSION=1.0.2 ./scripts/build.sh
VERSION=1.0.2 ./scripts/package-dmg.sh
# → dist/AgentsBar-1.0.2.dmg
```

## GitHub Release（tag 自动打包）

推送 `v*` tag 后，workflow **Release AgentsBar**（`macos-15`）构建并上传 DMG：

```bash
git tag v1.0.2
git push origin v1.0.2
```

- Workflow：[`.github/workflows/release-agentsbar.yml`](../../.github/workflows/release-agentsbar.yml)
- 产物：Release 附件 `AgentsBar-1.0.2.dmg`（ad-hoc，**未**公证）
- 也可在 Actions 页 **Run workflow** 手动填版本

若 **第一次** 把 workflow 文件和 tag 同一次推送，Actions 可能不触发；可重推 tag 或使用 workflow_dispatch。

## 开发

| 路径 | 内容 |
| --- | --- |
| `AgentsBar/` | Swift 源码（LocalHub、TaskStore、MenuBar UI、设置/向导） |
| `AgentsBar/Assets.xcassets` | Logo / AppIcon |
| `AgentsBar/Resources/agentsbar-hook` | Hook relay 模板（运行时复制到 Application Support） |
| `scripts/build.sh` | Release 构建（`VERSION=` / `--install`） |
| `scripts/package-dmg.sh` | `.app` → DMG |

无第三方 SPM 依赖。Bundle ID：`com.agentsview.bar`。
