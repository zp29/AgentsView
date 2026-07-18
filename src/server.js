import crypto from 'node:crypto';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AdapterManager } from './adapter-manager.js';
import { ApprovalService } from './approval-service.js';
import { AuditLog } from './audit.js';
import { buildAllowedOrigins, TokenAuth, isAllowedOrigin } from './auth.js';
import { config } from './config.js';
import { StateStore } from './state-store.js';
import { WebSocketHub } from './websocket.js';
import { boundedText, errorJson, isoNow, json, readJsonBody } from './utils.js';
import { persistentSecret } from './secrets.js';

const startedAt = Date.now();
const serverId = crypto.randomUUID();
let sequence = 0;
let shuttingDown = false;
const allowedOrigins = buildAllowedOrigins({
  host: config.host,
  port: config.port,
  publicOrigins: config.publicOrigins,
});

const store = new StateStore(config.dataDir);
const audit = new AuditLog(config.dataDir);
const auth = new TokenAuth({
  dataDir: config.dataDir,
  configuredToken: config.accessToken,
  ttlMs: config.sessionTtlMs,
  trustProxy: config.trustProxy,
});
const sockets = new WebSocketHub();
let adapters;
let approvalService;
let runtimeConfig = config;
const loginAttempts = new Map();

auth.on('session-ended', ({ session, reason }) => {
  sockets.closeSession(
    session.id,
    4001,
    reason === 'expired' ? 'Session expired' : 'Session ended',
  );
});

function capabilities() {
  return adapters?.capabilities() || {
    demo: config.demoMode,
    codex: false,
    claude: false,
    claudeHooks: Boolean(config.claudeHookSecret),
  };
}

function snapshot() {
  return {
    serverId,
    sequence,
    ...store.snapshot(capabilities()),
    now: isoNow(),
  };
}

function publish(type = 'state.changed') {
  sequence += 1;
  const state = store.snapshot(capabilities());
  sockets.broadcast({ version: 1, serverId, sequence, type, at: isoNow(), payload: state });
}

store.on('changed', () => publish('state.changed'));

function securityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('content-security-policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
  ].join('; '));
}

function requireOrigin(request, response) {
  if (isAllowedOrigin(request, allowedOrigins)) return true;
  errorJson(response, 403, 'origin_not_allowed', 'The request Origin is not allowed.');
  return false;
}

function requireAuth(request, response) {
  const session = auth.authenticate(request);
  if (session) return session;
  errorJson(response, 401, 'authentication_required', 'Sign in with the AgentsView access token.');
  return null;
}

async function serveIndex(response) {
  try {
    const body = await readFile(path.join(config.publicDir, 'index.html'));
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    errorJson(response, 500, 'ui_unavailable', `Could not load the web UI: ${error.message}`);
  }
}

async function handleSession(request, response) {
  if (!requireOrigin(request, response)) return;
  if (request.method === 'POST') {
    const address = clientAddress(request);
    const attempt = loginAttempts.get(address);
    if (attempt?.blockedUntil > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
      return errorJson(response, 429, 'login_rate_limited', `Too many failed attempts. Try again in ${retryAfter} seconds.`);
    }
    const body = await readJsonBody(request);
    if (!auth.verifyToken(body.token)) {
      recordLoginFailure(address);
      await audit.write('session.login_failed', { ip: address });
      errorJson(response, 401, 'invalid_token', 'The access token is not valid.');
      return;
    }
    loginAttempts.delete(address);
    const session = auth.createSession(request);
    await audit.write('session.created', { actor: session.actor, ip: session.ip });
    response.writeHead(204, { 'set-cookie': auth.cookieFor(request, session), 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'DELETE') {
    const session = auth.authenticate(request);
    auth.revoke(request);
    await audit.write('session.revoked', { actor: session?.actor || 'unknown' });
    response.writeHead(204, { 'set-cookie': auth.clearCookie(request), 'cache-control': 'no-store' });
    response.end();
    return;
  }
  response.writeHead(405, { allow: 'POST, DELETE' });
  response.end();
}

function clientAddress(request) {
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}

function recordLoginFailure(address) {
  const now = Date.now();
  const current = loginAttempts.get(address);
  const recent = current && now - current.lastAttempt < 10 * 60 * 1000 ? current.count : 0;
  const count = recent + 1;
  const blockedUntil = count >= 5 ? now + Math.min(5 * 60_000, 30_000 * 2 ** Math.min(3, count - 5)) : 0;
  loginAttempts.set(address, { count, lastAttempt: now, blockedUntil });
  if (loginAttempts.size > 1_000) {
    for (const [key, value] of loginAttempts) {
      if (now - value.lastAttempt > 10 * 60 * 1000) loginAttempts.delete(key);
    }
  }
}

async function handleCreateTask(request, response, session) {
  const body = await readJsonBody(request);
  const agent = boundedText(body.agent, 20).toLowerCase();
  const title = boundedText(body.title, 160);
  const prompt = boundedText(body.prompt, 20_000);
  const cwd = path.resolve(boundedText(body.cwd, 1000, config.projectRoot));
  if (!['demo', 'codex', 'claude'].includes(agent)) return errorJson(response, 400, 'invalid_agent', 'Agent must be demo, codex, or claude.');
  if (!title || !prompt) return errorJson(response, 400, 'invalid_task', 'Task title and prompt are required.');
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
  } catch {
    return errorJson(response, 400, 'invalid_cwd', 'Task cwd must be an existing directory.');
  }
  const task = await adapters.launch({ agent, title, prompt, cwd, actor: session.actor });
  json(response, 202, { task });
}

function hookAuthenticated(request) {
  if (!runtimeConfig.claudeHookSecret) return false;
  const provided = String(request.headers['x-agentsview-hook-secret'] || '');
  const authorization = String(request.headers.authorization || '');
  const candidate = provided || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  const left = Buffer.from(runtimeConfig.claudeHookSecret);
  const right = Buffer.from(candidate);
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function handleClaudeHook(request, response) {
  if (!runtimeConfig.claudeHookSecret) return errorJson(response, 503, 'hooks_disabled', 'Claude Hooks are not configured.');
  if (!hookAuthenticated(request)) return errorJson(response, 401, 'invalid_hook_secret', 'Claude Hook authentication failed.');
  const input = await readJsonBody(request, 256 * 1024);
  const result = await adapters.handleClaudeHook(input);
  json(response, 200, result);
}

async function route(request, response) {
  securityHeaders(response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      version: config.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      capabilities: capabilities(),
    });
  }
  if (shuttingDown) return errorJson(response, 503, 'server_shutting_down', 'The server is shutting down.');
  if (url.pathname === '/api/session') return handleSession(request, response);
  if (request.method === 'POST' && url.pathname === '/api/hooks/claude') return handleClaudeHook(request, response);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(response);
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    return response.end();
  }
  if (!url.pathname.startsWith('/api/')) return errorJson(response, 404, 'not_found', 'Route not found.');
  if (!requireOrigin(request, response)) return;
  const session = requireAuth(request, response);
  if (!session) return;

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') return json(response, 200, snapshot());
  if (request.method === 'POST' && url.pathname === '/api/tasks') return handleCreateTask(request, response, session);
  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (request.method === 'PUT' && approvalMatch) {
    const body = await readJsonBody(request);
    const result = await approvalService.decide(decodeURIComponent(approvalMatch[1]), body.decision, session.actor);
    return json(response, 200, result);
  }
  return errorJson(response, 404, 'not_found', 'API route not found.');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('[AgentsView] Request failed:', error);
    errorJson(response, status, error.code || 'internal_error', status >= 500 ? 'The request could not be completed.' : error.message);
  });
});

