# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentsView is a single-process Node.js console for monitoring Codex / Claude coding agents and handling narrowly scoped approval requests. Browser UI is a bilingual (zh/en), mobile-friendly constellation view in one static file. Default listen address is `127.0.0.1:4173`.

Core product boundary: **read-only state stream + restricted allow/deny decision channel**. Do not add generic shell, arbitrary stdin, file browsers, multi-instance scheduling, or broad remote control without revisiting the security model in [docs/architecture.md](docs/architecture.md).

## Repository layout

| Path | Role |
| --- | --- |
| [`web/`](web/) | Node.js AgentsView console (HTTP/WS + constellation UI) |
| [`apps/AgentsBar/`](apps/AgentsBar/) | Standalone macOS menu bar observer (Swift; own Local Hub) |
| [`docs/`](docs/) | Architecture and product docs |

Root `package.json` only forwards npm scripts into `web/` (`npm run dev` ≡ `npm --prefix web run dev`). Prefer working inside `web/` for Node work.

## Commands (web console)

Requires Node.js **≥ 22** (see [`web/.nvmrc`](web/.nvmrc)). ESM only (`"type": "module"`). Zero runtime npm dependencies; `@anthropic-ai/claude-agent-sdk` is an optional dynamic import for Claude SDK tasks.

```bash
# From repo root (wrappers) or: cd web && …
npm run dev            # node --watch src/server.js
npm run build          # copy src/ → dist/ (no bundler/transpiler)
npm start              # node dist/server.js
npm run start:source   # node src/server.js (no build)
npm test               # node --test --test-reporter=spec (all web/test/*.test.js)
npm run check          # syntax-check web src/, scripts/, ecosystem.config.cjs

# Single test file / name filter (run from web/)
cd web
node --test test/approval-service.test.js
node --test --test-name-pattern="idempotent" test/approval-service.test.js

# Ops helpers (need a running server + data dir secrets from first start)
npm run token
npm run task -- --agent demo --title "…" --cwd /abs/path --prompt "…"
npm run hooks:print          # print Claude HTTP hooks config (does not write ~/.claude)
npm run hooks:install        # install command hooks for claude and/or --claude / --codex
```

PM2 must stay **single-instance fork** ([`web/ecosystem.config.cjs`](web/ecosystem.config.cjs): `instances: 1`, `exec_mode: 'fork'`, `wait_ready: true`). Cluster/multi-instance breaks sequence numbers, in-process approval locks, and adapter child ownership. Start with `pm2 start web/ecosystem.config.cjs` (or `cd web && pm2 start ecosystem.config.cjs`).

Config is env-driven via `web/.env` (loaded by [web/src/config.js](web/src/config.js)); template is [`web/.env.example`](web/.env.example). Runtime secrets and snapshots live under `AGENTSVIEW_DATA_DIR` (default `web/data`, gitignored).

## Architecture

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
| [web/src/websocket.js](web/src/websocket.js) | Hand-rolled WS hub (no ws package): handshake, heartbeat, session close, backpressure limits |
| [web/src/auth.js](web/src/auth.js) | Access token → in-memory session cookie (`HttpOnly`, `SameSite=Strict`); allowed Origins |
| [web/src/audit.js](web/src/audit.js) | Daily JSONL under `data/audit/` with recursive redaction |
| [web/public/index.html](web/public/index.html) | Entire UI (no frontend build): login, constellation, detail, approvals over bootstrap + WS |

### Unified state model

Only three task statuses: `running` | `waiting_approval` | `completed`. Failure/cancel/interrupt are `outcome` under `completed`, not extra top-level states. Tasks and approvals are separate entities (one task can have multiple pending approvals). Normalization rules live in the store + adapter-manager:

- Terminal tasks are never reopened by late running events.
- Duplicate provider events must not recreate resolved approvals.
- `waiting_approval` only while at least one approval is pending.

WebSocket envelope: `{ version, serverId, sequence, type, at, payload }`. Clients re-bootstrap on sequence gap, `serverId` change, or reconnect (`GET /api/bootstrap`).

### Adapters and ownership

AgentsView only fully controls tasks **it launched** (or CLI sessions that installed Hooks **before** start). Independent terminal sessions cannot be attached.

- **Codex**: owns a `codex app-server` child over stdio JSONL; must honor sandbox/approvalPolicy (never force danger-full-access / never-approve).
- **Claude SDK**: optional package + `ANTHROPIC_API_KEY`; `canUseTool` waits on server decision; allow returns the **original** tool input (browser cannot rewrite it).
- **Hooks**: compatibility layer via `POST /api/hooks/{claude|codex}` with `X-AgentsView-Hook-Secret` (not browser cookies). Fail closed to provider-native permissions when AgentsView is down ([`web/scripts/agent-hook.js`](web/scripts/agent-hook.js) returns `{}` on error). `hooks:print` never auto-edits `~/.claude/settings.json`; `hooks:install` merges command hooks and must not embed the secret in config.

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

Deeper design, non-goals, and extension thresholds: [docs/architecture.md](docs/architecture.md). Product usage and deployment: [README.md](README.md).

## Tests

Node built-in test runner only. Coverage focuses on store normalization, approval idempotency/locks/expiry, auth/Origin, WS hub, Codex approval response contracts, Claude/Codex hook bridges, and secret stripping. Prefer adding tests next to these boundaries when changing approval, state, or adapter protocol handling.

## AgentsBar (macOS menu bar)

Standalone observation app under [`apps/AgentsBar/`](apps/AgentsBar/). Ships its own loopback Local Hub (`127.0.0.1:18273`); does **not** require the Node AgentsView process. Product decisions and architecture: [`docs/menubar-app.md`](docs/menubar-app.md). Build with Xcode: `cd apps/AgentsBar && ./scripts/build.sh`.

Release (path A — ad-hoc sign, no Apple notarization): push tag `v*` → [`.github/workflows/release-agentsbar.yml`](.github/workflows/release-agentsbar.yml) builds DMG on `macos-15` and attaches it to the GitHub Release. Local: `VERSION=0.1.0 ./scripts/build.sh && VERSION=0.1.0 ./scripts/package-dmg.sh`.

