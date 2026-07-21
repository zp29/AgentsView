# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Monorepo with two **independent** products that share docs and branding only (no shared runtime):

| Path | Product |
| --- | --- |
| [`web/`](web/) | **AgentsView** — single-process Node.js constellation console for Codex / Claude: live task state + narrowly scoped allow/deny approvals. Default `127.0.0.1:4173`. |
| [`apps/AgentsBar/`](apps/AgentsBar/) | **AgentsBar** — standalone macOS menu bar observer (Swift). Own Local Hub on `127.0.0.1:18273`. Does **not** need `npm start` or the web process. |
| [`docs/`](docs/) | Architecture and product decisions |

Root [`package.json`](package.json) only forwards npm scripts into `web/` (`npm run dev` ≡ `npm --prefix web run dev`). Prefer `cd web` for Node work.

**Web product boundary:** read-only state stream + restricted allow/deny decision channel. Do not add generic shell, arbitrary stdin, file browsers, multi-instance scheduling, or broad remote control without revisiting [docs/architecture.md](docs/architecture.md).

**AgentsBar product boundary:** observation only — never intercept CLI `PermissionRequest`; no in-app allow/deny. Product decisions: [docs/menubar-app.md](docs/menubar-app.md).

No Cursor rules or GitHub Copilot instruction files in this repo.

---

## Commands (web)

Requires Node.js **≥ 22** ([`web/.nvmrc`](web/.nvmrc)). ESM only (`"type": "module"`). Zero runtime npm dependencies; `@anthropic-ai/claude-agent-sdk` is an optional dynamic import for Claude SDK tasks.

```bash
# From repo root (wrappers) or: cd web && …
npm run dev            # node --watch src/server.js
npm run build          # copy src/ → dist/ (no bundler/transpiler)
npm start              # node dist/server.js
npm run start:source   # node src/server.js (no build)
npm test               # node --test --test-reporter=spec (all web/test/*.test.js)
npm run check          # syntax-check web src/, scripts/, ecosystem.config.cjs

# Single test file / name filter (must run from web/)
cd web
node --test test/approval-service.test.js
node --test --test-name-pattern="idempotent" test/approval-service.test.js

# Ops helpers (need a running server + secrets from first start under web/data/)
npm run token
npm run task -- --agent demo --title "…" --cwd /abs/path --prompt "…"
npm run hooks:print          # print Claude HTTP hooks config (does not write ~/.claude)
npm run hooks:install        # merge command hooks for claude and/or --claude / --codex
```

Config: `web/.env` (template [`web/.env.example`](web/.env.example)), loaded by [web/src/config.js](web/src/config.js). Runtime secrets/snapshots: `AGENTSVIEW_DATA_DIR` (default `web/data`, gitignored).

PM2 must stay **single-instance fork** ([`web/ecosystem.config.cjs`](web/ecosystem.config.cjs): `instances: 1`, `exec_mode: 'fork'`, `wait_ready: true`). Cluster/multi-instance breaks sequence numbers, in-process approval locks, and adapter child ownership.

```bash
cd web && npm run build && pm2 start ecosystem.config.cjs
# or from root: pm2 start web/ecosystem.config.cjs
```

---

## Architecture (web)

One Node process owns HTTP API, static UI, WebSocket hub, state store, approval locks, audit, and adapter lifecycles.

```
Browser ──HTTP/session──► server.js ──► StateStore (authority)
   ▲                         │              │
   └──────── /ws ◄── WebSocketHub           │
                             │              ▼
                        ApprovalService ── AdapterManager
                             │              ├── DemoAdapter
                             ▼              ├── CodexAdapter (codex app-server stdio JSONL)
                          AuditLog          ├── ClaudeSdkAdapter (optional SDK)
                                            ├── ClaudeHookBridge
                                            └── CodexHookBridge
```

| Module | Role |
| --- | --- |
| [web/src/server.js](web/src/server.js) | HTTP routes, Origin checks, session auth, bootstrap, task create, approval PUT, hook POST, graceful shutdown + PM2 ready |
| [web/src/state-store.js](web/src/state-store.js) | Authoritative tasks/approvals maps; disk snapshot; status derivation; decision begin/rollback; recovery marks non-completed work as interrupted |
| [web/src/adapter-manager.js](web/src/adapter-manager.js) | Serializes adapter events into store mutations; capabilities; approval expiry timers; launch + decide routing |
| [web/src/approval-service.js](web/src/approval-service.js) | Per-requestId in-process lock; audit-before-deliver; idempotent same decision; 409 conflict / 410 stale |
| [web/src/websocket.js](web/src/websocket.js) | Hand-rolled WS hub (no `ws` package): handshake, heartbeat, session close, backpressure limits |
| [web/src/auth.js](web/src/auth.js) | Access token → in-memory session cookie (`HttpOnly`, `SameSite=Strict`); allowed Origins |
| [web/src/audit.js](web/src/audit.js) | Daily JSONL under `data/audit/` with recursive redaction |
| [web/public/index.html](web/public/index.html) | Entire UI (no frontend build): login, constellation, detail, approvals over bootstrap + WS |

### Unified state model

Only three task statuses: `running` | `waiting_approval` | `completed`. Failure/cancel/interrupt are `outcome` under `completed`, not extra top-level states. Tasks and approvals are separate entities (one task can have multiple pending approvals). Normalization (store + adapter-manager):

