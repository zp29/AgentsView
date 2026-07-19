import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCookies } from './utils.js';

const COOKIE_NAME = 'agentsview_session';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export class TokenAuth extends EventEmitter {
  constructor({ dataDir, configuredToken, ttlMs, trustProxy }) {
    super();
    this.tokenFile = path.join(dataDir, 'access-token');
    this.configuredToken = configuredToken;
    this.ttlMs = ttlMs;
    this.trustProxy = trustProxy;
    this.sessions = new Map();
    this.token = '';
    this.generated = false;
  }

  async init() {
    const tokenDirectory = path.dirname(this.tokenFile);
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    await chmod(tokenDirectory, 0o700).catch(() => {});
    if (this.configuredToken) {
      this.token = this.configuredToken;
      return;
    }
    try {
      this.token = (await readFile(this.tokenFile, 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.token = crypto.randomBytes(32).toString('base64url');
      await writeFile(this.tokenFile, `${this.token}\n`, { mode: 0o600 });
      this.generated = true;
    }
    await chmod(this.tokenFile, 0o600).catch(() => {});
  }

  verifyToken(candidate) {
    return safeEqual(this.token, candidate);
  }

  createSession(request) {
    this.prune();
    if (this.sessions.size >= 500) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.endSession(oldest.id, 'capacity');
    }
    const id = crypto.randomBytes(32).toString('base64url');
    const session = {
      id,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      actor: `session:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)}`,
      ip: request.socket.remoteAddress || '',
      kind: 'session',
    };
    this.sessions.set(id, session);
    return session;
  }

  cookieFor(request, session) {
    const forwardedProto = this.trustProxy ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const secure = request.socket.encrypted || forwardedProto === 'https';
    return [
      `${COOKIE_NAME}=${encodeURIComponent(session.id)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }

  clearCookie(request) {
    const forwardedProto = this.trustProxy ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const secure = request.socket.encrypted || forwardedProto === 'https';
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  authenticate(request) {
    this.prune();
    const authorization = String(request.headers.authorization || '');
    if (authorization.startsWith('Bearer ') && this.verifyToken(authorization.slice(7))) {
      return { actor: 'master-token', kind: 'bearer' };
    }
    const id = parseCookies(request.headers.cookie || '')[COOKIE_NAME];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (id) this.endSession(id, 'expired');
      return null;
    }
    return session;
  }

  revoke(request) {
    const id = parseCookies(request.headers.cookie || '')[COOKIE_NAME];
    return id ? this.endSession(id, 'revoked') : null;
  }

  isSessionActive(id) {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.endSession(id, 'expired');
      return false;
    }
    return true;
  }

  endSession(id, reason = 'revoked') {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    this.emit('session-ended', { session, reason });
    return session;
  }

  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.endSession(id, 'expired');
    }
  }
}

function httpOrigin(host, port) {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return new URL(`http://${formattedHost}:${port}`).origin;
}

export function buildAllowedOrigins({ host, port, publicOrigins = [] }) {
  const allowed = new Set(publicOrigins.map((value) => String(value).trim()).filter(Boolean));
  const normalizedHost = String(host || '').trim().toLowerCase();
  const loopbackOrWildcard = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '[::]']);
  if (loopbackOrWildcard.has(normalizedHost)) {
    for (const loopback of ['127.0.0.1', 'localhost', '::1']) allowed.add(httpOrigin(loopback, port));
  } else if (normalizedHost) {
    allowed.add(httpOrigin(normalizedHost, port));
  }
  return allowed;
}

export function isAllowedOrigin(request, allowedOrigins, { required = false } = {}) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  if (!origin) return !required;
  return allowedOrigins.has(origin);
}
