import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAllowedOrigins, isAllowedOrigin, TokenAuth } from '../src/auth.js';

test('generates a persistent private token and exchanges it for an in-memory session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentsview-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new TokenAuth({ dataDir: directory, configuredToken: '', ttlMs: 60_000, trustProxy: false });
  await auth.init();
  const token = (await readFile(path.join(directory, 'access-token'), 'utf8')).trim();
  assert.equal(auth.verifyToken(token), true);
  assert.equal(auth.verifyToken(`${token}x`), false);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'access-token'))).mode & 0o777, 0o600);

  const request = { socket: { remoteAddress: '127.0.0.1', encrypted: false }, headers: {} };
  const session = auth.createSession(request);
  request.headers.cookie = auth.cookieFor(request, session).split(';')[0];
  assert.equal(auth.authenticate(request).actor, session.actor);
  auth.revoke(request);
  assert.equal(auth.authenticate(request), null);
});

test('allows only configured origins and requires an Origin for WebSockets', () => {
  const allowed = buildAllowedOrigins({
    host: '127.0.0.1',
    port: 4173,
    publicOrigins: ['https://agents.example'],
  });

  assert.equal(isAllowedOrigin({ headers: { origin: 'http://127.0.0.1:4173' } }, allowed), true);
  assert.equal(isAllowedOrigin({ headers: { origin: 'http://localhost:4173' } }, allowed), true);
  assert.equal(isAllowedOrigin({ headers: { origin: 'https://agents.example' } }, allowed), true);
  assert.equal(isAllowedOrigin({ headers: { host: 'attacker.example', origin: 'http://attacker.example' } }, allowed), false);
  assert.equal(isAllowedOrigin({ headers: {} }, allowed), true);
  assert.equal(isAllowedOrigin({ headers: {} }, allowed, { required: true }), false);
});

test('emits session termination events for revocation and expiry', () => {
  const auth = new TokenAuth({ dataDir: os.tmpdir(), configuredToken: 'test', ttlMs: 60_000, trustProxy: false });
  const request = { socket: { remoteAddress: '127.0.0.1', encrypted: false }, headers: {} };
  const ended = [];
  auth.on('session-ended', (event) => ended.push(event));

  const revoked = auth.createSession(request);
  request.headers.cookie = `agentsview_session=${revoked.id}`;
  assert.equal(auth.revoke(request).id, revoked.id);
  assert.equal(ended[0].reason, 'revoked');

  const expired = auth.createSession(request);
  expired.expiresAt = Date.now() - 1;
  assert.equal(auth.isSessionActive(expired.id), false);
  assert.equal(ended[1].session.id, expired.id);
  assert.equal(ended[1].reason, 'expired');
});