- Terminal tasks are never reopened by late running events.
- Duplicate provider events must not recreate resolved approvals.
- `waiting_approval` only while at least one approval is pending.

WebSocket envelope: `{ version, serverId, sequence, type, at, payload }`. Clients re-bootstrap on sequence gap, `serverId` change, or reconnect (`GET /api/bootstrap`).

### Adapters and ownership

AgentsView only fully controls tasks **it launched** (or CLI sessions that installed Hooks **before** start). Independent terminal sessions cannot be attached.

- **Codex**: owns a `codex app-server` child over stdio JSONL; must honor sandbox/approvalPolicy (never force danger-full-access / never-approve).
- **Claude SDK**: optional package + `ANTHROPIC_API_KEY`; `canUseTool` waits on server decision; allow returns the **original** tool input (browser cannot rewrite it).
- **Hooks**: `POST /api/hooks/{claude|codex}` with `X-AgentsView-Hook-Secret` (not browser cookies). Fail closed when AgentsView is down ([`web/scripts/agent-hook.js`](web/scripts/agent-hook.js) returns `{}` on error). `hooks:print` never auto-edits `~/.claude/settings.json`; `hooks:install` merges command hooks and must not embed the secret in config.

Adapter events are queued serially in `AdapterManager.enqueueEvent` so store updates stay ordered.

### API surface (MVP — expand only if it fits the boundary)

| Method | Path |
| --- | --- |
| POST/DELETE | `/api/session` |
| GET | `/api/bootstrap` |
| POST | `/api/tasks` |
| PUT | `/api/approvals/:requestId/decision` |
| POST | `/api/hooks/claude`, `/api/hooks/codex` |
| GET | `/health` |
| WS | `/ws` |

Approvals: UI submits only `{ decision: "allow" \| "deny" }` for a server-registered requestId. Command/tool payload comes from server state.

### Security defaults to preserve

- Listen on loopback; phone access via Tailscale Serve or controlled reverse proxy + `AGENTSVIEW_PUBLIC_ORIGIN` + `AGENTSVIEW_TRUST_PROXY=true` — not by binding `0.0.0.0` or public Funnel.
- Never put access token / hook secret in URLs, localStorage, WS query params, or logs.
- Strip AgentsView control secrets from agent child env (`agentEnvironment` in [web/src/utils.js](web/src/utils.js)).
- UI must render agent output as plain text (no unsanitized HTML).

Deeper design, non-goals, extension thresholds: [docs/architecture.md](docs/architecture.md). Product usage: [README.md](README.md), [web/README.md](web/README.md).

### Tests (web)

Node built-in test runner only (`web/test/*.test.js`). Coverage focuses on store normalization, approval idempotency/locks/expiry, auth/Origin, WS hub, Codex approval response contracts, Claude/Codex hook bridges, and secret stripping. Prefer adding tests next to these boundaries when changing approval, state, or adapter protocol handling.

---

## AgentsBar (macOS menu bar)

SwiftUI `MenuBarExtra` app (`com.agentsview.bar`, macOS 14+). In-process **Local Hub** (`NWListener`, loopback only, port **18273**) receives CLI hooks; UI is observation-only.

```text
MenuBar UI / Settings / Onboarding
        │
   Local Hub 127.0.0.1:18273
        ▲  POST /hooks/{claude|codex} + shared secret
agentsbar-hook (Application Support)
        ▲  command hooks (stdin JSON → stdout `{}` on failure)
Claude Code / Codex CLI
```

Key modules under [`apps/AgentsBar/AgentsBar/`](apps/AgentsBar/AgentsBar/): `LocalHub`, `TaskStore`, `AppModel`, `HookInstaller`, `MenuBarContentView`, `OnboardingView`, `SettingsView`. Hardened Runtime needs `network.server` + `network.client` entitlements or the hub will not bind.

Status bar: app logo + **aggregate running count** (not `CC:n GPT:m`). Panel lists tasks with CC/GPT badges; completed window defaults to **today**. No demo tasks; synthetic/test session ids are purged. Task name template default `{agent}-{cwd}-{title}`.

Data: `~/Library/Application Support/AgentsBar/`. Hooks install into `~/.claude/settings.json` / `~/.codex/hooks.json` via relay at a stable Application Support path (not inside the `.app` bundle).

### Commands (AgentsBar)

```bash
cd apps/AgentsBar
./scripts/build.sh              # Release .app (ad-hoc sign)
./scripts/build.sh --install    # → ~/Applications/AgentsBar.app
VERSION=1.0.0 ./scripts/build.sh
VERSION=1.0.0 ./scripts/package-dmg.sh   # → dist/AgentsBar-1.0.0.dmg
```

Requires full Xcode (not only CLT): `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

### Release (path A — ad-hoc, no notarization)

Push tag `v*` → [`.github/workflows/release-agentsbar.yml`](.github/workflows/release-agentsbar.yml) on `macos-15` builds DMG and attaches it to the GitHub Release (`contents: write`). No Apple certificate secrets.

If a tag is pushed in the **same** push that first adds the workflow file, Actions may not run; re-push the tag (`git push origin :refs/tags/vX.Y.Z && git push origin vX.Y.Z`) or use workflow_dispatch.

Gatekeeper: users may need System Settings → Privacy & Security → Open Anyway.