server.requestTimeout = Math.max(650_000, config.approvalTtlMs + 30_000);
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  if (shuttingDown) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  if (!isAllowedOrigin(request, allowedOrigins, { required: true })) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const identity = auth.authenticate(request);
  if (!identity) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const sessionId = identity.kind === 'session' ? identity.id : null;
  const client = sockets.accept(request, socket, head, {
    sessionId,
    isAuthorized: sessionId ? () => auth.isSessionActive(sessionId) : () => true,
  });
  if (!client) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  client.send({ version: 1, serverId, sequence, type: 'hello', at: isoNow(), payload: store.snapshot(capabilities()) });
});

await store.init();
await audit.init();
await auth.init();
runtimeConfig = {
  ...config,
  claudeHookSecret: await persistentSecret(config.dataDir, 'claude-hook-secret', config.claudeHookSecret),
};
adapters = new AdapterManager({ store, config: runtimeConfig, audit, onCapabilitiesChanged: () => publish('state.changed') });
approvalService = new ApprovalService({ store, adapters, audit });
await adapters.start();

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, resolve);
});

console.log(`[AgentsView] Web console: http://${config.host}:${config.port}`);
console.log(`[AgentsView] Access token file: ${auth.tokenFile}`);
console.log(`[AgentsView] Claude Hook secret file: ${path.join(config.dataDir, 'claude-hook-secret')}`);
if (auth.generated) console.log('[AgentsView] A new access token was generated. Run `npm run token` to display it.');
if (process.send) process.send('ready');

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[AgentsView] ${signal} received; shutting down.`);
  const httpClosed = new Promise((resolve) => {
    server.close((error) => {
      if (error) console.error('[AgentsView] HTTP server close failed:', error);
      resolve();
    });
  });
  sockets.closeAll();
  await settleWithin(adapters?.stop(), 5_000, 'adapter shutdown');
  const closedGracefully = await settleWithin(httpClosed, 1_500, 'HTTP connection drain');
  if (!closedGracefully) {
    server.closeAllConnections?.();
    await settleWithin(httpClosed, 500, 'forced HTTP shutdown');
  }
  await settleWithin(audit.write('server.stopped', { signal }), 500, 'shutdown audit');
  process.exit(0);
}

async function settleWithin(promise, timeoutMs, label) {
  if (!promise) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const settled = Promise.resolve(promise).then(
      () => true,
      (error) => {
        console.error(`[AgentsView] ${label} failed:`, error);
        return true;
      },
    );
    const completed = await Promise.race([settled, timeout]);
    if (!completed) console.error(`[AgentsView] ${label} timed out after ${timeoutMs}ms.`);
    return completed;
  } finally {
    clearTimeout(timer);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[AgentsView] Uncaught exception:', error);
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  console.error('[AgentsView] Unhandled rejection:', error);
});
