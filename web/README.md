# AgentsView (web)

Node.js 星图控制台：HTTP API、WebSocket、审批与静态 UI。

本目录是可独立运行的 npm 包。仓库根目录的 `package.json` 仅把脚本转发到这里。

```bash
cp .env.example .env
npm run build
npm start          # http://127.0.0.1:4173
npm test
npm run check
```

产品说明见仓库根 [README.md](../README.md)，架构见 [docs/architecture.md](../docs/architecture.md)。

macOS 菜单栏观察器在 [`apps/AgentsBar/`](../apps/AgentsBar/)，**不依赖**本服务。
