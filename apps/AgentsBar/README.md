# AgentsBar

独立 macOS 菜单栏 App：状态栏显示 **CC**（Claude Code）与 **GPT**（Codex）真实任务计数，下拉查看待办分组。  
自带本机 Local Hub，**不需要**单独启动仓库里的 AgentsView 服务。

产品说明：[docs/menubar-app.md](../../docs/menubar-app.md)

## 要求

- macOS 14+
- [Xcode](https://developer.apple.com/xcode/) 15+（命令行构建需 `xcode-select` 指向 Xcode，而不仅是 CLT）

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

## 构建与安装（自用）

```bash
cd apps/AgentsBar
./scripts/build.sh
# 产物：build/Build/Products/Release/AgentsBar.app
# 可选安装到 ~/Applications：
./scripts/build.sh --install
```

或用 Xcode 打开 `AgentsBar.xcodeproj`，Scheme **AgentsBar**，Run。

首次运行若被 Gatekeeper 拦截：系统设置 → 隐私与安全性 → 仍要打开（自签本地构建常见情况）。

## 使用

1. 打开 AgentsBar（建议在向导中开启「登录时启动」）。
2. 按向导安装 Claude / Codex Hooks（可稍后在设置里重装）。
3. **新开**一个 Claude Code 或 Codex 会话；菜单栏显示运行中任务总数。
4. 点菜单栏打开面板查看任务列表；设置里可改名称模板与显示项。

默认 Hub：`http://127.0.0.1:18273`（仅 loopback）。

## 卸载 Hooks

设置 →「移除 AgentsBar Hooks」，或删除 App 后手动从 `~/.claude/settings.json` / `~/.codex/hooks.json` 去掉 `agentsbar-hook` 相关 command。

数据目录：`~/Library/Application Support/AgentsBar/`。


## 打 DMG（本地）

```bash
cd apps/AgentsBar
VERSION=0.1.0 ./scripts/build.sh
VERSION=0.1.0 ./scripts/package-dmg.sh
# 产物：dist/AgentsBar-0.1.0.dmg
```

## GitHub Release（tag 自动打包）

推送符合 `v*` 的 tag 后，Actions workflow **Release AgentsBar** 会在 `macos-15` 上构建并上传 DMG：

```bash
git tag v0.1.0
git push origin v0.1.0
```

- Workflow：`.github/workflows/release-agentsbar.yml`
- 产物：Release 附件 `AgentsBar-0.1.0.dmg`（ad-hoc 签名，**未** Apple 公证）
- 也可在 Actions 页手动 **Run workflow** 并填写 version

仓库需允许 Actions 写权限（Settings → Actions → General → Workflow permissions → Read and write），或依赖 workflow 内的 `permissions: contents: write`。

## 开发

| 路径 | 内容 |
| --- | --- |
| `AgentsBar/` | Swift 源码 |
| `AgentsBar/Resources/agentsbar-hook` | Hook relay 脚本模板（运行时复制到 Application Support） |
| `scripts/build.sh` | Release 构建（支持 `VERSION=`） |
| `scripts/package-dmg.sh` | 将 `.app` 打成 DMG |

无第三方 SPM 依赖。
